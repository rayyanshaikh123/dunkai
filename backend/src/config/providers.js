/**
 * Providers a user can bring their own key for (BYOK), and the board
 * generators that consume them.
 *
 * BYOK_PROVIDERS is limited to what the AI engine actually reads: Groq runs
 * every agent in the design pipeline (and can build boards), Gemini and
 * Anthropic build boards via dunkai-designer. The old Settings panel also
 * OpenAI powers the design pipeline and GPT PCB generation.
 *
 * `verify` is a cheap authenticated read (list models) that tells a working
 * key from a mistyped one at save time, instead of three minutes into a run.
 */
export const BYOK_PROVIDERS = {
  openai: {
    label: 'OpenAI (GPT)',
    powers: 'GPT design chat, all pipeline agents, code chat, and PCB generation',
    verify: (key) => ({
      url: 'https://api.openai.com/v1/models',
      headers: { authorization: `Bearer ${key}` },
    }),
  },
  groq: {
    label: 'Groq',
    powers: 'Design chat, all pipeline agents, and Groq board generation',
    verify: (key) => ({
      url: 'https://api.groq.com/openai/v1/models',
      headers: { authorization: `Bearer ${key}` },
    }),
  },
  gemini: {
    label: 'Google Gemini',
    powers: 'Gemini board generation',
    verify: (key) => ({
      url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',
      headers: { 'x-goog-api-key': key },
    }),
  },
  anthropic: {
    label: 'Anthropic',
    powers: 'Claude board generation',
    verify: (key) => ({
      url: 'https://api.anthropic.com/v1/models?limit=1',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    }),
  },
};

export const BYOK_PROVIDER_IDS = Object.keys(BYOK_PROVIDERS);

export const OPENAI_PIPELINE_MODELS = Object.freeze(['gpt-4.1', 'gpt-4.1-mini']);
export const pipelineProviderForModel = (model) => typeof model === 'string' && model.startsWith('gpt-') ? 'openai' : 'groq';

/**
 * Board generators (dunkai-designer --provider). `credential` is the key a
 * provider bills; `claude-code` has none — it spends the operator's Claude Code
 * subscription through a CLI that must be installed on the AI engine's host.
 *
 * Mirrors dunkai-designer/src/providers/index.mjs, the validator in
 * validators/ai.validators.js, and frontend/lib/providers.ts.
 */
export const BOARD_PROVIDERS = {
  openai: { label: 'OpenAI (GPT)', credential: 'openai' },
  'claude-code': { label: 'Claude Code', credential: null },
  groq: { label: 'Groq', credential: 'groq' },
  gemini: { label: 'Gemini', credential: 'gemini' },
  anthropic: { label: 'Anthropic', credential: 'anthropic' },
  ollama: { label: 'Ollama', credential: 'ollama' },
};

export const BOARD_PROVIDER_IDS = Object.keys(BOARD_PROVIDERS);
