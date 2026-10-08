/**
 * Board-generation options offered in the UI.
 *
 * This list mirrors dunkai-designer's provider registry (src/providers/index.mjs)
 * and BOARD_PROVIDERS in backend/src/config/providers.js. They have to agree:
 * the designer throws on an unknown name, and the backend validator turns that
 * into a 400 before a job is ever started.
 *
 * An OPTION is not the same thing as a provider. One provider could appear more
 * than once when the model is the real choice, so each entry carries its own `id` for the
 * select and localStorage, plus the `provider`/`model` pair actually sent to the
 * backend. Only `provider` is whitelisted server-side; `model` is validated by
 * the designer, which refuses anything above the 4.5 generation.
 *
 * `hint` is shown next to the name because the trade-off here is not abstract —
 * claude-code is the only agentic provider and the only one that has produced a
 * board that routed, while the OpenAI-compatible three are ~100x cheaper per run.
 */

export type BoardProviderId = 'claude-code' | 'anthropic' | 'gemini' | 'groq' | 'ollama' | 'openai'

export interface BoardProvider {
  /** Select value and localStorage key. Unique per OPTION, not per provider. */
  id: BoardProviderId
  /** The designer provider name sent to the backend. */
  provider: string
  /** Passed through as --model. Omitted means the provider's own default. */
  model?: string
  label: string
  hint: string
  /** The BYOK provider whose key pays for this option, when it takes one. */
  byok?: 'groq' | 'gemini' | 'anthropic' | 'openai'
}

export const BOARD_PROVIDERS: readonly BoardProvider[] = [
  {
    id: 'openai',
    provider: 'openai',
    model: 'gpt-4.1',
    label: 'GPT-4.1',
    hint: 'PCB generation using your OpenAI API key.',
    byok: 'openai',
  },
  {
    id: 'claude-code',
    provider: 'claude-code',
    label: 'Claude Code',
    hint: 'Agentic — writes and repairs the board itself. Highest quality, highest cost.',
  },
  // Whether an option can actually run for this user — their own key, a key
  // on the server, the Claude Code CLI on the engine host — is decided by the
  // backend (GET /ai/providers) and shown next to each option in Settings.
  {
    id: 'anthropic',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    label: 'Claude Sonnet 4.5',
    hint: 'Claude via the API, one shot per stage. Strong layouts without the agentic loop.',
    byok: 'anthropic',
  },
  {
    id: 'groq',
    provider: 'groq',
    label: 'Groq',
    hint: 'Fastest. Good structural results on gpt-oss-120b.',
    byok: 'groq',
  },
  {
    id: 'ollama',
    provider: 'ollama',
    label: 'Ollama',
    hint: 'Cloud or a local daemon. Free tier covers gpt-oss:120b.',
  },
  {
    id: 'gemini',
    provider: 'gemini',
    label: 'Gemini',
    hint: 'Large context. Free-tier flash capacity is unreliable.',
    byok: 'gemini',
  },
] as const

export const DEFAULT_BOARD_PROVIDER: BoardProviderId = 'groq'

export const PROVIDER_STORAGE_KEY = 'dunkai-board-provider'

export const isBoardProviderId = (value: unknown): value is BoardProviderId =>
  typeof value === 'string' && BOARD_PROVIDERS.some((p) => p.id === value)

/**
 * The stored default, read defensively: localStorage throws in a private
 * window and can hold an option id from an older build that no longer exists.
 *
 * Read at the moment a run starts rather than cached in component state. The
 * choice is configured in Settings now, on a different route from the workspace
 * that consumes it, so a cached copy would be one navigation out of date.
 */
export const readStoredBoardProvider = (): BoardProviderId => {
  if (typeof window === 'undefined') return DEFAULT_BOARD_PROVIDER
  try {
    const saved = window.localStorage.getItem(PROVIDER_STORAGE_KEY)
    return isBoardProviderId(saved) ? saved : DEFAULT_BOARD_PROVIDER
  } catch {
    return DEFAULT_BOARD_PROVIDER
  }
}

/**
 * True once the user has picked a model in Settings. Until then a board run
 * sends no provider, and the server's DESIGNER_PROVIDER decides — on a hosted
 * deployment that is something the server can run, which the client-side
 * default (claude-code, which needs a CLI on the engine host) may not be.
 */
export const hasStoredBoardProvider = (): boolean => {
  if (typeof window === 'undefined') return false
  try {
    return isBoardProviderId(window.localStorage.getItem(PROVIDER_STORAGE_KEY))
  } catch {
    return false
  }
}

export const writeStoredBoardProvider = (id: BoardProviderId): void => {
  try {
    window.localStorage.setItem(PROVIDER_STORAGE_KEY, id)
  } catch {
    // A remembered preference is a convenience; losing it must not break a run.
  }
}

/** The {provider, model} pair to send for an option id. */
export const boardProviderRequest = (
  id: BoardProviderId
): { provider: string; model?: string } => {
  const option = BOARD_PROVIDERS.find((p) => p.id === id)
  // Falling back to the id keeps a stale localStorage value working as the
  // provider name it used to be, rather than starting a job with no provider.
  if (!option) return { provider: id }
  return option.model ? { provider: option.provider, model: option.model } : { provider: option.provider }
}
