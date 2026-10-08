import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export class RuntimeApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function validateBackend(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || (process.env.DUNKAI_ALLOW_LOCAL_BACKEND === 'true' && url.hostname === 'host.docker.internal');
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTPS backend URL, or HTTP localhost for development.');
  return url.origin;
}
export class ApiClient {
  constructor(origin, token = null, fetchImpl = fetch) { this.origin = validateBackend(origin); this.token = token; this.fetch = fetchImpl; }
  async raw(route, { method = 'GET', body, headers = {}, signal } = {}) {
    return this.fetch(this.origin + '/api/v1/runtime' + route, { method, redirect: 'error', headers: {
      ...(this.token ? { authorization: 'Bearer ' + this.token } : {}), ...headers,
      ...(body && !Buffer.isBuffer(body) ? { 'content-type': 'application/json' } : {}),
    }, body: body == null ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body), signal: signal || AbortSignal.timeout(30_000) });
  }
  async request(route, options) {
    const response = await this.raw(route, options);
    const data = await response.json();
    if (!response.ok) throw new RuntimeApiError(response.status, data.message || data.error?.message || 'Runtime request failed');
    return data.data;
  }
}
export const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(done, ms);
  function done() { signal?.removeEventListener('abort', aborted); resolve(); }
  function aborted() { clearTimeout(timer); reject(signal.reason); }
  signal?.addEventListener('abort', aborted, { once: true });
});
export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
export const inferenceId = (body) => createHash('sha256').update(canonicalJson(body)).digest('hex');
export async function* readSSE(stream) {
  const decoder = new TextDecoder(); let buffer = '';
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    if (buffer.length > 4 * 1024 * 1024) throw new Error('The engine returned an oversized event');
    let end;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const lines = block.split('\n');
      const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (data) yield { event: lines.find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message', data: JSON.parse(data) };
    }
  }
}
export async function containedArtifact(root, filename) {
  if (typeof filename !== 'string' || filename.includes('\0')) throw new Error('Invalid artifact path');
  const base = await fs.realpath(root);
  const target = await fs.realpath(filename);
  if (!target.startsWith(base + path.sep)) throw new Error('The engine artifact is outside its output folder');
  const stat = await fs.stat(target);
  if (!stat.isFile() || !stat.size || stat.size > 32 * 1024 * 1024) throw new Error('Invalid or oversized artifact file');
  return fs.readFile(target);
}
export async function savePrivateJson(filename, value) {
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const tmp = filename + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, filename);
}
