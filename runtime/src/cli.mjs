import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ApiClient, savePrivateJson, sleep } from './transport.mjs';
import { NativeEngine } from './engine.mjs';
import { startProxy } from './proxy.mjs';
import { Runner } from './runner.mjs';

const stateRoot = process.env.DUNKAI_STATE_DIR || '/data/runtime';
await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
const configFile = path.join(stateRoot, 'connection.json');
let config;
try { config = JSON.parse(await fs.readFile(configFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const backend = process.env.DUNKAI_BACKEND_URL || config?.backend;
if (!backend) throw new Error('Set DUNKAI_BACKEND_URL to your Node backend URL in runtime.env.');
const api = new ApiClient(backend);
if (config?.backend !== api.origin) config = null;
if (!config?.token) {
  const pairing = await api.request('/pairing', { method: 'POST', body: { name: process.env.DUNKAI_DEVICE_NAME || os.hostname() } });
  console.log('\nOpen DunkAI → Settings → This computer, then enter: ' + pairing.userCode + '\n');
  const deadline = Date.now() + pairing.expiresIn * 1000;
  while (Date.now() < deadline) {
    const result = await api.request('/pairing/poll', { method: 'POST', body: { deviceCode: pairing.deviceCode } });
    if (result.status === 'approved') {
      config = { backend: api.origin, token: result.token, leaseToken: randomBytes(32).toString('hex') };
      await savePrivateJson(configFile, config); break;
    }
    await sleep(pairing.interval * 1000);
  }
  if (!config?.token) throw new Error('Pairing expired. Start the runtime again to get a new code.');
}
api.token = config.token;
const sandboxCheck = spawnSync('bwrap', ['--unshare-all', '--die-with-parent', '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib', '--symlink', 'usr/lib64', '/lib64', '--symlink', 'usr/bin', '/bin', '--proc', '/proc', '--dev', '/dev', '--', '/usr/bin/true'], { encoding: 'utf8' });
if (sandboxCheck.status !== 0) throw new Error('The PCB sandbox could not start. Use the provided Docker launcher; never disable BOARD_SANDBOX_REQUIRED. ' + (sandboxCheck.stderr || '').slice(0, 400));
let runner;
const localKey = randomBytes(32).toString('hex');
const proxy = await startProxy({ api, localKey, activeJob: () => runner?.active, leaseToken: config.leaseToken });
const byokKey = process.env.DUNKAI_GROQ_API_KEY || '';
const outputRoot = process.env.DESIGNER_OUTPUT_ROOT || '/data/boards';
const engine = new NativeEngine({ enginePath: process.env.DUNKAI_ENGINE_PATH || '/srv/ai_engine', proxyUrl: proxy.origin, localKey, byokKey,
  model: process.env.DUNKAI_GROQ_MODEL || 'openai/gpt-oss-120b', outputRoot });
runner = new Runner({ api, engine, leaseToken: config.leaseToken, stateRoot, outputRoot, mode: byokKey ? 'byok' : 'hosted', sandbox: true });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => runner.stop());
try { await runner.run(); }
catch (error) {
  if ([401, 403].includes(error.status)) { await fs.rm(configFile, { force: true }); console.error('Connection expired or revoked. Restart the runtime and pair it again.'); }
  else console.error(error.message);
  process.exitCode = 1;
} finally { await proxy.close(); }
