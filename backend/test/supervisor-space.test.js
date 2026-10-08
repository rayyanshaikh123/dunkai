import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let status = 200;
const requests = [];
const server = http.createServer(async (req, res) => {
  let text = ''; for await (const part of req) text += part;
  requests.push({ url: req.url, headers: req.headers, body: text ? JSON.parse(text) : null });
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(status === 200
    ? { data: req.url.endsWith('/capabilities') ? { board_providers: { groq: false }, pcb_unavailable_reason: 'Sandbox unavailable' } : { answer: 'Original requirements' } }
    : { detail: 'PCB sandbox unavailable' }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
process.env.LOCAL_RUNTIME_ENABLED = 'false';
process.env.SUPERVISOR_AGENT_URL = `http://127.0.0.1:${server.address().port}`;
process.env.SUPERVISOR_AGENT_PATH = '/api/v1/supervisor';
process.env.SUPERVISOR_HF_TOKEN = 'hf_read_fixture';
process.env.SUPERVISOR_AGENT_TOKEN = 'shared_engine_fixture';
const supervisor = await import('../src/services/supervisor.service.js');
after(async () => { await new Promise(resolve => server.close(resolve)); });

test('Space calls separate Hugging Face auth from engine auth and preserve the original agent request', async () => {
  const result = await supervisor.callSupervisor({ action: 'chat', project: { name: 'Sensor' }, messages: [{ role: 'user', content: 'USB sensor' }], agentType: 'requirement', provider: 'groq', model: 'test-model' });
  assert.equal(result.answer, 'Original requirements');
  const req = requests.at(-1);
  assert.equal(req.headers.authorization, 'Bearer hf_read_fixture');
  assert.equal(req.headers['x-supervisor-token'], 'shared_engine_fixture');
  assert.equal(req.body.agentType, 'requirement');
  assert.equal(req.body.model, 'test-model');
});
test('capabilities retain the PCB readiness failure for the website', async () => {
  const caps = await supervisor.getCapabilities();
  assert.equal(caps.board_providers.groq, false);
  assert.equal(caps.pcb_unavailable_reason, 'Sandbox unavailable');
  const { authorizeBoardProvider, boardProviderStatus } = await import('../src/services/billing.service.js');
  await assert.rejects(authorizeBoardProvider({}, 'groq', new Set()), { statusCode: 503, message: 'Sandbox unavailable' });
  const status = await boardProviderStatus({}, new Set());
  assert.equal(status.find(provider => provider.id === 'groq').reason, 'Sandbox unavailable');
});
test('blocked sandbox and busy responses reach users with useful messages', async () => {
  for (const code of [503, 429]) {
    status = code;
    await assert.rejects(supervisor.callSupervisor({ action: 'generate_board' }), { statusCode: code, message: 'PCB sandbox unavailable' });
  }
});
