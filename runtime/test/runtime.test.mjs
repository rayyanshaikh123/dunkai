import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { readSSE, inferenceId, containedArtifact, savePrivateJson, validateBackend } from '../src/transport.mjs';
import { startProxy } from '../src/proxy.mjs';
import { Runner } from '../src/runner.mjs';
import { localizeSnapshot } from '../src/snapshot.mjs';

test('transport handles split engine events, retry IDs are stable, and unsafe backend URLs are refused', async () => {
  const chunks = ['event: progress\ndata: {"node":"require', 'ments"}\n\n: keepalive\n\nevent: complete\ndata: {"data":{"bom":{}}}\n\n'];
  const events = []; for await (const event of readSSE(Readable.from(chunks.map((value) => Buffer.from(value))))) events.push(event);
  assert.deepEqual(events.map((event) => event.event), ['progress', 'complete']);
  assert.equal(inferenceId({ b: 2, a: 1 }), inferenceId({ a: 1, b: 2 }));
  assert.throws(() => validateBackend('http://example.com')); assert.throws(() => validateBackend('https://user:password@example.com'));
  assert.equal(validateBackend('https://api.example.com/'), 'https://api.example.com');
});
test('artifact reads reject traversal and symlinks outside the board workspace; journals are private', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dunkai-test-'));
  try {
    const root = path.join(temp, 'boards'); await fs.mkdir(root); await fs.writeFile(path.join(temp, 'private'), 'secret');
    await fs.symlink(path.join(temp, 'private'), path.join(root, 'board.svg'));
    await assert.rejects(containedArtifact(root, path.join(root, 'board.svg')), /outside/);
    const file = path.join(temp, 'state', 'connection.json'); await savePrivateJson(file, { token: 'test' });
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
test('loopback proxy requires its job key and forwards original SDK body with a stable inference ID', async () => {
  let sent; const key = randomBytes(32).toString('hex');
  const job = { jobId: 'test-job', mode: 'hosted', signal: new AbortController().signal };
  const proxy = await startProxy({ api: { raw: async (route, options) => { sent = { route, ...options }; return Response.json({ choices: [{ message: { content: 'OK' } }] }, { headers: { 'retry-after': '7' } }); } }, localKey: key, leaseToken: 'lease', activeJob: () => job });
  try {
    const body = { messages: [{ role: 'user', content: 'Native prompt' }] };
    assert.equal((await fetch(proxy.origin + '/openai/v1/chat/completions', { method: 'POST', body: JSON.stringify(body) })).status, 403);
    const response = await fetch(proxy.origin + '/openai/v1/chat/completions', { method: 'POST', headers: { authorization: 'Bearer ' + key }, body: JSON.stringify(body) });
    assert.equal(response.status, 200); assert.equal(response.headers.get('retry-after'), '7');
    assert.deepEqual(sent.body, body); assert.equal(sent.headers['x-inference-id'], inferenceId(body));
    assert.equal(sent.headers['x-runtime-job'], 'test-job');
  } finally { await proxy.close(); }
});
test('interrupted artifact upload replays a journaled native result without executing the agents twice', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dunkai-journal-'));
  let executions = 0, publications = 0;
  const runner = new Runner({ api: { request: async () => { publications++; if (publications === 1) throw new Error('Network interrupted'); } },
    engine: { async *run() { executions++; yield { event: 'complete', data: { data: { requirements: { objective: 'Native' } } } }; } },
    stateRoot: temp, outputRoot: temp, leaseToken: 'lease', mode: 'hosted', sandbox: true, log: () => {} });
  const job = { jobId: 'test-job', mode: 'hosted', payload: { action: 'run_workflow' } };
  try { await runner.execute(job); await runner.execute(job); assert.equal(executions, 1); assert.equal(publications, 2); }
  finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('native board publication reads the original designer dist folder and excludes fabrication files', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dunkai-native-board-'));
  const directory = path.join(temp, 'boards', 'native-design');
  await fs.mkdir(path.join(directory, 'dist'), { recursive: true });
  const files = { 'dist/circuit.json': '{"components":[]}', 'dist/schematic.svg': '<svg/>', 'dist/pcb.svg': '<svg/>', 'dist/bom.csv': 'Reference,Part\nR1,10k', 'dist/gerbers.zip': 'never upload', 'design-brief.md': '# Native board' };
  for (const [file, value] of Object.entries(files)) await fs.writeFile(path.join(directory, file), value);
  const published = [];
  const runner = new Runner({ api: { request: async (route, options) => { published.push({ route, ...options }); } }, outputRoot: path.join(temp, 'boards'), leaseToken: 'lease' });
  const job = { jobId: 'native-job', signal: new AbortController().signal };
  try {
    await runner.finish(job, { data: { board: { out_dir: directory } } });
    const kinds = published.filter((item) => item.route.includes('/artifacts/')).map((item) => item.route.split('/').at(-1));
    assert.deepEqual(kinds, ['circuitJson', 'schematicSvg', 'pcbSvg', 'bomCsv', 'designBrief']);
    assert.equal(published.find((item) => item.route.endsWith('/bomCsv')).body.toString(), files['dist/bom.csv']);
    assert.equal(published.at(-1).body.event, 'complete');
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('later agent turns preserve an inherited board without uploading it again', async () => {
  const published = [];
  const board = { generated_at: '2026-10-07', urls: { pcbSvg: '/uploads/boards/previous/pcb.svg' }, out_dir: '' };
  const runner = new Runner({ api: { request: async (route, options) => published.push({ route, ...options }) }, leaseToken: 'lease' });
  await runner.finish({ jobId: 'next-job', payload: { project: { board } }, signal: new AbortController().signal }, { data: { board: structuredClone(board), documentation: { content: 'Revised notes' } } });
  assert.equal(published.length, 1); assert.equal(published[0].body.event, 'complete');
});

test('persisted BOM rows become a private local CSV for the original PCB agent', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dunkai-csv-'));
  const input = { action: 'generate_pcb', project: { bom_csv_path: '/other-computer/private.csv', bom: { rows: [{ reference: 'U1', mfr_part: 'Part,"quoted"', lcsc: 'C123', package: 'QFN-32', build_quantity: 2 }] } } };
  try {
    const snapshot = await localizeSnapshot(input, temp);
    assert.notEqual(snapshot.payload.project.bom_csv_path, input.project.bom_csv_path);
    const csv = await fs.readFile(snapshot.payload.project.bom_csv_path, 'utf8');
    assert.match(csv, /"Part,""quoted"""/); assert.match(csv, /"C123"/);
    assert.equal((await fs.stat(snapshot.payload.project.bom_csv_path)).mode & 0o777, 0o600);
    await snapshot.cleanup(); await assert.rejects(fs.stat(snapshot.payload.project.bom_csv_path), { code: 'ENOENT' });
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test('a board job releases the previous supervisor memory before starting the designer', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dunkai-board-memory-'));
  const lifecycle = [], directory = path.join(temp, 'boards', 'design');
  await fs.mkdir(path.join(directory, 'dist'), { recursive: true });
  for (const name of ['circuit.json', 'schematic.svg', 'pcb.svg']) await fs.writeFile(path.join(directory, 'dist', name), name.endsWith('json') ? '{}' : '<svg/>');
  const runner = new Runner({ api: { request: async () => {} }, engine: {
    async stop() { lifecycle.push('stop'); }, async start() { lifecycle.push('start'); },
    async *run() { lifecycle.push('run'); yield { event: 'complete', data: { data: { board: { out_dir: directory } } } }; },
  }, stateRoot: temp, outputRoot: path.join(temp, 'boards'), leaseToken: 'lease', log: () => {} });
  try {
    await runner.execute({ jobId: 'board-memory', payload: { action: 'generate_board' } });
    assert.deepEqual(lifecycle, ['stop', 'start', 'run']); assert.equal(runner.ready, true);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
