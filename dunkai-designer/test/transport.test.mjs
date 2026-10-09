import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenAICompatibleProvider } from '../src/providers/openai-compatible.mjs'
import { buildOutputsIsolated } from '../src/lib/isolated-build.mjs'
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

test('real compiler completion survives discarded stdout; a subsequent no-op cannot reuse the previous result', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'dunkai-compiler-test-'))
  const original = { ...process.env }
  const launcher = path.join(work, 'silent-launcher.mjs')
  // Only the test substitutes a launcher: production continues to enforce
  // Landlock/seccomp. Reproduce its lost stdout using the real PCB compiler.
  await writeFile(launcher, `#!${process.execPath}\nimport {spawnSync} from 'node:child_process';
const [node, root, work, worker] = process.argv.slice(4);
const result = spawnSync(node, [worker, work], {cwd: root, stdio: ['ignore', 'ignore', 'pipe']});
process.stderr.write(result.stderr || ''); process.exit(result.error ? 1 : result.status);`, { mode: 0o700 })
  await writeFile(path.join(work, 'index.tsx'), 'export default () => <board width="20mm" height="20mm"><resistor name="R1" resistance="1k" footprint="0402" /></board>')
  Object.assign(process.env, { BOARD_SANDBOX_REQUIRED: 'true', BOARD_SANDBOX_BACKEND: 'landlock-seccomp', BOARD_SANDBOX_PYTHON: launcher })
  try {
    const result = await buildOutputsIsolated(work)
    assert.equal(result.stats.components, 1)
    assert.equal(result.stats.errors, 0)
    assert.ok(result.circuitJson.some(e => e.type === 'pcb_board'))
    assert.match(await readFile(path.join(work, 'dist', 'pcb.svg'), 'utf8'), /<svg/)
    await writeFile(launcher, `#!${process.execPath}\nprocess.exit(0);`)
    await assert.rejects(buildOutputsIsolated(work), /did not commit a complete result/)
  } finally {
    for (const key of ['BOARD_SANDBOX_REQUIRED', 'BOARD_SANDBOX_BACKEND', 'BOARD_SANDBOX_PYTHON']) {
      if (original[key] === undefined) delete process.env[key]
      else process.env[key] = original[key]
    }
    await rm(work, { recursive: true, force: true })
  }
})

test('empty and truncated provider responses retry using the same provider, model and key', async () => {
  const originalFetch = globalThis.fetch
  const originalKey = process.env.GROQ_API_KEY
  process.env.GROQ_API_KEY = 'test-groq-key'
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) })
    return new Response(calls.length === 1 ? '' : calls.length === 2 ? '{"choices":' : JSON.stringify({
      choices: [{ message: { content: '{"answers":{"q1":"1"}}' }, finish_reason: 'stop' }],
    }), { headers: { 'retry-after': '0.001' } })
  }
  try {
    const provider = createOpenAICompatibleProvider('groq', { model: 'openai/gpt-oss-20b' })
    assert.deepEqual(await provider.answerPinQuestions([]), { q1: '1' })
    assert.equal(calls.length, 3)
    assert.ok(calls.every(c => c.body.model === 'openai/gpt-oss-20b' && c.options.headers.Authorization === 'Bearer test-groq-key' && c.url.startsWith('https://api.groq.com/')))
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.GROQ_API_KEY
    else process.env.GROQ_API_KEY = originalKey
  }
})

test('invalid responses exhaust bounded retries with a readable error; GPT mini remains selected', async () => {
  const originalFetch = globalThis.fetch
  const originalKey = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = 'test-openai-key'
  const calls = []
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body))
    return new Response('', { headers: { 'retry-after': '0.001' } })
  }
  try {
    const provider = createOpenAICompatibleProvider('openai', { model: 'gpt-4.1-mini' })
    await assert.rejects(provider.answerPinQuestions([]), /OpenAI returned an empty or incomplete JSON response/)
    assert.equal(calls.length, 4)
    assert.ok(calls.every(c => c.model === 'gpt-4.1-mini'))
  } finally {
    globalThis.fetch = originalFetch
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = originalKey
  }
})
