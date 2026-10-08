import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { RuntimeInference } from '../models/RuntimeInference.js';
import { AiCharge } from '../models/AiCharge.js';
import { reserveCharge, settleCharge } from './credits.service.js';
import { ApiError } from '../utils/ApiError.js';

const ALLOWED = new Set(['messages', 'tools', 'tool_choice', 'response_format', 'temperature', 'top_p', 'stop', 'seed', 'parallel_tool_calls', 'reasoning_effort']);
const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const replayResponse = (record) => ({ status: record.httpStatus, body: record.response,
  ...(record.retryAt ? { retryAfter: Math.max(1, Math.ceil((record.retryAt - Date.now()) / 1000)) } : {}),
});
export const prepareRuntimeCompletion = (input) => {
  if (!input || typeof input !== 'object' || !Array.isArray(input.messages) || !input.messages.length || input.messages.length > 80 || JSON.stringify(input).length > 120_000) {
    throw ApiError.badRequest('Invalid or oversized model request');
  }
  const body = Object.fromEntries(Object.entries(input).filter(([key]) => ALLOWED.has(key)));
  if (body.messages.some((message) => !message || !['system', 'user', 'assistant', 'tool'].includes(message.role))) throw ApiError.badRequest('Unsupported message role');
  const requested = input.max_completion_tokens ?? input.max_tokens ?? env.groqMaxOutputTokens;
  if (!Number.isInteger(requested) || requested < 1) throw ApiError.badRequest('Invalid output token limit');
  const allowedModel = input.model === env.groqModel || env.groqRuntimeModels.includes(input.model);
  return { ...body, model: allowedModel ? input.model : env.groqModel, max_completion_tokens: Math.min(requested, env.groqMaxOutputTokens), stream: false };
};

/** OpenAI-compatible transport for the unchanged Groq SDK and designer. */
export const runtimeCompletion = async (user, device, job, requestId, input, fetchImpl = globalThis.fetch) => {
  if (job.mode !== 'hosted') throw ApiError.forbidden('BYOK jobs call Groq from the local computer');
  if (!/^[a-f0-9]{64}$/.test(String(requestId))) throw ApiError.badRequest('An inference replay ID is required');
  const body = prepareRuntimeCompletion(input);
  const requestHash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const key = { jobId: job.jobId, requestId };
  let record;
  try {
    record = await RuntimeInference.create({ ...key, user: user._id, device: device._id, requestHash, expiresAt: new Date(Date.now() + 86400_000) });
  } catch (error) {
    if (error.code !== 11000) throw error;
    const deadline = Date.now() + 125_000;
    do {
      const prior = await RuntimeInference.findOne(key).select('+response');
      if (!prior || prior.requestHash !== requestHash || String(prior.user) !== String(user._id)) throw ApiError.conflict('Inference ID already used for another request');
      if (prior.status === 'failed' && prior.retryAt && prior.retryAt <= new Date()) {
        record = await RuntimeInference.findOneAndUpdate({ _id: prior._id, status: 'failed', attempt: prior.attempt, retryAt: prior.retryAt }, {
          $set: { status: 'pending', retryAt: null }, $inc: { attempt: 1 }, $unset: { response: 1 },
        }, { new: true });
        if (record) break;
      } else if (prior.status !== 'pending') return replayResponse(prior);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } while (Date.now() < deadline);
    if (!record) throw new ApiError(503, 'The previous model request was interrupted. Retry the job from the website.');
  }
  const chargeId = 'local-inference:' + job.jobId + ':' + requestId + (record.attempt > 1 ? ':retry:' + record.attempt : '');
  if (await AiCharge.exists({ jobId: chargeId })) {
    await RuntimeInference.updateOne(key, { $set: { status: 'failed', httpStatus: 409, response: { error: { message: 'Inference ID already settled', type: 'invalid_request_error' } } } });
    throw ApiError.conflict('Inference ID already settled');
  }
  let output, status = 200, consumed = false, retryAfter;
  try {
    if (!env.groqApiKey) throw new ApiError(503, 'Hosted Groq inference is not configured');
    await reserveCharge(user, chargeId, { action: 'local_inference' });
    const response = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { authorization: 'Bearer ' + env.groqApiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
    });
    consumed = response.ok;
    const raw = await response.json();
    status = response.status;
    if (!response.ok) {
      // Never return provider debug generation, headers, or credentials.
      output = { error: { message: String(raw?.error?.message || 'Groq rejected the request').slice(0, 500), type: 'invalid_request_error', code: raw?.error?.code } };
      if (TRANSIENT.has(status)) retryAfter = Math.min(3600, Math.max(1, Number(response.headers.get('retry-after')) || (status === 429 ? 60 : 5)));
    } else {
      if (!Array.isArray(raw.choices) || !raw.choices.length) throw new ApiError(502, 'Groq returned an incomplete response');
      output = raw;
    }
    await settleCharge(chargeId, consumed ? { providerUsage: [{
      provider: 'groq', model: raw.model || env.groqModel,
      inputTokens: raw.usage?.prompt_tokens || 0,
      outputTokens: raw.usage?.completion_tokens || 0,
      cachedInputTokens: raw.usage?.prompt_tokens_details?.cached_tokens || 0,
    }] } : null);
  } catch (error) {
    await settleCharge(chargeId, consumed ? {} : null);
    status = error.statusCode || 503;
    output = { error: { message: error.statusCode ? error.message : 'Groq is temporarily unavailable', type: 'invalid_request_error' } };
    if (!consumed && TRANSIENT.has(status)) retryAfter = 5;
  }
  await RuntimeInference.updateOne({ _id: record._id, attempt: record.attempt }, { $set: { status: status === 200 ? 'completed' : 'failed', httpStatus: status, response: output, retryAt: retryAfter ? new Date(Date.now() + retryAfter * 1000) : null, usage: consumed ? output?.usage || {} : null } });
  return { status, body: output, ...(retryAfter ? { retryAfter } : {}) };
};
