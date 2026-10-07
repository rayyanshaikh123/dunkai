import { createHash } from 'node:crypto';
import { asyncHandler } from '../utils/asyncHandler.js';
import { send } from '../utils/response.js';
import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';
import { resolveCredentials } from '../services/apiKey.service.js';
import { reserveCharge, settleCharge } from '../services/credits.service.js';
import { BrowserInferenceRun } from '../models/BrowserInferenceRun.js';
import { AiCharge } from '../models/AiCharge.js';
import { requestBrowserCompletion } from '../services/browserInference.service.js';

/** A bounded inference relay. The browser owns every workflow stage and all
 * deterministic design computation. The backend owns keys, quotas and usage.
 * The response contains only the model answer, never a provider credential. */
export const browserInference = asyncHandler(async (req, res) => {
  if (!env.browserComputeOnly) throw ApiError.forbidden('Browser computation is not enabled on this deployment');
  const { messages, requestId, purpose = 'design' } = req.body;
  const totalChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  if (totalChars > 12000) throw ApiError.badRequest('Model input is too large');

  const requestHash = createHash('sha256').update(JSON.stringify({ messages, purpose })).digest('hex');
  const runKey = { user: req.user._id, requestId };
  let run;
  try {
    run = await BrowserInferenceRun.create({
      ...runKey, requestHash, expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const existing = await BrowserInferenceRun.findOne(runKey).lean();
    if (!existing || existing.requestHash !== requestHash) {
      throw ApiError.conflict('This inference request ID is already in use');
    }
    if (existing.status === 'completed' && existing.result) {
      return send(res, { data: existing.result });
    }
    throw ApiError.conflict(existing.status === 'pending'
      ? 'This inference request is still processing. Wait for its result.'
      : 'This inference request failed. Start a new run to retry.');
  }

  // The request ID doubles as the ledger job ID. Its replay record is claimed
  // before reserving credits, so concurrent duplicate POSTs cannot both call
  // the provider. A failed record requires a new ID; it never hides a charge.
  const jobId = `browser:${req.user._id}:${requestId}`;
  // The replay record expires after 24 hours, while the ledger is durable.
  // Never reuse a completed ledger ID and accidentally invoke Groq for free.
  if (await AiCharge.exists({ jobId })) {
    await BrowserInferenceRun.updateOne({ _id: run._id }, { $set: { status: 'failed' } });
    throw ApiError.conflict('This inference request ID was already used. Start a new run.');
  }

  let result;
  let providerSucceeded = false;
  try {
    const credentials = await resolveCredentials(req.user._id);
    const byok = Boolean(credentials.groq);
    const key = credentials.groq || env.groqApiKey;
    if (!key) throw new ApiError(503, 'Groq inference is not configured');
    await reserveCharge(req.user, jobId, { action: 'browser_inference', byok });

    result = await requestBrowserCompletion({ key, model: env.groqBrowserModel, messages, purpose, byok });
    providerSucceeded = true;
  } catch (error) {
    // A successful HTTP response can represent a billed provider call even
    // when its body cannot be decoded. Never turn that into a free retry.
    await settleCharge(jobId, providerSucceeded || error.providerSucceeded ? {} : null);
    await BrowserInferenceRun.updateOne({ _id: run._id }, { $set: { status: 'failed' } });
    throw error;
  }

  // Settle after the provider returned, even if its body is malformed: the
  // provider may have spent tokens and browser cancellation cannot undo that.
  const usage = result?.usage || {};
  await settleCharge(jobId, {
    providerUsage: [{
      provider: 'groq', model: env.groqBrowserModel,
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
    }],
  });
  const content = result?.choices?.[0]?.message?.content;
  if (result?.choices?.[0]?.finish_reason === 'length') {
    await BrowserInferenceRun.updateOne({ _id: run._id }, { $set: { status: 'failed' } });
    throw ApiError.badGateway('The model reached its output limit. Try a smaller design or a more focused code revision.');
  }
  if (typeof content !== 'string' || !content.trim()) {
    await BrowserInferenceRun.updateOne({ _id: run._id }, { $set: { status: 'failed' } });
    throw ApiError.badGateway('Groq returned an empty answer');
  }
  const responseData = { content, model: env.groqBrowserModel, usage };
  await BrowserInferenceRun.updateOne({ _id: run._id }, { $set: { status: 'completed', result: responseData } });
  send(res, { data: responseData });
});
