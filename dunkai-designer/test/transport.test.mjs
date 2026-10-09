import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOpenAICompatibleProvider } from '../src/providers/openai-compatible.mjs'
import { parseEvaluatorOutput } from '../src/lib/isolated-build.mjs'

test('sandbox protocol tolerates blank compiler lines and still forwards progress', () => {
  const stages = []
  const summary = { ev: 'sandbox_result', outDir: '/data/boards/design/dist', stats: { errors: 0 } }
  assert.deepEqual(parseEvaluatorOutput('\n{"ev":"stage","stage":"E"}\n\n  \n' + JSON.stringify(summary) + '\n', e => stages.push(e)), summary)
  assert.deepEqual(stages, [{ ev: 'stage', stage: 'E' }])
  assert.throws(() => parseEvaluatorOutput('\n \n'), /returned no result/)
  assert.throws(() => parseEvaluatorOutput('{"ev":"sandbox_result"'), /incomplete or invalid JSON/)
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
