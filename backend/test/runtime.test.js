import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { connectTestDatabase } from './helpers/database.js';
import { app } from '../src/app.js';
import { User } from '../src/models/User.js';
import { Project } from '../src/models/Project.js';
import { Chat } from '../src/models/Chat.js';
import { RuntimeDevice } from '../src/models/RuntimeDevice.js';
import { RuntimePairing } from '../src/models/RuntimePairing.js';
import { RuntimeInference } from '../src/models/RuntimeInference.js';
import { AiJob } from '../src/models/AiJob.js';
import { Wallet } from '../src/models/Wallet.js';
import { AiCharge } from '../src/models/AiCharge.js';
import { CreditEntry } from '../src/models/CreditEntry.js';
import { Usage } from '../src/models/Usage.js';
import { signAccessToken } from '../src/utils/tokens.js';
import * as runtime from '../src/services/runtime.service.js';
import { runtimeCompletion, prepareRuntimeCompletion } from '../src/services/runtimeInference.service.js';
import { walletSummary, currentCreditPeriod } from '../src/services/credits.service.js';
import { deleteChat } from '../src/services/chat.service.js';
import { reserveArtifactBytes, releaseArtifactBytes } from '../src/services/runtimeStorage.service.js';
import { env } from '../src/config/env.js';

let cleanup, server, origin, user, other, project;
const secret = () => randomBytes(32).toString('hex');
before(async () => {
  cleanup = await connectTestDatabase();
  await Promise.all([RuntimeDevice, RuntimePairing, RuntimeInference, AiJob, Wallet, AiCharge, CreditEntry, Usage].map((model) => model.init()));
  user = await User.create({ name: 'Runtime User', email: 'runtime@example.test', isVerified: true });
  other = await User.create({ name: 'Other User', email: 'other@example.test', isVerified: true });
  project = await Project.create({ title: 'Native circuit', owner: user._id });
  server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  origin = 'http://127.0.0.1:' + server.address().port;
});
after(async () => { await new Promise((resolve) => server?.close(resolve)); await cleanup?.(); });
async function deviceJob(action = 'run_workflow') {
  const token = secret(), lease = secret();
  const device = await RuntimeDevice.create({ user: user._id, name: 'Test computer', tokenHash: runtime.hashRuntimeSecret(token), expiresAt: new Date(Date.now() + 86400_000), ready: true, lastSeenAt: new Date(), capabilities: { boardSandbox: true } });
  const chat = await Chat.create({ user: user._id, project: project._id, title: 'Native chat' });
  const jobId = randomUUID();
  await AiJob.create({ jobId, user: user._id, project: project._id, chat: chat._id, action, execution: 'local', device: device._id, status: 'queued', payload: { action, jobId, project: project.toObject() } });
  await runtime.claimLocalJob(device, lease);
  return { device, token, lease, chat, job: await runtime.getLeasedJob(device, jobId, lease) };
}
async function http(route, { token, body, method = 'POST', headers = {} } = {}) {
  const response = await fetch(origin + route, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', ...headers }, body: body == null ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text.startsWith('{') ? JSON.parse(text) : text };
}

test('verified pairing stores hashes, returns token only to holder of the device secret, and rejects another account', async () => {
  const pair = await runtime.beginPairing('My laptop');
  assert.equal((await runtime.pollPairing(pair.deviceCode)).status, 'pending');
  await assert.rejects(runtime.approvePairing(pair.userCode, { ...user.toObject(), isVerified: false }), { statusCode: 403 });
  const approved = await runtime.approvePairing(pair.userCode, user);
  await assert.rejects(runtime.approvePairing(pair.userCode, other), { statusCode: 409 });
  const result = await runtime.pollPairing(pair.deviceCode);
  assert.equal(result.status, 'approved'); assert.match(result.token, /^[a-f0-9]{64}$/);
  assert.equal((await RuntimeDevice.findById(approved.id)).tokenHash, undefined);
  assert.equal((await RuntimeDevice.findById(approved.id).select('+tokenHash')).tokenHash, runtime.hashRuntimeSecret(result.token));
  assert.equal(JSON.stringify(await runtime.listRuntimeDevices(user)).includes(result.token), false);
  await RuntimeDevice.updateOne({ _id: approved.id }, { $set: { revokedAt: new Date() } });
  assert.equal((await http('/api/v1/runtime/heartbeat', { token: result.token, body: {} })).status, 401);
});

test('native website workflow queues the exact original engine payload without keys', async () => {
  await RuntimeDevice.updateMany({}, { $set: { ready: false } });
  const { device } = await deviceJob();
  const result = await http('/api/v1/ai/run-stream', { token: signAccessToken(user), body: { projectId: String(project._id), action: 'generate_components', messages: [{ role: 'user', content: 'Use the saved requirements' }] } });
  assert.equal(result.status, 202, JSON.stringify(result.body));
  const queued = await AiJob.findOne({ jobId: result.body.data.jobId }).select('+payload');
  assert.equal(queued.execution, 'local'); assert.equal(String(queued.device), String(device._id));
  assert.equal(queued.payload.action, 'generate_components'); assert.equal(queued.payload.credentials, undefined);
  assert.equal((await http('/api/v1/ai/status/' + queued.jobId, { method: 'GET', token: signAccessToken(other) })).status, 404);
});

test('lease is bound to the computer, only one job is claimed, and cancellation prevents publication', async () => {
  const { device, lease, job } = await deviceJob();
  const claims = await Promise.all(Array.from({ length: 4 }, () => runtime.claimLocalJob(device, lease)));
  assert.equal(new Set(claims.map((claim) => claim.jobId)).size, 1);
  await assert.rejects(runtime.claimLocalJob(device, secret()), { statusCode: 409 });
  await assert.rejects(runtime.getLeasedJob({ _id: new mongoose.Types.ObjectId(), user: user._id }, job.jobId, lease), { statusCode: 404 });
  await runtime.cancelLocalJob(job);
  assert.equal((await runtime.runtimeHeartbeat(device, { ready: true, jobId: job.jobId, leaseToken: lease })).status, 'cancelled');
  await assert.rejects(runtime.localJobEvent(device, job.jobId, lease, { event: 'complete', data: { requirements: { wrong: true } } }), { statusCode: 409 });
});

test('expired leases cannot be renewed or reused', async () => {
  const { device, lease, job } = await deviceJob();
  await AiJob.updateOne({ _id: job._id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } });
  await assert.rejects(runtime.runtimeHeartbeat(device, { ready: true, jobId: job.jobId, leaseToken: lease }), { statusCode: 409 });
  await runtime.reconcileRuntimeJobs();
  assert.equal((await AiJob.findById(job._id)).status, 'failed');
});

test('completion persists original catalogue BOM/prices and schema 2.0 handoff on the owned chat', async () => {
  const { device, lease, job, chat } = await deviceJob();
  const data = { bom: { components: [{ lcsc: 'C123', unit_price: 1.23 }] }, pcb_ir: { schema_version: '2.0', components: [{ ref: 'U1' }] }, safety_audit: { trusted: true }, providerUsage: [{ inputTokens: 999999 }] };
  await runtime.localJobEvent(device, job.jobId, lease, { event: 'complete', data: { data } });
  await runtime.localJobEvent(device, job.jobId, lease, { event: 'complete', data: { data } });
  assert.equal((await Chat.findById(chat._id)).bom.components[0].unit_price, 1.23);
  assert.equal((await Chat.findById(chat._id)).pcb_ir.schema_version, '2.0');
  assert.equal((await AiJob.findById(job._id)).status, 'completed');
  assert.equal((await AiJob.findById(job._id)).result.providerUsage, undefined);
});

test('board upload uses private GridFS, is replay safe, blocks foreign access and is removed with the chat', async () => {
  const { device, token, lease, job, chat } = await deviceJob('generate_board');
  const headers = { 'x-runtime-lease': lease };
  const urls = {};
  for (const [kind, bytes] of Object.entries({ circuitJson: Buffer.from('{"components":[]}'), schematicSvg: Buffer.from('<svg/>'), pcbSvg: Buffer.from('<svg/>') })) {
    const uploaded = await http('/api/v1/runtime/jobs/' + job.jobId + '/artifacts/' + kind, { token, headers, body: bytes });
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body)); urls[kind] = uploaded.body.data.url;
    assert.equal((await http('/api/v1/runtime/jobs/' + job.jobId + '/artifacts/' + kind, { token, headers, body: bytes })).status, 200);
  }
  assert.equal(await mongoose.connection.db.collection('runtimeArtifacts.files').countDocuments({ 'metadata.jobId': job.jobId }), 3);
  const svg = await http(urls.pcbSvg, { method: 'GET', token: signAccessToken(user) }); assert.equal(svg.status, 200); assert.equal(svg.body, '<svg/>');
  assert.equal((await http(urls.pcbSvg, { method: 'GET', token: signAccessToken(other) })).status, 403);
  assert.equal((await http('/api/v1/runtime/jobs/' + job.jobId + '/artifacts/gerbersZip', { token, headers, body: Buffer.from('zip') })).status, 400);
  await runtime.localJobEvent(device, job.jobId, lease, { event: 'complete', data: { board: { out_dir: '/private', urls: { pcbSvg: 'https://evil.test' }, verified: true } } });
  const saved = await Chat.findById(chat._id); assert.equal(saved.board.verified, false); assert.equal(saved.board.urls.pcbSvg, urls.pcbSvg);
  await deleteChat(chat._id, user);
  assert.equal(await mongoose.connection.db.collection('runtimeArtifacts.files').countDocuments({ 'metadata.jobId': job.jobId }), 0);
});

test('inherited boards survive unrelated revisions and retire only when their components change', async () => {
  const previousBoard = { generated_at: '2026-10-07', urls: { pcbSvg: '/uploads/boards/previous/pcb.svg' }, out_dir: '', execution: 'local', verified: false };
  for (const changed of [false, true]) {
    const { job, device, lease, chat } = await deviceJob();
    const bom = { rows: [{ reference: 'R1', mfr_part: '10k', unit_price_usd: 0.01 }] };
    await AiJob.updateOne({ _id: job._id }, { $set: { 'payload.project.board': previousBoard, 'payload.project.bom': bom } });
    await Chat.updateOne({ _id: chat._id }, { $set: { board: previousBoard, bom } });
    await runtime.localJobEvent(device, job.jobId, lease, { event: 'complete', data: {
      board: structuredClone(previousBoard), bom: changed ? { rows: [{ reference: 'R1', mfr_part: '20k' }] } : bom,
      documentation: { notes: 'Updated documentation' },
    } });
    const saved = await Chat.findById(chat._id);
    assert.deepEqual(saved.board, changed ? {} : previousBoard);
  }
});

test('quota reservation is atomic under concurrent uploads', async () => {
  const bytes = 40 * 1024 * 1024;
  const results = await Promise.allSettled([reserveArtifactBytes(other._id, bytes), reserveArtifactBytes(other._id, bytes)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.statusCode, 413);
  await releaseArtifactBytes(other._id, bytes);
});

test('hosted gateway protects key, enforces token cap, caches concurrent retry and charges each real call once', async () => {
  const { device, job } = await deviceJob(); let calls = 0;
  const startingBalance = (await walletSummary(user)).trialAvailable;
  const body = { model: 'ignored-client-model', messages: [{ role: 'user', content: 'Hello' }], max_tokens: 20000 };
  const mock = async (url, options) => {
    calls++; assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(options.headers.authorization, 'Bearer ' + env.groqApiKey);
    const sent = JSON.parse(options.body); assert.equal(sent.model, env.groqModel); assert.equal(sent.max_completion_tokens, env.groqMaxOutputTokens);
    return Response.json({ id: 'completion-' + calls, model: sent.model, choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10 } });
  };
  const id = secret();
  const answers = await Promise.all([runtimeCompletion(user, device, job, id, body, mock), runtimeCompletion(user, device, job, id, body, mock)]);
  assert.equal(calls, 1); assert.deepEqual(answers[0], answers[1]); assert.equal(JSON.stringify(answers).includes(env.groqApiKey), false);
  assert.equal((await AiCharge.findOne({ jobId: 'local-inference:' + job.jobId + ':' + id })).providerUsage[0].inputTokens, 20);
  assert.equal((await walletSummary(user)).trialAvailable, startingBalance - 2);
  for (let i = 0; i < 4; i++) assert.equal((await runtimeCompletion(user, device, job, secret(), body, mock)).status, 200);
  assert.equal((await walletSummary(user)).freeChatsLimit, null);
  assert.equal((await runtimeCompletion(user, device, job, secret(), body, mock)).status, 200); assert.equal(calls, 6);
  assert.equal((await walletSummary(user)).trialAvailable, startingBalance - 12);
  await Wallet.updateOne({ user: user._id }, { $set: { trialAvailable: 0 } });
  assert.equal((await runtimeCompletion(user, device, job, secret(), body, mock)).status, 402); assert.equal(calls, 6);
  await Wallet.updateOne({ user: user._id }, { $inc: { paidAvailable: 10 } });
  assert.equal((await runtimeCompletion(user, device, job, secret(), body, mock)).status, 200);
  assert.equal((await walletSummary(user)).paidAvailable, 8);
  await runtime.cancelLocalJob(job); assert.equal((await walletSummary(user)).paidAvailable, 8);
  await assert.rejects(runtimeCompletion(user, device, job, id, { ...body, messages: [{ role: 'user', content: 'Different' }] }, mock), { statusCode: 409 });
});

test('provider errors release the reservation and never return debug generation', async () => {
  const { device, job } = await deviceJob();
  const before = await walletSummary(user);
  const result = await runtimeCompletion(user, device, job, secret(), { messages: [{ role: 'user', content: 'Test' }] }, async () => Response.json({ error: { message: 'Schema rejected', failed_generation: 'private internal text' } }, { status: 400 }));
  assert.equal(result.status, 400); assert.equal(result.body.error.failed_generation, undefined);
  assert.equal((await walletSummary(user)).available, before.available);
  await assert.rejects(runtimeCompletion(user, device, { ...job.toObject(), mode: 'byok' }, secret(), { messages: [{ role: 'user', content: 'Test' }] }), { statusCode: 403 });
  assert.throws(() => prepareRuntimeCompletion({ messages: [{ role: 'developer', content: 'X' }] }), { statusCode: 400 });
  assert.equal(prepareRuntimeCompletion({ model: 'openai/gpt-oss-safeguard-20b', messages: [{ role: 'user', content: 'Check this hardware' }] }).model, 'openai/gpt-oss-safeguard-20b');
  assert.ok(await Usage.findOne({ user: user._id, period: currentCreditPeriod() }));
});

test('original SDK retries can recover from rate limits without duplicating a successful charge', async () => {
  const { device, job } = await deviceJob(); const id = secret(); let calls = 0;
  const before = await walletSummary(user), body = { messages: [{ role: 'user', content: 'Retry this native request' }] };
  const provider = async () => {
    calls++;
    if (calls === 1) return Response.json({ error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } }, { status: 429, headers: { 'retry-after': '1' } });
    return Response.json({ model: env.groqModel, choices: [{ index: 0, message: { role: 'assistant', content: 'Recovered' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
  };
  const failed = await runtimeCompletion(user, device, job, id, body, provider);
  assert.equal(failed.status, 429); assert.equal(failed.retryAfter, 1);
  assert.equal((await walletSummary(user)).available, before.available);
  assert.equal((await runtimeCompletion(user, device, job, id, body, provider)).status, 429); assert.equal(calls, 1);
  await RuntimeInference.updateOne({ jobId: job.jobId, requestId: id }, { $set: { retryAt: new Date(Date.now() - 1) } });
  const replies = await Promise.all([runtimeCompletion(user, device, job, id, body, provider), runtimeCompletion(user, device, job, id, body, provider)]);
  assert.equal(calls, 2); assert.deepEqual(replies[0], replies[1]); assert.equal(replies[0].status, 200);
  assert.equal((await walletSummary(user)).available, before.available - 2);
  assert.equal((await AiCharge.findOne({ jobId: 'local-inference:' + job.jobId + ':' + id })).status, 'released');
  assert.equal((await AiCharge.findOne({ jobId: 'local-inference:' + job.jobId + ':' + id + ':retry:2' })).debitedCredits, 2);
});
