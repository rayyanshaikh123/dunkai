import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import Stripe from 'stripe';
import { env } from '../config/env.js';
import { CREDIT_PACKS } from '../config/credits.js';
import { CreditEntry } from '../models/CreditEntry.js';
import { Payment } from '../models/Payment.js';
import { StripeEvent } from '../models/StripeEvent.js';
import { Wallet } from '../models/Wallet.js';
import { ApiError } from '../utils/ApiError.js';
import { getOrCreateWallet } from './credits.service.js';

let stripeClient;
const stripe = () => {
  if (!env.stripeSecretKey) throw new ApiError(503, 'Stripe checkout is not configured');
  stripeClient ??= new Stripe(env.stripeSecretKey, { timeout: 10000, maxNetworkRetries: 1 });
  return stripeClient;
};

export const createCheckout = async (user, packId) => {
  if (!env.billingEnabled) throw new ApiError(503, 'Billing is not enabled');
  const pack = CREDIT_PACKS[packId];
  if (!pack) throw ApiError.badRequest('Unknown credit pack');
  if (!user.isVerified) throw ApiError.forbidden('Verify your email before purchasing credits');
  await getOrCreateWallet(user);

  const orderId = randomUUID();
  const order = await Payment.create({ orderId, user: user._id, packId, credits: pack.credits, amountPaise: pack.amountPaise });
  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    // Use the direct credit-pack checkout contract, independently of the
    // account's Managed Payments default (which requires tax-code setup).
    managed_payments: { enabled: false },
    client_reference_id: orderId,
    customer_email: user.email,
    line_items: [{
      price_data: { currency: 'inr', unit_amount: pack.amountPaise,
        product_data: { name: `${pack.credits} DunkAI credits` } }, quantity: 1,
    }],
    metadata: { orderId, userId: String(user._id), packId },
    success_url: `${env.clientOrigin}/settings?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.clientOrigin}/settings?checkout=cancelled`,
  }, { idempotencyKey: orderId });
  await Payment.updateOne({ _id: order._id, status: 'pending' }, { $set: { stripeSessionId: session.id } });
  return { url: session.url, orderId };
};

export const verifyStripeEvent = (body, signature) => {
  if (!env.stripeWebhookSecret) throw new ApiError(503, 'Stripe webhook is not configured');
  if (!signature) throw ApiError.badRequest('Missing Stripe signature');
  return stripe().webhooks.constructEvent(body, signature, env.stripeWebhookSecret);
};

const expectedLiveMode = () => env.stripeSecretKey.startsWith('sk_live_');

const paymentSummary = (order) => ({
  orderId: order.orderId, sessionId: order.stripeSessionId,
  status: order.status, credits: order.credits,
});

/** Shared by signed webhooks and Stripe API reconciliation. Never trust the browser's payment status. */
const fulfillPaidCheckout = async (object, dbSession) => {
  const order = await Payment.findOne({ orderId: object.metadata?.orderId }).session(dbSession);
  if (!order) throw ApiError.badRequest('Unknown checkout order');
  if (String(order.user) !== object.metadata?.userId || order.packId !== object.metadata?.packId ||
      object.client_reference_id !== order.orderId || object.mode !== 'payment' ||
      object.currency?.toLowerCase() !== 'inr' || object.amount_total !== order.amountPaise ||
      (order.stripeSessionId && order.stripeSessionId !== object.id)) {
    throw ApiError.badRequest('Checkout payment does not match the order');
  }
  if (object.payment_status !== 'paid') return order;
  if (order.status === 'pending') {
    const wallet = await Wallet.findOne({ user: order.user }).session(dbSession);
    if (!wallet) throw new Error('Wallet missing for paid order');
    wallet.paidAvailable += order.credits;
    await wallet.save({ session: dbSession });
    order.status = 'paid';
    order.stripeSessionId = object.id;
    order.paymentIntentId = typeof object.payment_intent === 'string' ? object.payment_intent : object.payment_intent?.id;
    await order.save({ session: dbSession });
    await CreditEntry.create([{
      user: order.user, payment: order._id, kind: 'payment_grant',
      availablePaidDelta: order.credits, idempotencyKey: `payment:${order.orderId}`,
    }], { session: dbSession });
  }
  return order;
};

/** Check a session owned by this user against Stripe, then fulfill it once. */
export const confirmCheckout = async (user, sessionId, {
  retrieveSession = (id) => stripe().checkout.sessions.retrieve(id),
} = {}) => {
  const order = await Payment.findOne({ user: user._id, stripeSessionId: sessionId }).lean();
  if (!order) throw ApiError.notFound('Checkout not found');
  if (order.status !== 'pending') return paymentSummary(order);
  await Payment.updateOne({ _id: order._id }, { $set: { lastCheckedAt: new Date() } });
  let checkout;
  try {
    checkout = await retrieveSession(sessionId);
  } catch {
    throw ApiError.badGateway('Could not confirm payment with Stripe. Please refresh your balance in a moment.');
  }
  if (checkout.id !== sessionId || checkout.livemode !== expectedLiveMode()) {
    throw ApiError.badRequest('Stripe mode or session mismatch');
  }
  if (checkout.metadata?.orderId !== order.orderId || checkout.metadata?.userId !== String(user._id)) {
    throw ApiError.badRequest('Checkout payment does not match the order');
  }
  let confirmed;
  await mongoose.connection.transaction(async (dbSession) => {
    confirmed = await fulfillPaidCheckout(checkout, dbSession);
    if (confirmed.status === 'pending' && checkout.status === 'expired') {
      confirmed.status = 'expired';
      await confirmed.save({ session: dbSession });
    }
  });
  return paymentSummary(confirmed);
};

/** Recover missed deliveries using the existing Node process; no extra worker is needed. */
export const reconcilePendingPayments = async (user = null, options = {}) => {
  const orders = await Payment.find({
    status: 'pending', stripeSessionId: { $type: 'string' },
    ...(user ? { user: user._id } : {}),
  }).sort({ lastCheckedAt: 1, createdAt: 1 }).limit(10).select('user stripeSessionId').lean();
  const payments = [], errors = [];
  for (const order of orders) {
    try { payments.push(await confirmCheckout({ _id: order.user }, order.stripeSessionId, options)); }
    catch (error) { errors.push({ message: error.isOperational ? error.message : 'Payment confirmation failed' }); }
  }
  return { payments, errors };
};

export const handleStripeEvent = async (event) => {
  if (event.livemode !== expectedLiveMode()) throw ApiError.badRequest('Stripe mode mismatch');
  const sessionTypes = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
  const reversalTypes = ['charge.refunded', 'charge.dispute.created'];
  if (![...sessionTypes, ...reversalTypes].includes(event.type)) return;

  await mongoose.connection.transaction(async (dbSession) => {
    if (await StripeEvent.exists({ eventId: event.id }).session(dbSession)) return;
    const object = event.data.object;
    if (sessionTypes.includes(event.type)) {
      if (object.payment_status !== 'paid') return; // async success will arrive later
      await fulfillPaidCheckout(object, dbSession);
    } else {
      const intentId = typeof object.payment_intent === 'string' ? object.payment_intent : object.payment_intent?.id;
      const order = await Payment.findOne({ paymentIntentId: intentId }).session(dbSession);
      if (!order) throw ApiError.badRequest('Unknown payment for reversal');
      const target = event.type === 'charge.dispute.created'
        ? order.credits
        : Math.min(order.credits, Math.ceil(order.credits * (object.amount_refunded || 0) / order.amountPaise));
      const delta = Math.max(0, target - order.reversedCredits);
      if (delta) {
        const wallet = await Wallet.findOne({ user: order.user }).session(dbSession);
        wallet.paidAvailable -= delta; // may go negative if credits were already spent
        await wallet.save({ session: dbSession });
        order.reversedCredits += delta;
        order.status = event.type === 'charge.dispute.created' ? 'disputed' : 'refunded';
        await order.save({ session: dbSession });
        await CreditEntry.create([{
          user: order.user, payment: order._id, kind: 'payment_reversal',
          availablePaidDelta: -delta, idempotencyKey: `reversal:${event.id}`,
        }], { session: dbSession });
      }
    }
    await StripeEvent.create([{ eventId: event.id, type: event.type }], { session: dbSession });
  });
};
