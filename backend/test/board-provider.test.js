import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBoardSelection } from '../src/config/providers.js';

test('Auto and omitted providers follow each exact chat model', () => {
  for (const model of ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b', 'gpt-4.1', 'gpt-4.1-mini']) {
    const expected = { model, provider: model.startsWith('gpt-') ? 'openai' : 'groq' };
    assert.deepEqual(resolveBoardSelection({ provider: 'auto', model }), expected);
    assert.deepEqual(resolveBoardSelection({ chatModel: model }), expected);
  }
  assert.deepEqual(resolveBoardSelection(), { provider: 'groq', model: 'openai/gpt-oss-120b' });
  assert.deepEqual(resolveBoardSelection({ model: 'gpt-4.1-mini', chatModel: 'openai/gpt-oss-120b' }), { provider: 'openai', model: 'gpt-4.1-mini' });
});

test('explicit PCB overrides retain their own provider and model', () => {
  assert.deepEqual(resolveBoardSelection({ provider: 'anthropic', model: 'claude-sonnet-4-5', chatModel: 'gpt-4.1-mini' }), { provider: 'anthropic', model: 'claude-sonnet-4-5' });
});
