import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { NativeEngine } from '../src/engine.mjs';
import { startProxy } from '../src/proxy.mjs';

async function copyEngineSource(destination) {
  const source = path.resolve('../ai_engine/agents');
  await fs.cp(source, path.join(destination, 'agents'), { recursive: true, filter: async (filename) => {
    if (filename.includes('__pycache__')) return false;
    return (await fs.stat(filename)).isDirectory() || /\.(py|txt)$/.test(filename);
  } });
  return destination;
}

// Runs the actual existing Python supervisor with mocked model responses.
// It exercises Groq SDK compatibility without using provider quota.
test('the original supervisor performs its requirements interview through the companion proxy', { skip: process.env.DUNKAI_NATIVE_TEST !== 'true', timeout: 120_000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dunkai-native-'));
  let requests = 0;
  const key = randomBytes(32).toString('hex');
  const job = { jobId: randomUUID(), mode: 'hosted', signal: new AbortController().signal };
  const probe = http.createServer(); probe.listen(0, '127.0.0.1'); await new Promise((resolve) => probe.once('listening', resolve));
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  const proxy = await startProxy({ api: { raw: async (_route, options) => {
    requests++;
    const schema = options.body.response_format;
    const content = schema?.type === 'json_schema'
      ? { status: 'question', question: 'How should this sensor board be powered?', options: ['USB', 'Battery', 'DC adapter'], selection_mode: 'multiple', requirements: null }
      : { verdict: 'allow', category: 'benign', confidence: 1, reasoning: 'A temperature sensor board.' };
    return Response.json({ id: 'native-mock-' + requests, object: 'chat.completion', created: 1, model: options.body.model, choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 30, total_tokens: 60 } });
  } }, localKey: key, activeJob: () => job, leaseToken: key });
  const engine = new NativeEngine({ enginePath: await copyEngineSource(path.join(temp, 'engine')), outputRoot: temp, proxyUrl: proxy.origin, localKey: key, byokKey: '', model: 'openai/gpt-oss-120b', port });
  try {
    await engine.start(AbortSignal.timeout(90_000));
    assert.equal((await fetch(engine.origin + '/api/v1/supervisor/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    const events = [];
    for await (const event of engine.run({ jobId: job.jobId, action: 'run_workflow', project: {}, messages: [{ role: 'user', content: 'Design a temperature sensor board' }] }, AbortSignal.timeout(90_000))) events.push(event);
    const completion = events.find((event) => event.event === 'complete');
    assert.ok(completion, JSON.stringify(events));
    assert.equal(completion.data.data.interview_status, 'question', JSON.stringify(completion.data));
    assert.match(completion.data.data.interview_question, /powered/);
    assert.ok(requests >= 2); // original safety classifier and requirements agent
  } finally { await engine.stop(); await proxy.close(); await fs.rm(temp, { recursive: true, force: true }); }
});

test('the original catalogue supplies BOM prices and the PCB agent reads that saved BOM on a later job', { skip: process.env.DUNKAI_CATALOGUE_TEST !== 'true', timeout: 180_000 }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dunkai-catalogue-'));
  const probe = http.createServer(); probe.listen(0, '127.0.0.1'); await new Promise((resolve) => probe.once('listening', resolve));
  const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
  // These targeted original stages use catalogue/deterministic computation.
  // No hosted model calls are needed for this fixture's saved architecture.
  const proxy = await startProxy({ api: { raw: async () => { throw new Error('Unexpected provider request'); } }, localKey: 'catalogue-test', activeJob: () => null, leaseToken: 'test' });
  const engine = new NativeEngine({ enginePath: await copyEngineSource(path.join(temp, 'engine')), outputRoot: temp, proxyUrl: proxy.origin, localKey: 'catalogue-test', byokKey: '', model: 'openai/gpt-oss-120b', port });
  const architecture = { architecture_graph: { nodes: [
    { id: 'mcu', data: { label: 'STM32 microcontroller', category: 'processing' } },
    { id: 'led', data: { label: 'Status LED', category: 'output' } },
  ], edges: [{ source: 'mcu', target: 'led', data: { interface: 'GPIO' } }] } };
  try {
    await engine.start(AbortSignal.timeout(90_000));
    async function run(action, project) {
      let output;
      for await (const event of engine.run({ action, jobId: randomUUID(), project, messages: [] }, AbortSignal.timeout(150_000))) {
        if (event.event === 'error') throw new Error(event.data.error);
        if (event.event === 'complete') output = event.data.data;
      }
      assert.ok(output); assert.deepEqual(output.errors, []); return output;
    }
    const components = await run('generate_components', { name: 'Native LED controller', architecture });
    assert.equal(components.bom.rows.length, 2);
    assert.ok(components.bom.rows.some((row) => Number.isFinite(row.unit_price_usd) && row.unit_price_usd > 0), 'Catalogue prices must reach the original BOM');
    // Persisted snapshots deliberately do not carry another computer's CSV.
    const pcb = await run('generate_pcb', { name: 'Native LED controller', architecture, bom: components.bom });
    assert.equal(pcb.pcb_ir.schema_version, '2.0'); assert.equal(pcb.pcb_ir.components.length, 2);
    assert.ok(pcb.pcb_ir.nets.length > 0);
    console.log('Native catalogue/PCB handoff:', JSON.stringify({ rows: components.bom.rows.map(({ reference, mfr_part, unit_price_usd }) => ({ reference, mfr_part, unit_price_usd })), nets: pcb.pcb_ir.nets.length }));
  } finally { await engine.stop(); await proxy.close(); await fs.rm(temp, { recursive: true, force: true }); }
});
