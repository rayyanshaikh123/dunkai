import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDatabase } from './helpers/database.js';
import { Usage } from '../src/models/Usage.js';
import { User } from '../src/models/User.js';
import { Wallet } from '../src/models/Wallet.js';
import { Payment } from '../src/models/Payment.js';
import { CreditEntry } from '../src/models/CreditEntry.js';
import { AiCharge } from '../src/models/AiCharge.js';
import { File } from '../src/models/File.js';
import { getFile } from '../src/services/file.service.js';
import { getOrCreateWallet, reserveCharge, settleCharge, walletSummary } from '../src/services/credits.service.js';
import { handleStripeEvent, confirmCheckout, reconcilePendingPayments } from '../src/services/stripe.service.js';
import { verifyStripeEvent } from '../src/services/stripe.service.js';
import Stripe from 'stripe';
import { generateVerificationToken } from '../src/utils/tokens.js';
import { verifyEmail } from '../src/services/auth.service.js';
import { reconcileStaleJobs } from '../src/services/reconcile.service.js';
import { TRIAL_CREDITS } from '../src/config/credits.js';
import { StripeEvent } from '../src/models/StripeEvent.js';
import { randomUUID } from 'node:crypto';

let cleanup;
let user;

before(async () => {
  cleanup = await connectTestDatabase();
  await Promise.all([Wallet.init(), Payment.init(), CreditEntry.init(), StripeEvent.init()]);
  user = await User.create({ name: 'Test User', email: 'credits@example.com', isVerified: true });
});

after(async () => {
  await cleanup?.();
});

test('trial grant, reservation, settlement and retries are idempotent', async () => {
  await getOrCreateWallet(user);
  await getOrCreateWallet(user);
  assert.equal((await walletSummary(user)).trialAvailable, 500);
  await reserveCharge(user, 'job-board-1', { action: 'generate_board' });
  await reserveCharge(user, 'job-board-1', { action: 'generate_board' });
  assert.equal((await walletSummary(user)).available, TRIAL_CREDITS - 101);
  await settleCharge('job-board-1', { board: { stats: { errors: 0 } }, providerUsage: [
    { model: 'openai/gpt-oss-120b', inputTokens: 1200, outputTokens: 300, cachedInputTokens: 0 },
  ] });
  await settleCharge('job-board-1', { board: { stats: { errors: 0 } } });
  const wallet = await walletSummary(user);
  assert.equal(wallet.available, TRIAL_CREDITS - 101);
  assert.equal(wallet.reserved, 0);
  assert.equal(await CreditEntry.countDocuments({ idempotencyKey: 'settle:job-board-1' }), 1);
  assert.equal((await AiCharge.findOne({ jobId: 'job-board-1' })).providerUsage[0].inputTokens, 1200);
});

test('file metadata is private to its owner without a shared project', async () => {
  const outsider = await User.create({ name: 'Outsider', email: 'outsider@example.com', isVerified: true });
  const file = await File.create({
    uploadedBy: user._id, originalName: 'design.pdf', path: '/tmp/design.pdf',
    url: '/uploads/design.pdf', mimeType: 'application/pdf', size: 3,
  });
  assert.equal(String((await getFile(file._id, user))._id), String(file._id));
  await assert.rejects(getFile(file._id, outsider), /private/i);
});

test('trial credits require a valid unexpired email verification token', async () => {
  const expired = generateVerificationToken();
  const pending = await User.create({
    name: 'Pending User', email: 'pending@example.com',
    emailVerificationToken: expired.hashedToken,
    emailVerificationExpires: new Date(Date.now() - 1000),
  });
  await assert.rejects(verifyEmail(expired.rawToken), /Invalid verification token/);
  assert.equal((await walletSummary(pending)).available, 0);
  const current = generateVerificationToken();
  pending.emailVerificationToken = current.hashedToken;
  pending.emailVerificationExpires = new Date(Date.now() + 60_000);
  await pending.save();
  await verifyEmail(current.rawToken);
  const verified = await User.findById(pending._id);
  assert.equal((await walletSummary(verified)).trialAvailable, 500);
});

test('requirements interviews settle at the chat tariff without a monthly free-turn allowance', async () => {
  const interviewer = await User.create({ name: 'Interview User', email: 'interview@example.com', isVerified: true });
  await reserveCharge(interviewer, 'interview-question-1', { action: 'run_workflow' });
  assert.equal((await walletSummary(interviewer)).available, TRIAL_CREDITS - 30);
  await settleCharge('interview-question-1', { interview_status: 'question' });
  const summary = await walletSummary(interviewer);
  assert.equal(summary.available, TRIAL_CREDITS - 2);
  assert.equal(summary.freeChatsUsed, 0);
  assert.equal((await Usage.findOne({ user: interviewer._id })).freeChatsUsed, 0);
});

test('failed job releases its reservation', async () => {
  await reserveCharge(user, 'job-pipeline-fail', { action: 'run_workflow' });
  assert.equal((await walletSummary(user)).available, TRIAL_CREDITS - 131);
  await settleCharge('job-pipeline-fail', { error: 'upstream failed' });
  assert.equal((await walletSummary(user)).available, TRIAL_CREDITS - 101);
});

test('reconciliation releases a stale synchronous reservation without a job record', async () => {
  await reserveCharge(user, 'orphaned-chat-1', { action: 'run_workflow' });
  await AiCharge.updateOne({ jobId: 'orphaned-chat-1' },
    { $set: { updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) } }, { timestamps: false });
  await reconcileStaleJobs();
  assert.equal((await AiCharge.findOne({ jobId: 'orphaned-chat-1' })).status, 'released');
});

test('concurrent reservations cannot overspend the last credits', async () => {
  const other = await User.create({ name: 'Other User', email: 'other@example.com', isVerified: true });
  await getOrCreateWallet(other);
  await Wallet.updateOne({ user: other._id }, { $set: { trialAvailable: 101 } });
  const attempts = await Promise.allSettled([
    reserveCharge(other, 'race-one', { action: 'generate_board' }),
    reserveCharge(other, 'race-two', { action: 'generate_board' }),
  ]);
  assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal((await walletSummary(other)).available, 0);
});

test('webhook signature rejects altered bytes', () => {
  const body = JSON.stringify({ id: 'evt_signature', type: 'checkout.session.completed' });
  const signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: 'whsec_dummy' });
  assert.equal(verifyStripeEvent(Buffer.from(body), signature).id, 'evt_signature');
  assert.throws(() => verifyStripeEvent(Buffer.from(body + ' '), signature), /signature/i);
});

test('signed-event handler grants paid credits once and rejects amount mismatch', async () => {
  const order = await Payment.create({
    orderId: 'order-test-1', user: user._id, packId: 'starter', credits: 200,
    amountPaise: 20000, stripeSessionId: 'cs_test_one',
  });
  const event = (id, amount = 20000) => ({
    id, type: 'checkout.session.completed', livemode: false,
    data: { object: {
      id: 'cs_test_one', mode: 'payment', payment_status: 'paid', currency: 'inr', amount_total: amount,
      client_reference_id: order.orderId, payment_intent: 'pi_test_one',
      metadata: { orderId: order.orderId, userId: String(user._id), packId: 'starter' },
    } },
  });
  await assert.rejects(handleStripeEvent(event('evt_bad', 100)), /does not match/);
  await handleStripeEvent(event('evt_paid'));
  await handleStripeEvent(event('evt_paid'));
  await handleStripeEvent(event('evt_duplicate_type'));
  assert.equal((await walletSummary(user)).paidAvailable, 200);
  assert.equal(await CreditEntry.countDocuments({ idempotencyKey: 'payment:order-test-1' }), 1);
});

test('a refund reverses paid credits even if they have been spent', async () => {
  await Wallet.updateOne({ user: user._id }, { $set: { trialAvailable: 0 } });
  await reserveCharge(user, 'job-after-payment', { action: 'generate_board' });
  await settleCharge('job-after-payment', { board: {} });
  await handleStripeEvent({
    id: 'evt_refund', type: 'charge.refunded', livemode: false,
    data: { object: { payment_intent: 'pi_test_one', amount_refunded: 20000 } },
  });
  await handleStripeEvent({
    id: 'evt_refund', type: 'charge.refunded', livemode: false,
    data: { object: { payment_intent: 'pi_test_one', amount_refunded: 20000 } },
  });
  assert.equal((await walletSummary(user)).paidAvailable, -101);
});

test('500 welcome credits are granted once under concurrent reads and never refill spent credits', async () => {
  const owner = await User.create({ name: 'Welcome User', email: 'welcome@example.test', isVerified: true });
  await Promise.all(Array.from({ length: 4 }, () => getOrCreateWallet(owner)));
  assert.equal((await walletSummary(owner)).trialAvailable, 500);
  assert.equal(await CreditEntry.countDocuments({ user: owner._id, kind: 'trial_grant' }), 1);
  await Wallet.updateOne({ user: owner._id }, { $set: { trialAvailable: 0 } });
  assert.equal((await walletSummary(owner)).trialAvailable, 0);
});

test('old 150-credit wallets get only a 350-credit top-up, preserving spent, reserved and purchased credits', async () => {
  const owner = await User.create({ name: 'Legacy User', email: 'legacy@example.test', isVerified: true });
  await Wallet.create({ user: owner._id, trialGranted: true, trialAvailable: 70, trialReserved: 20, paidAvailable: 300 });
  await CreditEntry.create({ user: owner._id, kind: 'trial_grant', availableTrialDelta: 150, idempotencyKey: `trial:${owner._id}` });
  await Promise.all([getOrCreateWallet(owner), getOrCreateWallet(owner)]);
  const wallet = await walletSummary(owner);
  assert.equal(wallet.trialAvailable, 420);
  assert.equal(wallet.paidAvailable, 300);
  assert.equal(wallet.reserved, 20);
  const topup = await CreditEntry.find({ user: owner._id, kind: 'trial_topup' });
  assert.equal(topup.length, 1);
  assert.equal(topup[0].availableTrialDelta, 350);
  assert.equal((await Wallet.findOne({ user: owner._id })).trialCreditsGranted, 500);
});

test('legacy wallets with no prior credit grant get the full bonus after verification', async () => {
  const owner = await User.create({ name: 'Zero Grant User', email: 'zero-grant@example.test', isVerified: true });
  await Wallet.create({ user: owner._id, trialGranted: true, trialAvailable: 0 });
  assert.equal((await walletSummary(owner)).trialAvailable, 500);
  assert.equal((await walletSummary(owner)).trialAvailable, 500);
  assert.equal(await CreditEntry.countDocuments({ user: owner._id, kind: 'trial_grant' }), 1);
});

async function paymentFixture() {
  const id = randomUUID().replaceAll('-', '');
  const owner = await User.create({ name: 'Payment User', email: `${id}@example.test`, isVerified: true });
  await getOrCreateWallet(owner);
  const order = await Payment.create({ orderId: id, user: owner._id, packId: 'studio', credits: 1500, amountPaise: 150000, stripeSessionId: `cs_test_${id}` });
  const checkout = {
    id: order.stripeSessionId, mode: 'payment', payment_status: 'paid', status: 'complete',
    livemode: false, currency: 'inr', amount_total: 150000, client_reference_id: order.orderId,
    payment_intent: `pi_${id}`, metadata: { orderId: order.orderId, userId: String(owner._id), packId: 'studio' },
  };
  return { owner, order, checkout, retrieveSession: async () => checkout };
}

test('Stripe-confirmed checkout and concurrent webhook delivery add exactly 1500 purchased credits once', async () => {
  const fixture = await paymentFixture();
  const { owner, order, checkout } = fixture;
  const event = { id: `evt_${order.orderId}`, type: 'checkout.session.completed', livemode: false, data: { object: checkout } };
  const result = await Promise.all([
    confirmCheckout(owner, checkout.id, fixture),
    confirmCheckout(owner, checkout.id, fixture),
    handleStripeEvent(event),
  ]);
  assert.equal(result[0].status, 'paid');
  assert.equal((await walletSummary(owner)).paidAvailable, 1500);
  assert.equal((await walletSummary(owner)).trialAvailable, 500);
  assert.equal(await CreditEntry.countDocuments({ payment: order._id, kind: 'payment_grant' }), 1);
  await confirmCheckout(owner, checkout.id, { retrieveSession: () => { throw new Error('Already fulfilled orders need no API call'); } });
  assert.equal((await walletSummary(owner)).paidAvailable, 1500);
});

test('an unpaid checkout cannot add credits or be made paid by a browser return', async () => {
  const fixture = await paymentFixture();
  fixture.checkout.payment_status = 'unpaid';
  fixture.checkout.status = 'open';
  assert.equal((await confirmCheckout(fixture.owner, fixture.checkout.id, fixture)).status, 'pending');
  assert.equal((await walletSummary(fixture.owner)).paidAvailable, 0);
});

test('checkout reconciliation rejects another user before calling Stripe', async () => {
  const fixture = await paymentFixture();
  await assert.rejects(confirmCheckout(user, fixture.checkout.id, {
    retrieveSession: () => { throw new Error('Foreign checkout must not be retrieved'); },
  }), { statusCode: 404 });
  assert.equal((await walletSummary(fixture.owner)).paidAvailable, 0);
});

test('checkout reconciliation rejects Stripe amount, mode, identity and session mismatches', async () => {
  for (const change of [
    { amount_total: 1 }, { currency: 'usd' }, { livemode: true }, { id: 'cs_test_other' },
    { metadata: { orderId: 'unknown-order', userId: 'other', packId: 'studio' } },
  ]) {
    const fixture = await paymentFixture();
    Object.assign(fixture.checkout, change);
    await assert.rejects(confirmCheckout(fixture.owner, fixture.order.stripeSessionId, fixture));
    assert.equal((await walletSummary(fixture.owner)).paidAvailable, 0);
    assert.equal((await Payment.findById(fixture.order._id)).status, 'pending');
  }
});

test('manual recovery checks only the signed-in user and marks expired sessions so they stop retrying', async () => {
  const fixture = await paymentFixture();
  const expired = await paymentFixture();
  expired.checkout.status = 'expired';
  expired.checkout.payment_status = 'unpaid';
  const result = await reconcilePendingPayments(fixture.owner, fixture);
  assert.equal(result.payments.length, 1);
  assert.equal(result.payments[0].status, 'paid');
  assert.equal((await walletSummary(expired.owner)).paidAvailable, 0);
  assert.equal((await confirmCheckout(expired.owner, expired.checkout.id, expired)).status, 'expired');
  const next = await reconcilePendingPayments(expired.owner, { retrieveSession: () => { throw new Error('Expired orders must not be retrieved'); } });
  assert.equal(next.payments.length, 0);
});

test('failed Stripe retrieval preserves the pending order and reports a safe retry message', async () => {
  const fixture = await paymentFixture();
  const result = await reconcilePendingPayments(fixture.owner, { retrieveSession: () => { throw new Error('private provider debug'); } });
  assert.equal(result.payments.length, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /Could not confirm payment/);
  assert.equal(JSON.stringify(result).includes('private provider debug'), false);
  assert.equal((await Payment.findById(fixture.order._id)).status, 'pending');
  assert.equal((await walletSummary(fixture.owner)).paidAvailable, 0);
});
