import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { connectTestDatabase } from './helpers/database.js';
import { User } from '../src/models/User.js';
import { Project } from '../src/models/Project.js';
import { Chat } from '../src/models/Chat.js';
import { Usage } from '../src/models/Usage.js';
import { Wallet } from '../src/models/Wallet.js';
import { AiCharge } from '../src/models/AiCharge.js';
import { CreditEntry } from '../src/models/CreditEntry.js';
import { getOrCreateWallet, reserveCharge, settleCharge, walletSummary, quoteCharge, currentCreditPeriod } from '../src/services/credits.service.js';

let cleanup, sequence = 0;
before(async () => {
  cleanup = await connectTestDatabase();
  await Promise.all([Wallet, Usage, AiCharge, CreditEntry].map(model => model.init()));
});
after(async () => { await cleanup?.(); });
async function account() {
  const n = ++sequence;
  const user = await User.create({ name: 'Design Tester', email: `free-${n}@example.test`, isVerified: true });
  const project = await Project.create({ title: 'Sensor', owner: user._id });
  // Includes existing accounts that used their trial credits in an older mode.
  await getOrCreateWallet(user);
  await Wallet.updateOne({ user: user._id }, { $set: { trialAvailable: 0, paidAvailable: 0, trialGranted: true } });
  return { user, project };
}
const conversation = async ({ user, project }) => Chat.create({ project: project._id, user: user._id });
const request = (chat, action = 'run_workflow') => ({ action, chatId: chat._id, projectId: chat.project });
const pipeline = { workflow_status: 'completed', current_node: 'code_generation', bom: { rows: [{ reference: 'R1' }] }, pcb_ir: { components: [{ ref_id: 'R1' }] } };
const board = { board: { urls: { circuitJson: '/uploads/boards/test-board/dist/circuit.json', schematicSvg: '/uploads/boards/test-board/dist/schematic.svg', pcbSvg: '/uploads/boards/test-board/dist/pcb.svg' }, stats: { errors: 0 } } };

test('five chats each include the interview, full pipeline and PCB even with no wallet credits', async () => {
  const a = await account();
  for (let i = 0; i < 5; i++) {
    const chat = await conversation(a);
    for (let question = 0; question < 6; question++) {
      const job = `included-${i}-${question}`;
      await reserveCharge(a.user, job, request(chat));
      await settleCharge(job, { interview_status: 'question', workflow_status: 'awaiting_input' });
    }
    assert.equal((await walletSummary(a.user)).freeChatsUsed, i + 1);
    await reserveCharge(a.user, `pipeline-${i}`, request(chat));
    await settleCharge(`pipeline-${i}`, pipeline);
    const quote = await quoteCharge(a.user, request(chat, 'generate_board'));
    assert.equal(quote.credits, 0); assert.equal(quote.included, true);
    await reserveCharge(a.user, `board-${i}`, request(chat, 'generate_board'));
    await settleCharge(`board-${i}`, board);
    await settleCharge(`board-${i}`, board);
    assert.equal((await walletSummary(a.user)).available, 0);
    await assert.rejects(reserveCharge(a.user, `board-rerun-${i}`, request(chat, 'generate_board')), { statusCode: 402 });
    await assert.rejects(reserveCharge(a.user, `pipeline-rerun-${i}`, request(chat)), { statusCode: 402 });
  }
  const sixth = await conversation(a);
  assert.equal((await quoteCharge(a.user, request(sixth))).credits, 30);
  await assert.rejects(reserveCharge(a.user, 'sixth-chat', request(sixth)), { statusCode: 402 });
  assert.equal(await AiCharge.countDocuments({ user: a.user._id, debitedCredits: { $gt: 0 } }), 0);
});

test('failed first attempt restores its monthly slot; failed pipeline/PCB retries retain their inclusion', async () => {
  const a = await account(), chat = await conversation(a);
  await reserveCharge(a.user, 'initial-failure', request(chat));
  assert.equal((await walletSummary(a.user)).freeChatsUsed, 1);
  await settleCharge('initial-failure', null);
  await settleCharge('initial-failure', null);
  assert.equal((await walletSummary(a.user)).freeChatsUsed, 0);
  await reserveCharge(a.user, 'question-after-failure', request(chat));
  await settleCharge('question-after-failure', { data: { interview_status: 'question' } });
  await reserveCharge(a.user, 'partial-pipeline', request(chat));
  await settleCharge('partial-pipeline', { current_node: 'architecture', workflow_status: 'running' });
  await reserveCharge(a.user, 'pipeline-failure', request(chat));
  await settleCharge('pipeline-failure', { workflow_status: 'failed' });
  assert.equal((await walletSummary(a.user)).freeChatsUsed, 1);
  await reserveCharge(a.user, 'pipeline-retry', request(chat));
  await settleCharge('pipeline-retry', pipeline);
  await reserveCharge(a.user, 'board-failure', request(chat, 'generate_board'));
  await settleCharge('board-failure', { error: 'Provider unavailable' });
  await reserveCharge(a.user, 'board-retry', request(chat, 'generate_board'));
  await settleCharge('board-retry', board);
  assert.equal((await walletSummary(a.user)).reserved, 0);
});

test('concurrent starts cannot claim more than five included chats', async () => {
  const a = await account();
  const chats = await Promise.all(Array.from({ length: 6 }, () => conversation(a)));
  const attempts = await Promise.allSettled(chats.map((chat, i) => reserveCharge(a.user, `parallel-${i}`, request(chat))));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 5);
  assert.equal(attempts.find(result => result.status === 'rejected').reason.statusCode, 402);
  assert.equal((await walletSummary(a.user)).freeChatsUsed, 5);
});

test('same-chat concurrency, ownership and idempotency prevent duplicating or transferring a free run', async () => {
  const a = await account(), b = await account(), chat = await conversation(a);
  await reserveCharge(a.user, 'one-active', request(chat));
  await reserveCharge(a.user, 'one-active', request(chat));
  await assert.rejects(reserveCharge(a.user, 'second-active', request(chat)), { statusCode: 429 });
  await assert.rejects(reserveCharge(b.user, 'steal-chat', request(chat)), { statusCode: 404 });
  await assert.rejects(quoteCharge(b.user, request(chat)), { statusCode: 404 });
  const another = await conversation(a);
  await assert.rejects(reserveCharge(a.user, 'one-active', request(another)), { statusCode: 409 });
  await assert.rejects(reserveCharge(a.user, 'wrong-project', { ...request(another), projectId: b.project._id }), { statusCode: 403 });
  await settleCharge('one-active', pipeline);
  await Chat.deleteOne({ _id: chat._id });
  assert.equal((await walletSummary(a.user)).freeChatsUsed, 1);
});

test('an unfinished prior-month design can finish without spending the new monthly allowance', async () => {
  const a = await account(), chat = await conversation(a);
  const current = currentCreditPeriod();
  await Chat.updateOne({ _id: chat._id }, { $set: { freeDesign: { period: '2025-01', completedActions: ['run_workflow'], successfulRequests: 1 } } });
  await Usage.create({ user: a.user._id, period: current, freeDesignsUsed: 5 });
  await reserveCharge(a.user, 'old-design-board', request(chat, 'generate_board'));
  await settleCharge('old-design-board', board);
  assert.equal((await walletSummary(a.user)).freeChatsUsed, 5);
  // A new full run in the now-completed old chat needs a new monthly slot.
  await assert.rejects(reserveCharge(a.user, 'old-design-restart', request(chat)), { statusCode: 402 });
});

test('the website run-stream endpoint admits an included pipeline and board at zero balance', async () => {
  const a = await account(), chat = await conversation(a);
  const { app } = await import('../src/app.js');
  const { AiJob } = await import('../src/models/AiJob.js');
  const { signAccessToken } = await import('../src/utils/tokens.js');
  await AiJob.init();
  app.set('io', { to: () => ({ emit: () => {} }) });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.pathname.startsWith('/api/v1/supervisor')) {
      if (url.pathname.includes('/artifacts/')) return new Response(url.pathname.endsWith('.svg') ? '<svg xmlns="http://www.w3.org/2000/svg" />' : '[]');
      if (url.pathname.endsWith('/capabilities')) return Response.json({ data: { default_board_provider: 'groq', board_providers: { groq: true }, platform_keys: { groq: true } } });
      const payload = JSON.parse(options.body);
      assert.equal(payload.project._id, String(chat._id));
      const data = payload.action === 'generate_board' ? board : pipeline;
      return new Response(`event: complete\ndata: ${JSON.stringify({ jobId: payload.jobId, data, status: 'completed' })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }
    return realFetch(input, options);
  };
  try {
    for (const action of ['run_workflow', 'generate_board']) {
      const response = await fetch(origin + '/api/v1/ai/run-stream', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signAccessToken(a.user) }, body: JSON.stringify({ projectId: String(a.project._id), chatId: String(chat._id), action, messages: [{ role: 'user', content: 'Build a USB sensor board' }] }) });
      const accepted = await response.json();
      assert.equal(response.status, 202, accepted.message);
      const jobId = accepted.data.jobId;
      let job;
      for (let attempt = 0; attempt < 100; attempt++) {
        job = await AiJob.findOne({ jobId }).lean();
        if (['completed', 'failed'].includes(job.status)) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.equal(job.status, 'completed', job.error);
      assert.equal((await AiCharge.findOne({ jobId })).debitedCredits, 0);
    }
    assert.equal((await walletSummary(a.user)).freeChatsUsed, 1);
  } finally {
    globalThis.fetch = realFetch;
    await new Promise(resolve => server.close(resolve));
  }
});

test('refund debt does not require a credit reservation for an included free run', async () => {
  const a = await account(), chat = await conversation(a);
  await Wallet.updateOne({ user: a.user._id }, { $set: { paidAvailable: -20 } });
  await reserveCharge(a.user, 'free-with-refund-debt', request(chat));
  await settleCharge('free-with-refund-debt', pipeline);
  assert.equal((await walletSummary(a.user)).available, -20);
  assert.equal((await AiCharge.findOne({ jobId: 'free-with-refund-debt' })).debitedCredits, 0);
});
