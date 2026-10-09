/** Auto follows the chat model; the other options are explicit PCB overrides. */

export type BoardProviderId = 'auto' | 'claude-code' | 'anthropic' | 'gemini' | 'groq' | 'ollama' | 'openai'

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
    id: 'auto', provider: 'auto', label: 'Auto · chat model',
    hint: 'Uses the model selected in the chat for the entire design and PCB pipeline.',
  },
  {
    id: 'openai',
    provider: 'openai',
    model: 'gpt-4.1',
    label: 'OpenAI',
    hint: 'Uses your selected GPT chat model and OpenAI key. Auto follows any chat provider.',
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

export const DEFAULT_BOARD_PROVIDER: BoardProviderId = 'auto'

// Previous builds persisted the server's Groq default. Start those clients on
// Auto, so a stale preference cannot override their current chat model.
export const PROVIDER_STORAGE_KEY = 'dunkai-board-provider-v2'

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

/** Whether a user has saved a choice in the current settings version. */
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
  id: BoardProviderId,
  chatModel?: string
): { provider: string; model?: string } => {
  if (id === 'auto') return { provider: 'auto', ...(chatModel ? { model: chatModel } : {}) }
  const option = BOARD_PROVIDERS.find((p) => p.id === id)
  if (!option) return boardProviderRequest('auto', chatModel)
  // Selecting a provider must not reset GPT mini to GPT-4.1, or Groq 20B to
  // 120B. An explicit override within the chat's provider keeps its model.
  if (chatModel && ((id === 'openai' && chatModel.startsWith('gpt-')) || (id === 'groq' && !chatModel.startsWith('gpt-')))) {
    return { provider: option.provider, model: chatModel }
  }
  return option.model ? { provider: option.provider, model: option.model } : { provider: option.provider }
}
