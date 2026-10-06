import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { User } from '../src/models/User.js';
import { Wallet } from '../src/models/Wallet.js';
import { Payment } from '../src/models/Payment.js';
import { CreditEntry } from '../src/models/CreditEntry.js';
import { AiCharge } from '../src/models/AiCharge.js';
import { BrowserBoard } from '../src/models/BrowserBoard.js';
import { Chat } from '../src/models/Chat.js';
import { Project } from '../src/models/Project.js';
import { getBrowserBoardFile, saveBrowserBoard } from '../src/services/browserBoard.service.js';
import { File } from '../src/models/File.js';
import { getFile } from '../src/services/file.service.js';
import { getOrCreateWallet, reserveCharge, settleCharge, walletSummary } from '../src/services/credits.service.js';
import { handleStripeEvent } from '../src/services/stripe.service.js';
import { verifyStripeEvent } from '../src/services/stripe.service.js';
import Stripe from 'stripe';
import { generateVerificationToken } from '../src/utils/tokens.js';
import { verifyEmail } from '../src/services/auth.service.js';
import { reconcileStaleJobs } from '../src/services/reconcile.service.js';

let mongo;
let user;

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  await Promise.all([Wallet.init(), Payment.init(), CreditEntry.init()]);
  user = await User.create({ name: 'Test User', email: 'credits@example.com', isVerified: true });
});

after(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});

test('trial grant, reservation, settlement and retries are idempotent', async () => {
  await getOrCreateWallet(user);
  await getOrCreateWallet(user);
  assert.equal((await walletSummary(user)).trialAvailable, 150);
  await reserveCharge(user, 'job-board-1', { action: 'generate_board' });
  await reserveCharge(user, 'job-board-1', { action: 'generate_board' });
  assert.equal((await walletSummary(user)).available, 49);
  await settleCharge('job-board-1', { board: { stats: { errors: 0 } }, providerUsage: [
    { model: 'openai/gpt-oss-120b', inputTokens: 1200, outputTokens: 300, cachedInputTokens: 0 },
  ] });
  await settleCharge('job-board-1', { board: { stats: { errors: 0 } } });
  const wallet = await walletSummary(user);
  assert.equal(wallet.available, 49);
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

test('browser PCB previews are saved for the owning chat and reject stale handoffs', async () => {
  const project = await Project.create({ owner: user._id, title: 'Local PCB' });
  const ir = {
    components: [
      { ref_id: 'R1', part_class: 'resistor', value: '1k', package: '0402' },
      { ref_id: 'R2', part_class: 'resistor', value: '1k', package: '0402' },
    ],
    nets: [{ name: 'SIGNAL', connections: ['R1.2', 'R2.1'] }],
    constraints: { board_outline: { width_mm: 30, height_mm: 20 } },
  };
  const chat = await Chat.create({ user: user._id, project: project._id, pcb_ir: ir });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"></svg>';
  const payload = { sourceIr: ir, pcbSvg: svg, schematicSvg: svg, circuitJson: [
    { type: 'source_component', name: 'R1' }, { type: 'pcb_trace' },
  ] };
  const saved = await saveBrowserBoard(chat._id, user, payload);
  assert.equal(saved.execution, 'browser');
  assert.equal(saved.verified, false);
  assert.equal(saved.stats.traces, 1);
  assert.equal((await getBrowserBoardFile(chat._id, user, 'pcb')).data, svg);
  await assert.rejects(saveBrowserBoard(chat._id, user, { ...payload, sourceIr: { components: [] } }), /changed/);
  const outsider = await User.create({ name: 'Browser Outsider', email: 'browser-outsider@example.com' });
  await assert.rejects(getBrowserBoardFile(chat._id, outsider, 'pcb'), /not found/i);
  assert.equal(await BrowserBoard.countDocuments({ chat: chat._id }), 1);
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
  assert.equal((await walletSummary(verified)).trialAvailable, 150);
});

test('a workflow interview question uses the monthly free chat allowance', async () => {
  const interviewer = await User.create({ name: 'Interview User', email: 'interview@example.com', isVerified: true });
  await reserveCharge(interviewer, 'interview-question-1', { action: 'run_workflow' });
  assert.equal((await walletSummary(interviewer)).available, 120);
  await settleCharge('interview-question-1', { interview_status: 'question' });
  const summary = await walletSummary(interviewer);
  assert.equal(summary.available, 150);
  assert.equal(summary.freeChatsUsed, 1);
});

test('failed job releases its reservation', async () => {
  await reserveCharge(user, 'job-pipeline-fail', { action: 'run_workflow' });
  assert.equal((await walletSummary(user)).available, 19);
  await settleCharge('job-pipeline-fail', { error: 'upstream failed' });
  assert.equal((await walletSummary(user)).available, 49);
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
  const attempts = await Promise.allSettled([
    reserveCharge(other, 'race-one', { action: 'generate_board' }),
    reserveCharge(other, 'race-two', { action: 'generate_board' }),
  ]);
  assert.equal(attempts.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal((await walletSummary(other)).available, 49);
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
  assert.equal((await walletSummary(user)).paidAvailable, -52);
});
