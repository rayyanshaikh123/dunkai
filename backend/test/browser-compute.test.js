import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { User } from '../src/models/User.js';
import { Wallet } from '../src/models/Wallet.js';
import { AiCharge } from '../src/models/AiCharge.js';
import { BrowserInferenceRun } from '../src/models/BrowserInferenceRun.js';
import { Chat } from '../src/models/Chat.js';
import { Message } from '../src/models/Message.js';
import { BrowserBoard } from '../src/models/BrowserBoard.js';
import { Project } from '../src/models/Project.js';
import { browserInference } from '../src/controllers/browserInference.controller.js';
import { encryptSecret, maskSecret } from '../src/utils/secrets.js';
import { updateArtifacts, sendMessage, saveMessage } from '../src/services/chat.service.js';
import { saveBrowserBoard, getBrowserBoardFile } from '../src/services/browserBoard.service.js';
import { deleteProject } from '../src/services/project.service.js';
import { walletSummary } from '../src/services/credits.service.js';
import { Usage } from '../src/models/Usage.js';

let mongo;
let user;
let chat;
const originalFetch = globalThis.fetch;

before(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 },
    // Tiny isolated fixtures can run on constrained development disks. This
    // opt-in affects this disposable test server only, never Atlas or the app.
    ...(process.env.DUNKAI_TEST_LOW_DISK === 'true' ? {instanceOpts:[{args:['--setParameter','indexBuildMinAvailableDiskSpaceMB=20']}]} : {}),
  });
  await mongoose.connect(mongo.getUri());
  await BrowserInferenceRun.init();
  await Message.init();
  await BrowserBoard.init();
  user = await User.create({ name: 'Browser User', email: 'browser-compute@example.com', isVerified: true });
  const project = await Project.create({ owner: user._id, title: 'Browser project' });
  chat = await Chat.create({ user: user._id, project: project._id });
});

after(async () => {
  globalThis.fetch = originalFetch;
  await mongoose.disconnect();
  await mongo?.stop();
});

const call = async (reqUser = user, requestId = randomUUID(), content = 'Return a small JSON design', purpose = 'design') => {
  let body;
  const response = { status(code) { this.code = code; return this; }, json(value) { body = value; return this; } };
  await browserInference({
    user: reqUser,
    body: { requestId, purpose, messages: [{ role: 'user', content }] },
  }, response, (error) => { throw error; });
  return body;
};

test('duplicate inference returns its recorded answer without another charge or provider call', async () => {
  const replayUser = await User.create({ name: 'Replay User', email: 'browser-replay@example.com', isVerified: true });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ choices: [{ message: { content: '{"cached":true}' } }], usage: { total_tokens: 7 } });
  };
  const id = randomUUID();
  const first = await call(replayUser, id);
  const second = await call(replayUser, id);
  assert.deepEqual(second.data, first.data);
  assert.equal(calls, 1);
  assert.equal(await AiCharge.countDocuments({ jobId: `browser:${replayUser._id}:${id}` }), 1);
  assert.equal((await walletSummary(replayUser)).freeChatsUsed, 1);
  await assert.rejects(call(replayUser, id, 'A different design'), /request ID is already in use/i);
  await assert.rejects(call(replayUser, id, undefined, 'firmware'), /request ID is already in use/i);
  await BrowserInferenceRun.deleteOne({ user: replayUser._id, requestId: id });
  await assert.rejects(call(replayUser, id), /already used/i);
  assert.equal(calls, 1);
});

test('concurrent duplicate inference cannot start a second Groq request', async () => {
  const concurrentUser = await User.create({ name: 'Concurrent User', email: 'browser-concurrent@example.com', isVerified: true });
  let enterFetch;
  let finishFetch;
  const entered = new Promise((resolve) => { enterFetch = resolve; });
  const release = new Promise((resolve) => { finishFetch = resolve; });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    enterFetch();
    await release;
    return Response.json({ choices: [{ message: { content: '{"ok":true}' } }], usage: {} });
  };
  const id = randomUUID();
  const first = call(concurrentUser, id);
  await entered;
  await assert.rejects(call(concurrentUser, id), /still processing/i);
  finishFetch();
  await first;
  assert.equal(calls, 1);
  assert.equal((await walletSummary(concurrentUser)).freeChatsUsed, 1);
});

test('hosted browser inference is billed once and keeps the key out of the response', async () => {
  let authorization;
  globalThis.fetch = async (_url, options) => {
    authorization = options.headers.authorization;
    const request = JSON.parse(options.body);
    assert.equal(request.max_completion_tokens, 4096);
    assert.equal(request.reasoning_effort, 'low');
    assert.equal(request.include_reasoning, false);
    assert.equal(request.response_format.type, 'json_schema');
    assert.equal(request.response_format.json_schema.strict, true);
    assert.equal(request.response_format.json_schema.name, 'dunkai_design');
    return Response.json({
      choices: [{ message: { content: '{"project_name":"Test"}' } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    });
  };
  const result = await call();
  assert.equal(authorization, 'Bearer gsk_hosted_test');
  assert.equal(result.data.content, '{"project_name":"Test"}');
  assert.equal(JSON.stringify(result).includes('gsk_hosted_test'), false);
  assert.equal((await walletSummary(user)).available, 0);
  assert.equal((await walletSummary(user)).freeChatsUsed, 1);
  const charge = await AiCharge.findOne({ user: user._id, action: 'browser_inference' });
  assert.equal(charge.status, 'completed');
  assert.equal(charge.providerUsage[0].total_tokens, 120);
  for (let index = 0; index < 4; index += 1) await call();
  assert.equal((await walletSummary(user)).freeChatsUsed, 5);
  assert.equal((await walletSummary(user)).available, 0);
  await assert.rejects(call(), /needs 2 credits/i);
  await Wallet.updateOne({ user: user._id }, { $set: { paidAvailable: 10 } });
  await call();
  assert.equal((await walletSummary(user)).available, 8);
});

test('BYOK inference uses the encrypted user key and no operator credits', async () => {
  const key = 'gsk_browser_user_test';
  await User.updateOne({ _id: user._id }, { $set: {
    apiKeys: { groq: { encrypted: encryptSecret(key), masked: maskSecret(key) } },
  } });
  let authorization;
  globalThis.fetch = async (_url, options) => {
    authorization = options.headers.authorization;
    return Response.json({ choices: [{ message: { content: '{"ok":true}' } }], usage: {} });
  };
  const result = await call();
  assert.equal(authorization, `Bearer ${key}`);
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal((await walletSummary(user)).available, 8);
  assert.equal((await walletSummary(user)).freeChatsUsed, 5);
});

test('browser mode rejects forged verified board data and Python chat calls', async () => {
  await assert.rejects(updateArtifacts(chat._id, { board: { verified: true } }, user), /cannot assert a verified board/i);
  await assert.rejects(updateArtifacts(chat._id, { validation: { passed: true } }, user), /cannot assert a verified board/i);
  await assert.rejects(sendMessage(chat._id, { content: 'Use Python' }, user), /Python chat engine is disabled/i);
});

test('recovered messages are idempotent and enforce chat ownership', async () => {
  const clientMessageId = randomUUID();
  const first = await saveMessage(chat._id, { type: 'user', content: 'Recovered design', clientMessageId }, user);
  const second = await saveMessage(chat._id, { type: 'user', content: 'Recovered design', clientMessageId }, user);
  assert.equal(String(second._id), String(first._id));
  assert.equal((await Chat.findById(chat._id)).messageCount, 1);
  await assert.rejects(saveMessage(chat._id, { type: 'user', content: 'Changed content', clientMessageId }, user), /already used/i);
  await assert.rejects(saveMessage(chat._id, { type: 'user', content: 'Private project', clientMessageId: randomUUID() }, { _id: new mongoose.Types.ObjectId() }));
  assert.equal(await Message.countDocuments({ chat: chat._id }), 1);
});

test('board files stay private and stale client geometry cannot overwrite the latest handoff', async () => {
  const ir = { components: [{ ref_id: 'R1' }], nets: [], design_name: 'Private board' };
  await updateArtifacts(chat._id, { pcb_ir: ir }, user);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';
  const body = { sourceIr: ir, pcbSvg: svg, schematicSvg: svg, circuitJson: [{ type: 'source_component' }] };
  const board = await saveBrowserBoard(chat._id, user, body);
  assert.equal(board.verified, false);
  assert.equal((await getBrowserBoardFile(chat._id, user, 'pcb')).data, svg);
  const stranger = { _id: new mongoose.Types.ObjectId() };
  await assert.rejects(getBrowserBoardFile(chat._id, stranger, 'pcb'));
  await assert.rejects(saveBrowserBoard(chat._id, stranger, body));
  await updateArtifacts(chat._id, { pcb_ir: { ...ir, design_name: 'Updated design' } }, user);
  await assert.rejects(saveBrowserBoard(chat._id, user, body), /handoff has changed/i);
});

test('deleting a browser project removes its messages, chats and private previews', async () => {
  const project = await Project.create({ owner:user._id,title:'Temporary project' });
  const temporaryChat = await Chat.create({user:user._id,project:project._id});
  await saveMessage(temporaryChat._id, {type:'user',content:'Temporary source'},user);
  await BrowserBoard.create({chat:temporaryChat._id,project:project._id,user:user._id,sourceHash:'test',pcbSvg:'test',schematicSvg:'test',circuitJson:'[]'});
  await assert.rejects(deleteProject(project._id,{_id:new mongoose.Types.ObjectId()}));
  await deleteProject(project._id,user);
  assert.equal(await Project.countDocuments({_id:project._id}),0);
  assert.equal(await Chat.countDocuments({project:project._id}),0);
  assert.equal(await Message.countDocuments({chat:temporaryChat._id}),0);
  assert.equal(await BrowserBoard.countDocuments({project:project._id}),0);
});

test('a truncated provider answer is settled but cannot be replayed as a complete design', async () => {
  const truncatedUser=await User.create({name:'Output Limit',email:'limit@example.com',isVerified:true});
  globalThis.fetch=async()=>Response.json({choices:[{message:{content:'{"partial":'},finish_reason:'length'}],usage:{total_tokens:4096}});
  const id=randomUUID();
  await assert.rejects(call(truncatedUser,id),/output limit/i);
  assert.equal((await walletSummary(truncatedUser)).freeChatsUsed,1);
  assert.equal((await BrowserInferenceRun.findOne({user:truncatedUser._id,requestId:id})).status,'failed');
  await assert.rejects(call(truncatedUser,id),/failed/i);
});

test('Groq schema rejection recovers once, uses one charge and caches the recovered answer', async () => {
  const retryUser = await User.create({ name: 'JSON Recovery', email: 'json-recovery@example.com', isVerified: true });
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push({ body: JSON.parse(options.body), signal: options.signal });
    if (requests.length === 1) return Response.json({ error: {
      code: 'json_validate_failed', message: 'Schema mismatch', failed_generation: 'PRIVATE_REJECTED_DESIGN',
    } }, { status: 400 });
    return Response.json({ choices: [{ message: { content: '{"recovered":true}' } }], usage: { total_tokens: 200 } });
  };
  const id = randomUUID();
  const result = await call(retryUser, id);
  assert.equal(result.data.content, '{"recovered":true}');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.response_format.type, 'json_schema');
  assert.equal(requests[1].body.response_format.type, 'json_object');
  assert.equal(requests[0].body.messages[0].role, 'system');
  const schema = requests[0].body.response_format.json_schema.schema;
  assert.ok(requests[0].body.messages[0].content.includes(JSON.stringify(schema)));
  assert.equal(requests[1].body.messages[1].content, 'Return a small JSON design');
  assert.equal(requests[1].body.messages.some((message) => message.content.includes('PRIVATE_REJECTED_DESIGN')), false);
  assert.equal(requests[0].signal, requests[1].signal);
  assert.deepEqual((await call(retryUser, id)).data, result.data);
  assert.equal(requests.length, 2);
  assert.equal((await walletSummary(retryUser)).freeChatsUsed, 1);
  const charges = await AiCharge.find({ jobId: `browser:${retryUser._id}:${id}` });
  assert.equal(charges.length, 1);
  assert.equal(charges[0].status, 'completed');
  assert.equal(charges[0].providerUsage[0].total_tokens, 200);
});

test('paid and BYOK JSON recovery preserve their original price and credential', async () => {
  for (const byok of [false, true]) {
    const retryUser = await User.create({ name: 'Retry Price', email: `retry-price-${byok}@example.com`, isVerified: true,
      ...(byok ? { apiKeys: { groq: { encrypted: encryptSecret('gsk_retry_byok'), masked: maskSecret('gsk_retry_byok') } } } : {}),
    });
    const summary = await walletSummary(retryUser);
    await Wallet.updateOne({ user: retryUser._id }, { $set: { paidAvailable: 4 } });
    await Usage.updateOne({ user: retryUser._id, period: summary.period }, { $set: { freeChatsUsed: 5 } }, { upsert: true });
    let calls = 0;
    globalThis.fetch = async (_url, options) => {
      assert.equal(options.headers.authorization, `Bearer ${byok ? 'gsk_retry_byok' : 'gsk_hosted_test'}`);
      calls += 1;
      return calls === 1
        ? Response.json({ error: { code: 'json_validate_failed' } }, { status: 400 })
        : Response.json({ choices: [{ message: { content: '{"ok":true}' } }], usage: {} });
    };
    await call(retryUser);
    assert.equal(calls, 2);
    assert.equal((await walletSummary(retryUser)).available, byok ? 4 : 2);
    assert.equal((await walletSummary(retryUser)).freeChatsUsed, 5);
  }
});

test('repeated JSON rejection stops after two calls, releases quota and hides provider details', async () => {
  const failedUser = await User.create({ name: 'Invalid JSON', email: 'invalid-json@example.com', isVerified: true });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ error: { code: 'json_validate_failed', message: 'PRIVATE_PROVIDER_DETAIL', failed_generation: 'PRIVATE_DESIGN' } }, { status: 400 });
  };
  const id = randomUUID();
  await assert.rejects(call(failedUser, id), (error) => {
    assert.equal(error.statusCode, 422);
    assert.equal(error.message.includes('PRIVATE'), false);
    return true;
  });
  assert.equal(calls, 2);
  assert.equal((await walletSummary(failedUser)).freeChatsUsed, 0);
  assert.equal((await AiCharge.findOne({ jobId: `browser:${failedUser._id}:${id}` })).status, 'released');
  await assert.rejects(call(failedUser, id), /failed/i);
  assert.equal(calls, 2);
});

test('authentication, rate limits, configuration and network failures are never retried', async () => {
  const cases = [
    { status: 400, expected: 502, text: /GROQ_BROWSER_MODEL/ },
    { status: 401, expected: 502, text: /authentication/i },
    { status: 403, expected: 502, text: /model access/i },
    { status: 404, expected: 502, text: /GROQ_BROWSER_MODEL/ },
    { status: 429, expected: 429, text: /rate limited/i },
    { status: 500, expected: 502, text: /temporarily unavailable/i },
    { status: 0, expected: 503, text: /could not be reached/i },
  ];
  const failedUser = await User.create({ name: 'Provider Failures', email: 'provider-failures@example.com', isVerified: true });
  for (const { status, expected, text } of cases) {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (!status) throw new Error('PRIVATE_NETWORK_DETAIL');
      return Response.json({ error: { code: 'invalid_request_error', message: 'PRIVATE_DETAIL' } }, { status });
    };
    await assert.rejects(call(failedUser), (error) => {
      assert.equal(error.statusCode, expected);
      assert.match(error.message, text);
      assert.equal(error.message.includes('PRIVATE'), false);
      return true;
    });
    assert.equal(calls, 1);
    assert.equal((await walletSummary(failedUser)).freeChatsUsed, 0);
  }
});

test('a malformed successful provider response consumes one turn and cannot be replayed', async () => {
  const malformedUser = await User.create({ name: 'Malformed Body', email: 'malformed-body@example.com', isVerified: true });
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response('not JSON', { status: 200 }); };
  const id = randomUUID();
  await assert.rejects(call(malformedUser, id), /malformed JSON/i);
  assert.equal((await walletSummary(malformedUser)).freeChatsUsed, 1);
  assert.equal((await AiCharge.findOne({ jobId: `browser:${malformedUser._id}:${id}` })).status, 'completed');
  await assert.rejects(call(malformedUser, id), /failed/i);
  assert.equal(calls, 1);
});

test('adaptive interview uses its own schema and component edits retire old board and firmware',async()=>{
  const interviewUser=await User.create({name:'Interview',email:'interview@example.com',isVerified:true});
  globalThis.fetch=async(_url,options)=>{
    const body=JSON.parse(options.body);
    assert.equal(body.response_format.json_schema.name,'dunkai_interview');
    assert.ok(body.response_format.json_schema.schema.properties.requirements.properties.power_requirements);
    return Response.json({choices:[{message:{content:'{"status":"question","question":"Power supply?","options":["USB","Battery"],"requirements":null}'}}],usage:{total_tokens:100}});
  };
  await call(interviewUser,randomUUID(),'Interview a motor controller','interview');
  assert.equal((await walletSummary(interviewUser)).freeChatsUsed,1);
  const project=await Project.create({owner:interviewUser._id,title:'Editable components'});
  const editable=await Chat.create({user:interviewUser._id,project:project._id,pcb_ir:{components:[{ref_id:'R1'}]},board:{execution:'browser'},code_generation:{files:[{filename:'old.ino',code:'old pin map'}]}});
  await BrowserBoard.create({chat:editable._id,project:project._id,user:interviewUser._id,sourceHash:'old',pcbSvg:'old',schematicSvg:'old',circuitJson:'[]'});
  await updateArtifacts(editable._id,{requirements:{objective:'Unchanged circuit'}},interviewUser);
  assert.equal(await BrowserBoard.countDocuments({chat:editable._id}),1);
  await updateArtifacts(editable._id,{pcb_ir:{components:[{ref_id:'R2'}]}},interviewUser);
  const updated=await Chat.findById(editable._id);
  assert.equal(Object.keys(updated.board||{}).length,0);
  assert.equal(Object.keys(updated.code_generation||{}).length,0);
  assert.equal(await BrowserBoard.countDocuments({chat:editable._id}),0);
});
