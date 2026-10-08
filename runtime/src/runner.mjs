import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { containedArtifact, savePrivateJson, sleep, RuntimeApiError } from './transport.mjs';

// The original designer writes previews/manufacturing data under dist/ and
// its brief/resolution alongside board.tsx in the work directory.
const FILES = { circuitJson: 'dist/circuit.json', schematicSvg: 'dist/schematic.svg', pcbSvg: 'dist/pcb.svg', boardGlb: 'dist/board.glb', boardGltfJson: 'dist/board.gltf.json', bomCsv: 'dist/bom.csv', pickAndPlaceCsv: 'dist/pick-and-place.csv', designBrief: 'design-brief.md', resolution: 'resolution.json' };
export class Runner {
  constructor({ api, engine, leaseToken, stateRoot, outputRoot, mode, sandbox, log = console.log }) {
    Object.assign(this, { api, engine, leaseToken, stateRoot, outputRoot, mode, sandbox, log });
    this.active = null; this.ready = false; this.shutdown = new AbortController();
  }
  async postEvent(job, event, data, sequence = 0) {
    return this.api.request('/jobs/' + job.jobId + '/events', { method: 'POST', headers: { 'x-runtime-lease': this.leaseToken }, body: { event, data, sequence }, signal: AbortSignal.any([job.signal, AbortSignal.timeout(30_000)]) });
  }
  async heartbeat() {
    try {
      const result = await this.api.request('/heartbeat', { method: 'POST', body: { ready: this.ready, mode: this.mode, capabilities: { boardSandbox: this.sandbox, version: '1.0.0' }, ...(this.active ? { jobId: this.active.jobId, leaseToken: this.leaseToken } : {}) } });
      if (this.active && !['running', 'completing'].includes(result.status)) this.active.controller.abort(new Error('Job ' + result.status));
      this.lastHeartbeat = Date.now();
    } catch (error) {
      if (error.status === 401 || error.status === 403) { this.shutdown.abort(error); this.active?.controller.abort(error); }
      else if (this.active && ([404, 409].includes(error.status) || Date.now() - this.lastHeartbeat > 35_000)) this.active.controller.abort(new Error('The computer lost its job connection'));
      if (!this.active) this.log('Connection: ' + error.message);
    }
  }
  async finish(job, result) {
    const data = result.data || result;
    if (data.board && !isDeepStrictEqual(data.board, job.payload?.project?.board)) {
      const directory = data.board.out_dir;
      if (typeof directory !== 'string') throw new Error('The original engine did not return its board output folder');
      const safeDir = await fs.realpath(directory), base = await fs.realpath(this.outputRoot);
      if (!safeDir.startsWith(base + path.sep)) throw new Error('Board output is outside the runtime workspace');
      for (const [kind, filename] of Object.entries(FILES)) {
        const target = path.join(safeDir, filename);
        try { await fs.lstat(target); } catch (error) { if (error.code === 'ENOENT' && !['circuitJson', 'schematicSvg', 'pcbSvg'].includes(kind)) continue; throw error; }
        const bytes = await containedArtifact(this.outputRoot, target);
        await this.api.request('/jobs/' + job.jobId + '/artifacts/' + kind, { method: 'POST', body: bytes,
          headers: { 'content-type': 'application/octet-stream', 'x-runtime-lease': this.leaseToken }, signal: AbortSignal.any([job.signal, AbortSignal.timeout(60_000)]) });
      }
    }
    await this.postEvent(job, 'complete', result);
  }
  async execute(claimed) {
    const controller = new AbortController(), job = { ...claimed, controller, signal: controller.signal };
    this.active = job; let sequence = claimed.eventSequence || 0;
    const journal = path.join(this.stateRoot, 'results', job.jobId + '.json');
    try {
      this.log('Running ' + job.payload.action + ' on this computer…');
      let saved;
      try { saved = JSON.parse(await fs.readFile(journal, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (saved) { await this.finish(job, saved); await fs.rm(journal, { force: true }); this.log('Design saved to your account.'); return; }
      if (job.payload.action === 'generate_board') {
        // The previous component job can leave the catalogue, FAISS index
        // and embedding model resident. The board job consumes its saved IR
        // and needs none of them: restart the same original supervisor to
        // free that RAM before the Node designer starts.
        this.ready = false; await this.engine.stop();
        await this.engine.start(job.signal); this.ready = true;
      }
      let completed = false;
      for await (const event of this.engine.run(job.payload, job.signal)) {
        if (event.event === 'progress') { await this.postEvent(job, 'progress', event.data, ++sequence); }
        else if (event.event === 'complete') {
          await savePrivateJson(journal, event.data);
          await this.finish(job, event.data); completed = true; break;
        } else if (event.event === 'error') {
          throw new Error(event.data.error || 'AI engine failed');
        }
      }
      if (!completed) throw new Error('The engine closed without returning a completed result');
      await fs.rm(journal, { force: true });
      this.log('Design saved to your account.');
    } catch (error) {
      if (!job.signal.aborted) {
        // Preserve a completed journal on a temporary upload outage. Claiming
        // the same lease retries publication without another model request.
        const recoverable = !(error instanceof RuntimeApiError) || error.status >= 500;
        const hasResult = await fs.access(journal).then(() => true, () => false);
        if (hasResult && recoverable) { this.log('Upload interrupted; retrying the saved result…'); return; }
        await this.postEvent(job, 'error', { error: error.message }).catch(() => {});
      }
      this.log(error.message);
      this.ready = false; await this.engine.stop();
      if (!this.shutdown.signal.aborted) { await this.engine.start(this.shutdown.signal); this.ready = true; }
    } finally { this.active = null; }
  }
  async run() {
    this.lastHeartbeat = Date.now();
    const timer = setInterval(() => { if (!this.beating) { this.beating = this.heartbeat().finally(() => { this.beating = null; }); } }, 10_000);
    try {
      await this.heartbeat(); await this.engine.start(this.shutdown.signal); this.ready = true; await this.heartbeat();
      this.log('DunkAI Runtime connected. Keep this window open while generating designs.');
      while (!this.shutdown.signal.aborted) {
        try {
          const job = await this.api.request('/jobs/claim', { method: 'POST', body: { leaseToken: this.leaseToken } });
          if (job) await this.execute(job);
        } catch (error) {
          if ([401, 403].includes(error.status)) throw error;
          this.log('Waiting for connection: ' + error.message);
        }
        await sleep(2000, this.shutdown.signal);
      }
    } finally { clearInterval(timer); this.ready = false; await this.engine.stop(); await this.heartbeat().catch(() => {}); }
  }
  stop() { this.shutdown.abort(new Error('Runtime stopped')); this.active?.controller.abort(new Error('Runtime stopped')); }
}
