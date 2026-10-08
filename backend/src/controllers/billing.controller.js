import { asyncHandler } from '../utils/asyncHandler.js';
import { send } from '../utils/response.js';
import { publicPlans } from '../config/plans.js';
import { creditQuote } from '../config/credits.js';
import { getUsageSummary } from '../services/billing.service.js';
import { walletSummary } from '../services/credits.service.js';
import { createCheckout, handleStripeEvent, verifyStripeEvent } from '../services/stripe.service.js';
import { CreditEntry } from '../models/CreditEntry.js';
import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';

export const plans = asyncHandler(async (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  send(res, { data: publicPlans() });
});

export const usage = asyncHandler(async (req, res) => {
  send(res, { data: await getUsageSummary(req.user) });
});

export const wallet = asyncHandler(async (req, res) => {
  send(res, { data: await walletSummary(req.user) });
});

export const entries = asyncHandler(async (req, res) => {
  const items = await CreditEntry.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(100).lean();
  send(res, { data: items });
});

export const quote = asyncHandler(async (req, res) => {
  const action = req.query.action, byok = req.query.byok === 'true';
  send(res, { data: env.localRuntimeEnabled && action !== 'local_inference'
    ? { credits: 0, kind: 'local_compute', inferenceCreditsPerCall: byok ? 0 : 2 }
    : creditQuote({ action, byok }) });
});

export const checkout = asyncHandler(async (req, res) => {
  send(res, { data: await createCheckout(req.user, req.body.packId) });
});

export const webhook = asyncHandler(async (req, res) => {
  let event;
  try {
    event = verifyStripeEvent(req.body, req.header('stripe-signature'));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw ApiError.badRequest('Invalid Stripe signature');
  }
  await handleStripeEvent(event);
  send(res, { data: { received: true } });
});
