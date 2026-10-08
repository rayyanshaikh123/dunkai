import { Readable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

/** Headers for every call to the Python supervisor. */
const supervisorHeaders = (extra = {}) => ({
  ...extra,
  ...(env.supervisorHfToken
    ? { authorization: `Bearer ${env.supervisorHfToken}`, 'x-supervisor-token': env.supervisorToken }
    : env.supervisorToken ? { authorization: `Bearer ${env.supervisorToken}` } : {}),
});

const supervisorBase = /^https?:\/\//i.test(env.supervisorUrl) ? env.supervisorUrl : `http://${env.supervisorUrl}`;
const supervisorUrl = (suffix = '') => new URL(`${env.supervisorPath}${suffix}`, supervisorBase);

// In-memory store for AI job status (replace with Redis in production)
const jobStore = new Map();

export const setJobStatus = (jobId, status, data = {}) => {
  jobStore.set(jobId, { ...jobStore.get(jobId), jobId, status, ...data, updatedAt: new Date() });
  // Auto-cleanup after 1 hour
  setTimeout(() => jobStore.delete(jobId), 60 * 60 * 1000).unref();
};

export const getJobStatus = (jobId) => jobStore.get(jobId);

export const deleteJobStatus = (jobId) => {
  const job = jobStore.get(jobId);
  if (job && job.controller) {
    job.controller.abort();
  }
  jobStore.delete(jobId);
  return job;
};

/**
 * The request body sent to the Python supervisor, in one place.
 *
 * Both callers used to inline `JSON.stringify({ action, project, messages,
 * files, jobId })`, which silently discarded anything not in that list —
 * `agentType` was being passed in by the controller and dropped here for every
 * chat request, even though SupervisorRequest declares it and _handle_chat
 * depends on it. Optional fields are omitted rather than sent as null so the
 * Pydantic defaults on the other side still apply.
 *
 * `credentials` are the user's own decrypted provider keys (BYOK). They go to
 * the supervisor and nowhere else: never into jobStore, a log line, or a
 * socket event.
 *
 * @param {object} fields - action, project, messages, files, jobId, agentType, provider, model, credentials
 * @returns {object} body for the supervisor, optional keys omitted when unset
 */
const buildSupervisorBody = ({
  action,
  project,
  messages,
  files,
  jobId,
  agentType,
  provider,
  model,
  credentials,
}) => ({
  action,
  project,
  messages,
  files,
  jobId,
  ...(agentType ? { agentType } : {}),
  ...(provider ? { provider } : {}),
  ...(model ? { model } : {}),
  ...(credentials && Object.keys(credentials).length ? { credentials } : {}),
});

/**
 * Remove the safety classifier's audit record from a supervisor result.
 *
 * The supervisor sends the full record (category, reasoning, conversation) as
 * `safety_audit` so it can be stored; the requester may see only the verdict
 * (`safety`). This must run before a result is returned to the client, emitted
 * on a socket, or saved anywhere a client can read it back. It looks at the top
 * level and one level down, because chat replies and SSE events wrap the state
 * in `data`. Mutates `result`; returns the record, or null.
 *
 * @param {object} result - a supervisor response, or the payload of an SSE event
 * @returns {object|null} the audit record, if there was one
 */
export const takeSafetyAudit = (result) => {
  let audit = null;
  for (const holder of [result, result?.data]) {
    if (holder && typeof holder === 'object' && 'safety_audit' in holder) {
      audit = audit ?? holder.safety_audit;
      delete holder.safety_audit;
    }
  }
  return audit;
};

/**
 * Record a stopped request. `review` is held for a human (status pending);
 * `reject` is kept as an audit trail. `allow` and `skipped` are not stored, and
 * `unavailable` (the classifier itself failed) is a system fault, not a
 * decision about the content, so it is logged rather than queued.
 * Never throws: a failed write must not break the response the user is waiting on.
 *
 * @param {object|null} audit - from takeSafetyAudit
 * @param {object} context - userId, projectId, chatId, jobId, source
 */
export const persistSafetyAudit = async (audit, { userId, projectId, chatId, jobId, source } = {}) => {
  if (!audit || typeof audit !== 'object') return;
  if (audit.verdict === 'unavailable') {
    console.warn(`[Safety] classifier unavailable for job ${jobId ?? '-'}: ${audit.reasoning ?? ''}`);
    return;
  }
  if (audit.verdict !== 'reject' && audit.verdict !== 'review') return;

  try {
    const { SafetyReview } = await import('../models/SafetyReview.js');
    await SafetyReview.create({
      user: userId ?? null,
      project: projectId ?? null,
      chat: chatId ?? null,
      jobId: jobId ?? null,
      source: source ?? 'design_chat',
      verdict: audit.verdict,
      category: audit.category ?? null,
      confidence: typeof audit.confidence === 'number' ? audit.confidence : null,
      reasoning: audit.reasoning ?? '',
      model: audit.model ?? null,
      conversation: Array.isArray(audit.conversation) ? audit.conversation : [],
      status: audit.verdict === 'review' ? 'pending' : 'rejected',
    });
  } catch (error) {
    console.error(`[Safety] could not record ${audit.verdict} for job ${jobId ?? '-'}:`, error.message);
  }
};

/**
 * Security boundary: Node.js talks ONLY to the Supervisor Agent.
 * Downstream AI agents (Requirement, Architecture, Component, PCB, Validation, Documentation)
 * are internal to the Python engine and are never addressed directly here.
 */
export const callSupervisor = async ({
  action,
  project,
  messages = [],
  files = [],
  jobId = null,
  agentType = null,
  provider = null,
  model = null,
  credentials = null,
  audit = {},
}) => {
  if (env.localRuntimeEnabled) {
    const { executeLocalRequest } = await import('./runtime.service.js');
    if (!audit.userId) throw ApiError.unauthorized('Local jobs require an authenticated user');
    return executeLocalRequest({ userId: audit.userId, project, chatId: audit.chatId, action, messages, files, agentType, provider, model, jobId: jobId || undefined });
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  if (jobId) {
    const existing = jobStore.get(jobId);
    if (existing) existing.controller = controller;
  }

  try {
    const response = await fetch(supervisorUrl(), {
      method: 'POST',
      headers: supervisorHeaders({ 'content-type': 'application/json' }),
      signal: controller.signal,
      // Built with buildSupervisorBody so a field added to the contract cannot
      // be silently dropped here — which is exactly what happened to agentType.
      body: JSON.stringify(
        buildSupervisorBody({ action, project, messages, files, jobId, agentType, provider, model, credentials })
      ),
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new ApiError(502, body.message || 'Supervisor Agent request failed');
    }

    const result = body.data || body;
    // Before the result reaches the controller, and so the client.
    await persistSafetyAudit(takeSafetyAudit(result), { ...audit, jobId });
    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error.name === 'AbortError') {
      throw new ApiError(504, 'Supervisor Agent request timed out');
    }
    throw new ApiError(502, 'Supervisor Agent is unavailable');
  } finally {
    clearTimeout(timeout);
  }
};

/**
 * Check the status of a Supervisor Agent job (if the Python server supports async jobs).
 */
export const getSupervisorStatus = async (jobId) => {
  // First check our local in-memory store
  const local = jobStore.get(jobId);
  if (local && local.status === 'completed') return local;

  // Then check with the Supervisor Agent
  try {
    const response = await fetch(supervisorUrl(`/${jobId}/status`), { headers: supervisorHeaders() });

    if (response.ok) {
      const body = await response.json().catch(() => ({}));
      const status = body.data || body;
      setJobStatus(jobId, status.status || 'unknown', status);
      return status;
    }
  } catch {
    // Fall through to local
  }

  return local || { jobId, status: 'unknown' };
};

/**
 * Cancel a Supervisor Agent job.
 */
export const cancelSupervisorJob = async (jobId) => {
  const job = jobStore.get(jobId);
  if (job?.controller) {
    job.controller.abort();
  }

  try {
    await fetch(supervisorUrl(`/${jobId}/cancel`), { method: 'POST', headers: supervisorHeaders() });
  } catch {
    // Best-effort cancel
  }

  setJobStatus(jobId, 'cancelled');
  return { jobId, status: 'cancelled' };
};


// ---------------------------------------------------------------------------
// Streaming supervisor call (SSE → Socket.io bridge)
// ---------------------------------------------------------------------------

/**
 * Parse a raw SSE text buffer into discrete events.
 *
 * SSE format:  event: <name>\ndata: <json>\n\n
 *
 * Because TCP can split a chunk mid-line, this function returns both the
 * parsed events AND any leftover text that hasn't formed a complete event
 * yet.  The caller must prepend ``remainder`` to the next chunk.
 *
 * @param {string} buffer - accumulated text (may contain 0-N events)
 * @returns {{ events: Array<{event: string, data: object}>, remainder: string }}
 */
const parseSSEBuffer = (buffer) => {
  const events = [];
  // Each SSE event is terminated by a double newline.
  const blocks = buffer.split('\n\n');

  // The last element is either '' (if buffer ended with \n\n) or an
  // incomplete block we need to keep for the next chunk.
  const remainder = blocks.pop() || '';

  for (const block of blocks) {
    if (!block.trim()) continue;

    let eventType = 'message';
    let dataLine = '';

    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        dataLine = line.slice(6);
      }
    }

    if (!dataLine) continue;

    try {
      events.push({ event: eventType, data: JSON.parse(dataLine) });
    } catch {
      // Unparseable JSON — skip this event rather than crashing.
      console.warn('[Supervisor] Skipped unparseable SSE data:', dataLine.slice(0, 200));
    }
  }

  return { events, remainder };
};

/**
 * Write a completed run's design and board state onto its Chat session (or, absent a
 * chatId, its Project — see the fallback note in ai.controller.js#runStream).
 *
 * Every other artifact a run produces is persisted by the browser through
 * PATCH /chats/:id/artifacts once ai:complete arrives. The board cannot be: it
 * is the one artifact that is not re-derivable (its files live under
 * uploads/boards/ and `urls` is the only record of where they are), and a
 * board run can finish after the tab that started it is gone. So it is
 * written here, where the completion actually lands, whether or not anyone is
 * still listening.
 *
 * The clearing branch mirrors the rule the workspace store applies in memory
 * (see setAiOutput in frontend/lib/store.ts): a run that delivers new
 * components retires the board built from the previous ones, because showing
 * that board beside a different BOM would be a different design than the one on
 * screen. `{}` rather than null is the "untouched" value the rest of the
 * Mixed fields use.
 */
export const persistBoardState = async (project, chatId, result, audit, jobId, signal = null) => {
  const projectId = audit?.projectId || project?._id;
  if (!result || typeof result !== 'object') return;
  if (!chatId && !projectId) return;

  let board = result.board;
  let hasBoard = board && typeof board === 'object' && Object.keys(board).length > 0;
  const componentsReplaced = Boolean((result.bom && !isDeepStrictEqual(result.bom, project?.bom)) || (result.pcb_ir && !isDeepStrictEqual(result.pcb_ir, project?.pcb_ir)));
  const inheritedBoard = hasBoard && isDeepStrictEqual(board, project?.board);
  if (inheritedBoard && componentsReplaced) { result.board = {}; board = null; hasBoard = false; }
  const artifactKeys = [
    'requirements', 'architecture', 'bom', 'eda_data', 'pcb_ir', 'validation',
    'handoff_validation', 'documentation', 'code_generation',
  ];
  const fields = Object.fromEntries(artifactKeys.filter((key) => result[key] && typeof result[key] === 'object')
    .map((key) => [key, result[key]]));
  if (hasBoard || componentsReplaced) fields.board = hasBoard ? board : {};
  if (!Object.keys(fields).length) return true;

  try {
    if (hasBoard && !inheritedBoard) {
      if (env.archiveSupervisorArtifacts) {
        const { archiveSupervisorBoard } = await import('./supervisorArtifacts.service.js');
        board = await archiveSupervisorBoard(board, { jobId, userId: audit?.userId, projectId, chatId }, (relative) => {
          const encoded = relative.split('/').map(encodeURIComponent).join('/');
          return fetch(supervisorUrl(`/artifacts/${encoded}`), { headers: supervisorHeaders(), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000) });
        });
        result.board = board; fields.board = board;
      }
      const { BoardArtifact } = await import('../models/BoardArtifact.js');
      const firstUrl = Object.values(board.urls || {}).find((url) => typeof url === 'string' && url.startsWith('/uploads/boards/'));
      const directory = firstUrl?.split('/')[3];
      if (!directory || !audit?.userId || !projectId) throw new Error('Board has no authorized artifact directory');
      await BoardArtifact.updateOne({ jobId }, { $setOnInsert: {
        jobId, directory, user: audit.userId, project: projectId, chat: chatId || null,
        urls: board.urls, stats: board.stats || {},
      } }, { upsert: true });
      delete board.out_dir;
    }
    if (chatId) {
      const { Chat } = await import('../models/Chat.js');
      await Chat.updateOne({ _id: chatId }, { $set: fields });
    } else {
      const { Project } = await import('../models/Project.js');
      await Project.updateOne({ _id: projectId }, { $set: fields });
    }
  } catch (error) {
    // A board that is on screen but unsaved is a bad outcome, but it is not
    // worth tearing down the stream the user is currently watching.
    console.error(`[AI Stream] could not persist board for chat=${chatId} project=${projectId}:`, error.message);
    return false;
  }
  return true;
};

/**
 * Call the Supervisor Agent's streaming endpoint and relay progress over
 * Socket.io.
 *
 * Design notes:
 * - No AbortController timeout.  LangGraph agents can legitimately run
 *   for several minutes; a hard timeout would sever a healthy stream.
 *   Callers that need cancellation should use ``cancelSupervisorJob``.
 * - The SSE text buffer handles TCP packet splits: we accumulate text
 *   until we see \n\n before parsing.
 * - Mid-stream Python errors arrive as ``event: error`` (HTTP 200 was
 *   already sent) and are relayed as ``ai:error`` socket events.
 *
 * @param {object} io - Socket.io server instance
 * @param {object} opts - { action, project, messages, files, jobId }
 * @returns {Promise<object>} final serialised state (from the ``complete`` event)
 */
export const callSupervisorStream = async (
  io,
  {
    action,
    project,
    messages = [],
    files = [],
    jobId,
    agentType = null,
    provider = null,
    model = null,
    credentials = null,
    chatId = null,
    audit = {},
    onComplete = null,
    signal = null,
  }
) => {
  if (env.localRuntimeEnabled) {
    const { queueLocalJob } = await import('./runtime.service.js');
    return queueLocalJob({ userId: audit.userId, project, chatId, action, messages, files, agentType, provider, model, jobId });
  }
  const controller = new AbortController();
  const linkedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  setJobStatus(jobId, 'running', { controller });

  let response;

  try {
    response = await fetch(supervisorUrl('/stream'), {
      method: 'POST',
      headers: supervisorHeaders({ 'content-type': 'application/json' }),
      signal: linkedSignal,
      body: JSON.stringify(
        buildSupervisorBody({ action, project, messages, files, jobId, agentType, provider, model, credentials })
      ),
    });
  } catch (error) {
    setJobStatus(jobId, 'failed', { error: 'Supervisor Agent is unavailable' });
    throw new ApiError(502, 'Supervisor Agent is unavailable');
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    setJobStatus(jobId, 'failed', { error: body.message || 'Supervisor request failed' });
    throw new ApiError(response.status === 429 ? 429 : 502, body.detail || body.message || 'Supervisor Agent request failed');
  }

  // Read the SSE stream chunk-by-chunk.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let finalResult = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const { events, remainder } = parseSSEBuffer(sseBuffer);
      sseBuffer = remainder;

      for (const { event, data } of events) {
        if (event === 'progress') {
          const { emitAIProgress } = await import('../sockets/index.js');
          emitAIProgress(io, jobId, data);
          setJobStatus(jobId, 'running', { currentNode: data.node, label: data.label });
          const { AiJob } = await import('../models/AiJob.js');
          await AiJob.updateOne({ jobId, status: 'running' }, { $set: { progress: data } });

        } else if (event === 'error') {
          const { emitAIError } = await import('../sockets/index.js');
          emitAIError(io, jobId, data);
          setJobStatus(jobId, 'failed', { error: data.error, node: data.node });
          return data; // Stream closed by Python after an error event.

        } else if (event === 'complete') {
          // Stripped before the emit: the socket goes straight to the browser.
          const safetyAudit = takeSafetyAudit(data);
          finalResult = data.data || data;
          finalResult.providerUsage = data.providerUsage || [];
          linkedSignal.throwIfAborted();
          const persisted = await persistBoardState(project, chatId, finalResult, audit, jobId, linkedSignal);
          if (!persisted) {
            const { emitAIError } = await import('../sockets/index.js');
            const failure = { jobId, error: 'Could not save the generated design', node: 'persistence' };
            emitAIError(io, jobId, failure);
            setJobStatus(jobId, 'failed', failure);
            return failure;
          }
          linkedSignal.throwIfAborted();
          if (onComplete) await onComplete(finalResult);
          const { emitAIComplete } = await import('../sockets/index.js');
          emitAIComplete(io, jobId, data);
          await persistSafetyAudit(safetyAudit, { ...audit, chatId, jobId });
          setJobStatus(jobId, 'completed', finalResult);
        }
      }
    }
  } finally {
    reader.releaseLock();
    const stored = jobStore.get(jobId); if (stored?.controller === controller) delete stored.controller;
  }

  if (!finalResult) throw ApiError.badGateway('The engine stream ended without a completed design');
  return finalResult;
};


// ---------------------------------------------------------------------------
// Code chat, capabilities, board artifacts
// ---------------------------------------------------------------------------

/**
 * The firmware code chat. Was inlined in ai.controller.js with its own
 * hard-coded path and no token — so it 401s against a supervisor that checks
 * one — and no timeout.
 */
export const callCodeChat = async ({ files = [], messages = [], credentials = null, model }) => {
  let response;
  try {
    response = await fetch(supervisorUrl('/code-chat'), {
      method: 'POST',
      headers: supervisorHeaders({ 'content-type': 'application/json' }),
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        files,
        messages,
        ...(typeof model === 'string' && model ? { model } : {}),
        ...(credentials && Object.keys(credentials).length ? { credentials } : {}),
      }),
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw new ApiError(504, 'Code chat timed out');
    throw new ApiError(502, 'Supervisor Agent is unavailable');
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(502, body.detail || body.message || 'Code chat failed');
  }
  return body;
};

const CAPABILITIES_TTL_MS = 60_000;
let capabilitiesCache = { at: 0, value: null };

/**
 * What the AI engine can run on the operator's own setup: which board
 * providers have a key (or, for claude-code, a CLI) there. Cached for a
 * minute. Null when the engine is unreachable — callers treat that as
 * "unknown" and let the run itself report the problem.
 */
export const getCapabilities = async () => {
  if (env.localRuntimeEnabled) return { default_board_provider: 'groq', board_providers: { groq: true }, platform_keys: { groq: Boolean(env.groqApiKey) } };
  if (capabilitiesCache.value && Date.now() - capabilitiesCache.at < CAPABILITIES_TTL_MS) {
    return capabilitiesCache.value;
  }
  try {
    const response = await fetch(supervisorUrl('/capabilities'), {
      headers: supervisorHeaders(),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return null;
    const body = await response.json();
    capabilitiesCache = { at: Date.now(), value: body.data ?? body };
    return capabilitiesCache.value;
  } catch {
    return null;
  }
};

/**
 * GET /uploads/boards/* when the file is not on this disk: fetch it from the
 * AI engine, which wrote it. Streams the body; anything but a 200 falls
 * through to the normal 404.
 */
export const proxyBoardArtifact = async (req, res, next) => {
  const relative = String(req.params[0] || '');
  if (!relative || relative.split('/').some((part) => part === '..' || part === '')) return next();

  try {
    const encoded = relative.split('/').map(encodeURIComponent).join('/');
    const upstream = await fetch(supervisorUrl(`/artifacts/${encoded}`), {
      headers: supervisorHeaders(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!upstream.ok || !upstream.body) return next();

    for (const header of ['content-type', 'content-length', 'last-modified', 'etag']) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    res.setHeader('cache-control', 'private, no-store');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch {
    next();
  }
};
