import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connectTestDatabase } from './helpers/database.js';
import { User } from '../src/models/User.js';
import { Project } from '../src/models/Project.js';
import { Chat } from '../src/models/Chat.js';
import { Wallet } from '../src/models/Wallet.js';
import { Usage } from '../src/models/Usage.js';
import { AiCharge } from '../src/models/AiCharge.js';
import { CreditEntry } from '../src/models/CreditEntry.js';
import { createChat } from '../src/services/chat.service.js';
import { getOrCreateWallet, reserveCharge, settleCharge, walletSummary, quoteCharge, currentCreditPeriod } from '../src/services/credits.service.js';
import { publicPlans } from '../src/config/plans.js';
let cleanup, sequence = 0;
before(async () => {
  cleanup = await connectTestDatabase();
  await Promise.all([Wallet, Usage, AiCharge, CreditEntry].map(model => model.init()));
});
after(async () => { await cleanup?.(); });
async function account(verified = true) {
  const n = ++sequence;
  const user = await User.create({ name: 'Chat Tester', email: 'chat-' + n + '@example.test', isVerified: verified });
  const project = await Project.create({ title: 'Sensor', owner: user._id });
  await getOrCreateWallet(user);
  return { user, project };
}
const conversation = async ({ user, project }) => createChat({ project: project._id }, user);
const request = (chat, action = 'run_workflow') => ({ action, chatId: chat._id, projectId: chat.project });
const pipeline = { workflow_status: 'completed', current_node: 'code_generation', bom: { rows: [{ reference: 'R1' }] }, pcb_ir: { components: [{ ref_id: 'R1' }] } };
const board = { board: { urls: { circuitJson: '/uploads/boards/test-board/dist/circuit.json', schematicSvg: '/uploads/boards/test-board/dist/schematic.svg', pcbSvg: '/uploads/boards/test-board/dist/pcb.svg' }, stats: { errors: 0 } } };

test('verified and unverified free users can create more than five chats without spending credits', async () => {
  for (const verified of [true, false]) {
    const a = await account(verified);
    const before = (await walletSummary(a.user)).available;
    for (let i = 0; i < 12; i++) await conversation(a);
    assert.equal(await Chat.countDocuments({ user: a.user._id }), 12);
    assert.equal((await walletSummary(a.user)).available, before);
    assert.equal((await walletSummary(a.user)).freeChatsLimit, null);
  }
  assert.equal(publicPlans().unlimitedChats, true);
  assert.equal(publicPlans().freeChatsPerMonth, null);
  assert.equal(publicPlans().trialCredits, 500);
});

test('AI can run in more than five chats and every run spends the published credits', async () => {
  const a = await account();
  for (let i = 0; i < 12; i++) {
    const chat = await conversation(a), jobId = 'unlimited-run-' + i;
    assert.deepEqual(await quoteCharge(a.user, request(chat)), { credits: 30, kind: 'pipeline', included: false });
    await reserveCharge(a.user, jobId, request(chat));
    await settleCharge(jobId, pipeline);
    assert.equal((await AiCharge.findOne({ jobId })).debitedCredits, 30);
  }
  assert.equal((await walletSummary(a.user)).available, 140);
});

test('a zero credit balance restricts AI execution but allows unlimited new chats', async () => {
  const a = await account();
  await Wallet.updateOne({ user: a.user._id }, { $set: { trialAvailable: 0 } });
  for (let i = 0; i < 12; i++) await conversation(a);
  const chat = await conversation(a);
  await assert.rejects(reserveCharge(a.user, 'empty-wallet', request(chat)), { statusCode: 402 });
  assert.equal(await Chat.countDocuments({ user: a.user._id }), 13);
});

test('a completed response with zero PCB traces releases credits rather than charging for an unwired board', async () => {
  const a = await account(), chat = await conversation(a)
  await reserveCharge(a.user, 'unwired-board-response', { ...request(chat, 'generate_board'), byok: true })
  await settleCharge('unwired-board-response', { board: { ...board.board, stats: { errors: 0, traces: 0 } } })
  const charge = await AiCharge.findOne({ jobId: 'unwired-board-response' })
  assert.equal(charge.status, 'released')
  assert.equal(charge.debitedCredits, 0)
  assert.equal((await walletSummary(a.user)).available, 500)
})

test('old monthly entitlements cannot waive credits for newly started work', async () => {
  const a = await account(), chat = await conversation(a);
  await Chat.updateOne({ _id: chat._id }, { $set: { freeDesign: { period: currentCreditPeriod(), completedActions: [], successfulRequests: 1 } } });
  await Usage.create({ user: a.user._id, period: currentCreditPeriod(), freeDesignsUsed: 5 });
  assert.equal((await quoteCharge(a.user, request(chat, 'generate_board'))).credits, 101);
  await reserveCharge(a.user, 'old-entitlement-new-job', request(chat, 'generate_board'));
  await settleCharge('old-entitlement-new-job', board);
  assert.equal((await walletSummary(a.user)).available, 399);
});

test('old free jobs already reserved before the policy change retain their original zero charge', async () => {
  const a = await account(), chat = await conversation(a), jobId = 'legacy-reserved-job';
  await Chat.updateOne({ _id: chat._id }, { $set: { freeDesign: { period: currentCreditPeriod(), pendingJobId: jobId, completedActions: [], successfulRequests: 1 } } });
  await AiCharge.create({ user: a.user._id, jobId, chat: chat._id, action: 'run_workflow', kind: 'pipeline',
    period: currentCreditPeriod(), freeDesign: true, freeDesignPeriod: currentCreditPeriod(), freeDesignStep: 'run_workflow',
    quoteCredits: 30, reserveTrial: 0, reservePaid: 0, tariffVersion: 2 });
  await settleCharge(jobId, pipeline);
  assert.equal((await AiCharge.findOne({ jobId })).debitedCredits, 0);
  assert.equal((await walletSummary(a.user)).available, 500);
});

test('the website run-stream endpoint charges a pipeline and PCB against credits with no monthly chat limit', async () => {
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
      assert.equal(payload.model, 'openai/gpt-oss-20b');
      if (payload.action === 'generate_board') assert.equal(payload.provider, 'groq');
      const data = payload.action === 'generate_board' ? board : pipeline;
      return new Response(`event: complete\ndata: ${JSON.stringify({ jobId: payload.jobId, data, status: 'completed' })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }
    return realFetch(input, options);
  };
  try {
    for (const action of ['run_workflow', 'generate_board']) {
      const response = await fetch(origin + '/api/v1/ai/run-stream', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signAccessToken(a.user) }, body: JSON.stringify({ projectId: String(a.project._id), chatId: String(chat._id), action,
        ...(action === 'run_workflow' ? { model: 'openai/gpt-oss-20b' } : { provider: 'auto' }),
        messages: [{ role: 'user', content: 'Build a USB sensor board' }] }) });
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
      assert.equal(job.model, 'openai/gpt-oss-20b');
      assert.equal(job.provider, 'groq');
      assert.equal((await AiCharge.findOne({ jobId })).debitedCredits, action === 'run_workflow' ? 30 : 101);
    }
    assert.equal((await walletSummary(a.user)).available, 369);
    assert.equal((await Chat.findById(chat._id)).designModel, 'openai/gpt-oss-20b');
  } finally {
    globalThis.fetch = realFetch;
    await new Promise(resolve => server.close(resolve));
  }
});
