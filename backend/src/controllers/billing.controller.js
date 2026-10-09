import { asyncHandler } from '../utils/asyncHandler.js';
import { send } from '../utils/response.js';
import { publicPlans } from '../config/plans.js';
import { getUsageSummary } from '../services/billing.service.js';
import { walletSummary } from '../services/credits.service.js';
import { createCheckout, confirmCheckout, reconcilePendingPayments, handleStripeEvent, verifyStripeEvent } from '../services/stripe.service.js';
import { CreditEntry } from '../models/CreditEntry.js';
import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';
import { quoteCharge } from '../services/credits.service.js';

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
    : await quoteCharge(req.user, { action, byok, chatId: req.query.chatId }) });
});

export const checkout = asyncHandler(async (req, res) => {
  send(res, { data: await createCheckout(req.user, req.body.packId) });
});

export const reconcile = asyncHandler(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const result = req.body.sessionId
    ? { payments: [await confirmCheckout(req.user, req.body.sessionId)], errors: [] }
    : await reconcilePendingPayments(req.user);
  send(res, { data: { ...result, wallet: await walletSummary(req.user) } });
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
