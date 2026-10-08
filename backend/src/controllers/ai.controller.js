import { asyncHandler } from '../utils/asyncHandler.js';
import { send } from '../utils/response.js';
import { getProject } from '../services/project.service.js';
import { getChat } from '../services/chat.service.js';
import {
  callSupervisor,
  callSupervisorStream,
  getSupervisorStatus,
  cancelSupervisorJob,
  callCodeChat,
  getCapabilities,
  takeSafetyAudit,
  persistSafetyAudit,
} from '../services/supervisor.service.js';
import { configuredProviders, resolveCredentials } from '../services/apiKey.service.js';
import { authorizeBoardProvider, boardProviderStatus } from '../services/billing.service.js';
import { reserveCharge, settleCharge } from '../services/credits.service.js';
import { Document } from '../models/Document.js';
import { Artifact } from '../models/Artifact.js';
import { AiJob } from '../models/AiJob.js';
import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';
import { enqueueAiJob, aiQueue, redisConnection } from '../services/queue.service.js';
import { logActivity } from '../helpers/activity.js';
import { notify } from '../helpers/notification.js';
import { v4 as uuidv4 } from 'uuid';

/**
 * Who pays for this request, reserved before it starts.
 *
 * Resolves the user's own keys (BYOK) and meters the request against their
 * plan: a board against hosted boards unless their key for that provider pays,
 * anything else against hosted messages unless their Groq key pays — Groq runs
 * every agent in the pipeline. Throws 402 when a hosted quota is spent and 400
 * when the chosen board provider cannot run here.
 *
 * @returns {{ credentials: object }}
 */
const prepareAiRequest = async (req, { jobId, action = 'run_workflow', provider = null } = {}) => {
  if (env.localRuntimeEnabled) return { credentials: {} };
  const credentials = await resolveCredentials(req.user._id);
  const have = new Set(Object.keys(credentials));

  if (action === 'generate_board') {
    const providerId = provider || (await getCapabilities())?.default_board_provider || 'groq';
    const { byok } = await authorizeBoardProvider(req.user, providerId, have);
    await reserveCharge(req.user, jobId, { action, byok });
    return { credentials };
  }

  await reserveCharge(req.user, jobId, { action, byok: have.has('groq') });
  return { credentials };
};

/** Settle once after completion, release on transport or pipeline failure. */
const withSettlement = async (jobId, work) => {
  let result;
  try {
    result = await work();
  } catch (error) {
    await settleCharge(jobId, null);
    throw error;
  }
  const chargeResult = result?.data && typeof result.data === 'object'
    ? { ...result.data, providerUsage: result.providerUsage || result.data.providerUsage }
    : result;
  await settleCharge(jobId, chargeResult);
  return result;
};

// GET /api/v1/ai/providers — board generators as this user can use them.
export const providers = asyncHandler(async (req, res) => {
  if (env.localRuntimeEnabled) {
    const { listRuntimeDevices } = await import('../services/runtime.service.js');
    const devices = await listRuntimeDevices(req.user);
    const device = devices.find((item) => item.preferred && item.connected && item.ready) || devices.find((item) => item.connected && item.ready);
    return send(res, { data: {
      localRuntimeEnabled: true, runtime: device || null, engineReachable: Boolean(device),
      defaultBoardProvider: 'groq', boardProviders: [{ id: 'groq', label: 'Groq', available: Boolean(device?.capabilities?.boardSandbox && (device.mode === 'byok' || env.groqApiKey)), source: device?.mode === 'byok' ? 'byok' : 'hosted', reason: device ? null : 'Connect a computer in Settings' }],
      chat: { byok: device?.mode === 'byok', hosted: Boolean(env.groqApiKey) },
    } });
  }
  const have = await configuredProviders(req.user._id);
  const caps = await getCapabilities();
  send(res, {
    data: {
      boardProviders: await boardProviderStatus(req.user, have),
      defaultBoardProvider: caps?.default_board_provider ?? null,
      chat: { byok: have.has('groq'), hosted: caps ? Boolean(caps.platform_keys?.groq) : null },
      engineReachable: Boolean(caps),
    },
  });
});

// POST /api/v1/ai/chat
export const chat = asyncHandler(async (req, res) => {
  await getProject(req.body.projectId, req.user, true);
  const jobId = uuidv4();
  const { credentials } = await prepareAiRequest(req, { jobId, action: 'chat' });

  const result = await withSettlement(jobId, () =>
    callSupervisor({
      action: 'chat',
      project: req.body.projectId,
      messages: [{ type: 'user', content: req.body.message }],
      agentType: req.body.agentType,
      files: req.body.files || [],
      credentials,
      audit: { userId: req.user._id, projectId: req.body.projectId },
    })
  );

  await logActivity('ai_request', req.user._id, { action: 'chat', projectId: req.body.projectId }, req);

  send(res, { message: 'AI chat response', data: result });
});

// POST /api/v1/ai/code-chat
export const codeChat = asyncHandler(async (req, res) => {
  const project = await getProject(req.body.projectId, req.user, true);
  const jobId = uuidv4();
  const { credentials } = await prepareAiRequest(req, { jobId, action: 'code-chat' });

  const data = await withSettlement(jobId, () =>
    env.localRuntimeEnabled
      ? import('../services/runtime.service.js').then(({ executeLocalRequest }) => executeLocalRequest({
          userId: req.user._id, project: project.toObject(), action: 'code-chat', files: req.body.files || [], messages: req.body.messages || [], model: req.body.model, jobId,
        })).then((result) => result.data)
      : callCodeChat({ files: req.body.files || [], messages: req.body.messages || [], credentials, model: req.body.model })
  );

  // The code chat is gated by the same safety classifier. Its audit record is
  // internal: removed here, before `data` is saved or sent to the browser.
  await persistSafetyAudit(takeSafetyAudit(data), {
    userId: req.user._id,
    projectId: req.body.projectId,
    source: 'code_chat',
  });
  
  // Save new code to DB — best effort, never crash the response
  try {
    if (data.updated_files?.length > 0 && req.body.projectId) {
      const project = await getProject(req.body.projectId, req.user);
      if (project) {
        if (!project.code_generation) project.code_generation = {};
        if (!project.code_generation.files) project.code_generation.files = [];
        const existingFiles = project.code_generation.files;
        for (const updated of data.updated_files) {
          const idx = existingFiles.findIndex(f => f.filename === updated.filename);
          if (idx !== -1) {
            existingFiles[idx] = { ...existingFiles[idx], ...updated };
          } else {
            existingFiles.push(updated);
          }
        }
        project.markModified('code_generation');
        await project.save();
      }
    }
  } catch (saveErr) {
    // Log but don't fail the response — the reply still goes back to the user
    console.warn('[codeChat] DB save skipped:', saveErr?.message);
  }

  send(res, { message: 'Code chat response', data });
});

// POST /api/v1/ai/run
export const run = asyncHandler(async (req, res) => {
  if (env.billingEnabled) throw ApiError.badRequest('Use the queued /ai/run-stream endpoint for metered work');
  if (req.body.action === 'generate_board') throw ApiError.badRequest('Use /ai/run-stream for board generation');
  const project = req.body.projectId
    ? await getProject(req.body.projectId, req.user, true)
    : null;

  const action = req.body.action || 'run_workflow';
  const jobId = uuidv4();
  const { credentials } = await prepareAiRequest(req, { jobId, action, provider: req.body.provider });
  try {
    await AiJob.create({ jobId, user: req.user._id, project: project?._id, action, status: 'running' });
  } catch (error) {
    await settleCharge(jobId, null);
    throw error;
  }
  const result = await withSettlement(jobId, () =>
    callSupervisor({
      action,
      project: project ? project.toObject() : {},
      messages: req.body.messages || [],
      files: req.body.files || [],
      agentType: req.body.agentType,
      provider: req.body.provider,
      model: req.body.model,
      credentials,
      jobId,
      audit: { userId: req.user._id, projectId: project?._id },
    })
  );
  await AiJob.updateOne({ jobId }, { $set: { status: result?.error ? 'failed' : 'completed', result: result?.data || result } });

  await logActivity('ai_request', req.user._id, {
    action: req.body.action || 'run_workflow',
    agentType: req.body.agentType,
    projectId: project?._id,
    jobId,
  }, req);

  // If the result includes generated content, store it as a document
  if (project && req.body.agentType && result) {
    const typeMap = {
      requirement: 'requirements',
      architecture: 'architecture',
      component: 'components',
      pcb: 'pcb',
      validation: 'validation',
      documentation: 'documentation',
    };
    const docType = typeMap[req.body.agentType];
    if (docType) {
      const latestVersion = await Document.findOne({
        project: project._id,
        type: docType,
        isLatest: true,
      }).sort({ version: -1 });

      const newVersion = (latestVersion?.version || 0) + 1;
      if (latestVersion) {
        latestVersion.isLatest = false;
        await latestVersion.save();
      }

      const doc = await Document.create({
        project: project._id,
        type: docType,
        title: `${docType} v${newVersion}`,
        version: newVersion,
        isLatest: true,
        content: result.data || result,
        summary: result.summary || '',
        createdBy: req.user._id,
        agentType: req.body.agentType,
        previousVersion: latestVersion?._id,
      });

      // Update project stage
      if (project.currentStage !== docType) {
        project.currentStage = docType;
        if (!project.agentsCompleted.includes(docType)) {
          project.agentsCompleted.push(docType);
        }
        await project.save();
      }

      await notify(req.user._id, {
        type: 'document_ready',
        title: `${docType} generated`,
        message: `Version ${newVersion} of ${docType} is ready for your project.`,
        data: { documentId: doc._id, type: docType },
        project: project._id,
      });
    }
  }

  send(res, {
    status: 202,
    message: 'Workflow submitted to Supervisor Agent',
    data: { jobId, result },
  });
});

// GET /api/v1/ai/status/:id
export const status = asyncHandler(async (req, res) => {
  const owned = await AiJob.findOne({ jobId: req.params.id, user: req.user._id });
  if (!owned) throw ApiError.notFound('Job not found');
  if (env.aiQueueEnabled || owned.execution === 'local') return send(res, { data: owned });
  const jobStatus = await getSupervisorStatus(req.params.id);
  send(res, { data: jobStatus?.status === 'unknown' ? owned : jobStatus });
});

// GET /api/v1/ai/project/:projectId
export const projectArtifacts = asyncHandler(async (req, res) => {
  await getProject(req.params.projectId, req.user);

  const [documents, artifacts] = await Promise.all([
    Document.find({ project: req.params.projectId, isLatest: true }).sort({ type: 1 }),
    Artifact.find({ project: req.params.projectId }).sort({ createdAt: -1 }),
  ]);

  send(res, { data: { documents, artifacts } });
});

// POST /api/v1/ai/cancel
export const cancel = asyncHandler(async (req, res) => {
  const owned = await AiJob.findOne({ jobId: req.body.jobId, user: req.user._id });
  if (!owned) throw ApiError.notFound('Job not found');
  if (owned.execution === 'local') {
    const { cancelLocalJob } = await import('../services/runtime.service.js');
    return send(res, { data: await cancelLocalJob(owned, req.app.get('io')) });
  }
  if (env.aiQueueEnabled) {
    if (['completing', 'completed', 'failed', 'cancelled'].includes(owned.status)) {
      return send(res, { data: { jobId: owned.jobId, status: owned.status } });
    }
    const cancelled = await AiJob.updateOne(
      { jobId: owned.jobId, user: req.user._id, status: { $in: ['queued', 'running'] } },
      { $set: { status: 'cancelled' }, $unset: { payload: 1 } }
    );
    if (!cancelled.modifiedCount) {
      const latest = await AiJob.findOne({ jobId: owned.jobId, user: req.user._id });
      return send(res, { data: { jobId: owned.jobId, status: latest.status } });
    }
    const queued = await aiQueue().getJob(owned.jobId);
    if (queued) await queued.remove().catch(() => {});
    await redisConnection().publish('dunkai-ai-cancel', owned.jobId);
    await settleCharge(owned.jobId, null);
    const { emitAIError } = await import('../sockets/index.js');
    emitAIError(req.app.get('io'), owned.jobId, { jobId: owned.jobId, error: 'Job cancelled' });
    return send(res, { data: { jobId: owned.jobId, status: 'cancelled' } });
  }
  if (['completing', 'completed', 'failed', 'cancelled'].includes(owned.status)) return send(res, { data: { jobId: owned.jobId, status: owned.status } });
  const changed = await AiJob.updateOne({ jobId: owned.jobId, status: { $in: ['queued', 'running'] } }, { $set: { status: 'cancelled' } });
  if (!changed.modifiedCount) return send(res, { data: await AiJob.findOne({ jobId: owned.jobId }) });
  const result = await cancelSupervisorJob(req.body.jobId);
  await settleCharge(owned.jobId, null);
  const { emitAIError } = await import('../sockets/index.js');
  emitAIError(req.app.get('io'), owned.jobId, { jobId: owned.jobId, error: 'Job cancelled' });
  send(res, { message: 'Job cancelled', data: result });
});

// POST /api/v1/ai/run-stream
// Kicks off the streaming pipeline and returns immediately with a jobId.
// The frontend subscribes to Socket.io room `job:<jobId>` and receives:
//   ai:progress  — after each agent node completes
//   ai:error     — if the pipeline fails mid-stream
//   ai:complete  — when the full workflow finishes
export const runStream = asyncHandler(async (req, res) => {
  const project = req.body.projectId
    ? await getProject(req.body.projectId, req.user, true)
    : null;

  // Each chat session holds its own pipeline artifacts (see Chat.js) so
  // switching sessions shows independent requirements/architecture/etc
  // instead of one design shared across every conversation in the project.
  // Falls back to the project's own fields when no chat is scoped to this
  // run (only reachable from an older client that doesn't send chatId yet).
  const chat = req.body.chatId ? await getChat(req.body.chatId, req.user) : null;
  if (chat && String(chat.project) !== String(project?._id)) throw ApiError.forbidden('Chat does not belong to this project');
  if (env.localRuntimeEnabled) {
    const { queueLocalJob } = await import('../services/runtime.service.js');
    const projectPayload = chat ? { ...chat.toObject(), project_name: project?.title, name: project?.title } : project?.toObject() || {};
    const data = await queueLocalJob({ userId: req.user._id, project: { ...projectPayload, _id: project?._id },
      chatId: chat?._id || null, action: req.body.action || 'run_workflow', messages: req.body.messages || [],
      files: req.body.files || [], agentType: req.body.agentType, provider: req.body.provider, model: req.body.model });
    return send(res, { status: 202, message: 'Workflow sent to your local computer', data });
  }
  if (env.billingEnabled && await AiJob.countDocuments({ user: req.user._id, status: { $in: ['queued', 'running', 'completing'] } }) >= 2) {
    throw new ApiError(429, 'Two AI jobs are already running. Wait for one to finish.');
  }

  // Metered before the job id exists, so a refused request (quota spent,
  // provider not available here) is a plain 4xx the client can show.
  const action = req.body.action || 'run_workflow';
  const jobId = uuidv4();
  const { credentials } = await prepareAiRequest(req, { jobId, action, provider: req.body.provider });
  try {
    await AiJob.create({ jobId, user: req.user._id, project: project?._id, chat: chat?._id, action, status: env.aiQueueEnabled ? 'queued' : 'running' });
  } catch (error) {
    await settleCharge(jobId, null);
    throw error;
  }
  const io = req.app.get('io');

  // Use the server-persisted chat/project snapshot for board generation.
  // Browser-supplied pcbIr can be stale or from a different chat.
  const projectPayload = chat
    ? { ...chat.toObject(), project_name: project?.title, name: project?.title }
    : project
      ? project.toObject()
      : {};

  if (env.aiQueueEnabled) {
    try {
      await AiJob.updateOne({ jobId }, { $set: { payload: {
        project: projectPayload,
        messages: req.body.messages || [], files: req.body.files || [],
        agentType: req.body.agentType, provider: req.body.provider, model: req.body.model,
      } } });
      await enqueueAiJob(jobId);
    } catch (error) {
      await settleCharge(jobId, null);
      await AiJob.updateOne({ jobId }, { $set: { status: 'failed', error: 'Could not queue job' } });
      throw error;
    }
    send(res, { status: 202, message: 'AI job queued', data: { jobId } });
    return;
  }

  // Fire-and-forget: the stream runs in the background and emits
  // Socket.io events as progress arrives.  We don't await it here.
  callSupervisorStream(io, {
    action,
    project: projectPayload,
    messages: req.body.messages || [],
    files: req.body.files || [],
    agentType: req.body.agentType,
    provider: req.body.provider,
    model: req.body.model,
    credentials,
    jobId,
    chatId: chat?._id || null,
    audit: { userId: req.user._id, projectId: project?._id },
    onComplete: async (completed) => {
      const claimed = await AiJob.updateOne({ jobId, status: 'running' }, { $set: { status: 'completing' } });
      if (!claimed.modifiedCount) throw new Error('Job cancelled before completion');
      await settleCharge(jobId, completed);
      await AiJob.updateOne({ jobId, status: 'completing' }, { $set: { status: 'completed', result: completed } });
    },
  }).then(async (result) => {
    try {
      await settleCharge(jobId, result);
      await AiJob.updateOne({ jobId, status: { $nin: ['cancelled', 'completed'] } }, { $set: { status: result?.error ? 'failed' : 'completed', result: result?.error ? null : result, error: result?.error || null } });
    } catch (error) {
      console.error(`[AI Stream] could not settle or save job ${jobId}:`, error.message);
    }
  }, async (err) => {
    console.error(`[AI Stream] job ${jobId} failed:`, err.message);
    await settleCharge(jobId, null).catch((settleErr) =>
      console.error(`[AI Stream] credit release failed for ${jobId}:`, settleErr.message));
    await AiJob.updateOne({ jobId, status: { $nin: ['cancelled', 'completed'] } }, { $set: { status: 'failed', error: err.message } }).catch(() => {});
    const { emitAIError } = await import('../sockets/index.js');
    emitAIError(io, jobId, { jobId, error: err.message });
  });

  await logActivity('ai_request', req.user._id, {
    action,
    agentType: req.body.agentType,
    projectId: project?._id,
    provider: req.body.provider,
    jobId,
    streaming: true,
  }, req);

  send(res, {
    status: 202,
    message: 'Streaming workflow started — subscribe to Socket.io room job:<jobId>',
    data: { jobId },
  });
});
