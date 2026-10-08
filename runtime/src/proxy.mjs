import http from 'node:http';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { inferenceId } from './transport.mjs';

export async function startProxy({ api, localKey, activeJob, leaseToken }) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && /^\/dataset\/(components_ml\.parquet|component_embeddings\.npy|component_faiss\.index)$/.test(req.url)) {
        const upstream = await api.raw(req.url, { signal: AbortSignal.timeout(300_000) });
        res.writeHead(upstream.status, { 'content-type': 'application/octet-stream' });
        await pipeline(Readable.fromWeb(upstream.body), res); return;
      }
      if (req.method !== 'POST' || req.url !== '/openai/v1/chat/completions' || req.headers.authorization !== 'Bearer ' + localKey) { res.writeHead(403); res.end(); return; }
      const job = activeJob();
      if (!job || job.mode !== 'hosted' || job.signal.aborted) { res.writeHead(409); res.end(JSON.stringify({ error: { message: 'No active hosted job' } })); return; }
      let size = 0; const parts = [];
      for await (const part of req) { size += part.length; if (size > 128_000) throw new Error('Model request too large'); parts.push(part); }
      const body = JSON.parse(Buffer.concat(parts).toString());
      const upstream = await api.raw('/openai/v1/chat/completions', { method: 'POST', body,
        headers: { 'x-runtime-job': job.jobId, 'x-runtime-lease': leaseToken, 'x-inference-id': inferenceId(body) },
        signal: AbortSignal.any([job.signal, AbortSignal.timeout(135_000)]),
      });
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-store',
        ...(upstream.headers.get('retry-after') ? { 'retry-after': upstream.headers.get('retry-after') } : {}),
      });
      await pipeline(Readable.fromWeb(upstream.body), res);
    } catch (error) {
      if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json' });
      if (!res.writableEnded) res.end(JSON.stringify({ error: { message: error.status ? error.message : 'The local inference connection failed' } }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { origin: 'http://127.0.0.1:' + server.address().port, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}
