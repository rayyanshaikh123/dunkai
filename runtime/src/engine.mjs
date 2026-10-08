import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { sleep, readSSE } from './transport.mjs';
import { localizeSnapshot } from './snapshot.mjs';
import path from 'node:path';

export class NativeEngine {
  constructor({ enginePath, proxyUrl, localKey, byokKey, model, outputRoot, port = 8000 }) {
    Object.assign(this, { enginePath, proxyUrl, localKey, byokKey, model, outputRoot, port });
    this.token = randomBytes(32).toString('hex'); this.process = null;
    this.origin = 'http://127.0.0.1:' + port;
  }
  async start(signal) {
    if (this.process) return;
    const env = { ...process.env, SUPERVISOR_HOST: '127.0.0.1', PORT: String(this.port), SUPERVISOR_AGENT_TOKEN: this.token,
      BOARD_SANDBOX_REQUIRED: 'true', DESIGNER_OUTPUT_ROOT: this.outputRoot,
      DUNKAI_DATASET_BASE_URL: this.proxyUrl + '/dataset',
      GROQ_API_KEY: this.byokKey || this.localKey, GROQ_MODEL: this.model, DESIGNER_GROQ_MODEL: this.model,
      // Both libraries already support an OpenAI-compatible base URL.
      // Groq's Python SDK appends /openai/v1 itself. The designer uses the
      // OpenAI SDK, which instead requires that prefix in its base URL.
      GROQ_API_BASE: this.byokKey ? 'https://api.groq.com' : this.proxyUrl,
      GROQ_BASE_URL: this.byokKey ? 'https://api.groq.com/openai/v1' : this.proxyUrl + '/openai/v1',
      OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', TOKENIZERS_PARALLELISM: 'false',
    };
    // Never pass operator keys into the engine or generated code.
    delete env.HF_TOKEN; delete env.HF_TOKEN_READ; delete env.DUNKAI_GROQ_API_KEY;
    const command = process.env.DUNKAI_PYTHON || 'python';
    const executable = command.includes('/') ? path.resolve(command) : command;
    this.process = spawn(executable, ['-m', 'agents.supervisor.server'], { cwd: this.enginePath, env, detached: true, stdio: ['ignore', 'inherit', 'inherit'] });
    const child = this.process;
    let startupError; child.once('error', (error) => { startupError = error; });
    child.once('exit', () => { if (this.process === child) this.process = null; });
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (startupError) throw startupError;
      if (child.exitCode !== null) throw new Error('The AI engine failed to start. Check the runtime output above.');
      try { const response = await fetch(this.origin + '/health', { signal: AbortSignal.timeout(3000) }); if (response.ok) return; } catch {}
      await sleep(1000, signal);
    }
    await this.stop(); throw new Error('AI engine startup timed out while loading its component catalogue.');
  }
  async stop() {
    const child = this.process; this.process = null;
    if (!child?.pid) return;
    const kill = (signal) => { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
    kill('SIGTERM');
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(3000)]);
    // The group includes any designer subprocess, even if Python exited first.
    kill('SIGKILL');
  }
  async *run(payload, signal) {
    const headers = { 'content-type': 'application/json', authorization: 'Bearer ' + this.token };
    if (payload.action === 'code-chat') {
      const response = await fetch(this.origin + '/api/v1/supervisor/code-chat', { method: 'POST', headers, signal, body: JSON.stringify({ files: payload.files, messages: payload.messages, model: payload.model }) });
      if (!response.ok) throw new Error('The code agent failed (HTTP ' + response.status + ')');
      yield { event: 'complete', data: { data: await response.json() } }; return;
    }
    const snapshot = await localizeSnapshot(payload);
    try {
      const response = await fetch(this.origin + '/api/v1/supervisor/stream', { method: 'POST', headers, body: JSON.stringify(snapshot.payload), signal });
      if (!response.ok) throw new Error('The AI engine rejected this job (HTTP ' + response.status + ')');
      yield* readSSE(response.body);
    } finally { await snapshot.cleanup(); }
  }
}
