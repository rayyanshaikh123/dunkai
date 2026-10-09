/**
 * openai-compatible provider — Gemini, Groq and Ollama behind one adapter.
 *
 * All three speak the OpenAI /chat/completions shape, so the transport is
 * written once and each target contributes only a base URL, a key variable and
 * a default model. That is deliberate: three SDKs would have meant three
 * dependency trees and three retry behaviours to keep straight, and this
 * project already reaches the network with the runtime's own fetch.
 *
 * Everything ABOVE the transport — the prompts, the {files:{...}} contract, the
 * syntax check and the path-escape check before anything is written — lives in
 * chat-provider.mjs and is shared with the Anthropic provider. The hard
 * difference from the claude-code provider is NOT the model, it is agency:
 * `claude-code` is handed a directory and writes the board itself, while a chat
 * API returns file contents that this side has to validate and write.
 */

import { note } from "../lib/events.mjs"
import { createChatProvider, backoffMs, sleep } from "./chat-provider.mjs"

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Per-target configuration.
 *
 * `keyRequired: false` covers a local Ollama daemon, which authenticates
 * nothing; the same code path then serves Ollama Cloud when a key is present.
 */
const TARGETS = {
  openai: {
    label: "OpenAI",
    baseUrl: () => process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    keyVar: "OPENAI_API_KEY",
    keyRequired: true,
    defaultModel: () => process.env.DESIGNER_OPENAI_MODEL ?? "gpt-4.1",
  },
  gemini: {
    label: "Google Gemini",
    baseUrl: () =>
      process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta/openai",
    keyVar: "GEMINI_API_KEY",
    keyRequired: true,
    defaultModel: () => process.env.GEMINI_MODEL ?? "gemini-3.5-flash",
  },
  groq: {
    label: "Groq",
    baseUrl: () => process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1",
    keyVar: "GROQ_API_KEY",
    keyRequired: true,
    // DESIGNER_GROQ_MODEL is separate from GROQ_MODEL on purpose: GROQ_MODEL
    // belongs to the Python requirement/architecture agents, and board
    // generation is a different job that may want a different model.
    defaultModel: () =>
      process.env.DESIGNER_GROQ_MODEL ?? process.env.GROQ_MODEL ?? "openai/gpt-oss-120b",
  },
  ollama: {
    label: "Ollama",
    baseUrl: () =>
      `${(process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/+$/, "")}/v1`,
    keyVar: "OLLAMA_API_KEY",
    keyRequired: false,
    defaultModel: () => process.env.OLLAMA_MODEL ?? "gpt-oss:120b",
  },
}

export const OPENAI_COMPATIBLE_TARGETS = Object.keys(TARGETS)

const isRetryableMessage = (message) => /HTTP (429|5\d\d)/.test(message)

/**
 * Whether a thrown error is worth another attempt.
 *
 * Node's fetch reports every transport failure as a bare `TypeError: fetch
 * failed` — a reset connection, a DNS blip, a dropped TLS handshake all look
 * identical and all are transient. A real run died at stage D on one of these
 * with no retry at all, which threw away the minutes the earlier stages spent.
 * The useful detail is on `err.cause`, so it gets pulled into the message.
 */
function transportFailure(err) {
  if (err?.name === "AbortError") return null
  const isNetwork = err instanceof TypeError || /fetch failed|socket hang up|ECONN|ETIMEDOUT|EAI_AGAIN/i.test(err?.message ?? "")
  if (!isNetwork) return null
  const cause = err?.cause
  const detail = cause?.code ?? cause?.message ?? err.message
  return `network failure talking to the provider: ${detail}`
}

function createClient(target, { model, timeoutMs, maxTokens }) {
  const cfg = TARGETS[target]
  const apiKey = process.env[cfg.keyVar]

  if (cfg.keyRequired && !apiKey) {
    throw new Error(
      `${cfg.label} provider needs ${cfg.keyVar}. The designer inherits its ` +
        `environment from the supervisor, so set it in dunkai/.env (the file ` +
        `load_dotenv() resolves) and restart the supervisor.`
    )
  }

  /**
   * One chat completion, with retries.
   *
   * 429 and 5xx are retried because they are routine on these endpoints rather
   * than exceptional — Gemini in particular answers 503 "experiencing high
   * demand" under load, and losing a board run to a transient 503 would waste
   * everything the earlier stages did.
   */
  return async function chat(messages, { json = false, tokens = maxTokens } = {}) {
    const url = `${cfg.baseUrl()}/chat/completions`
    const body = {
      model,
      messages,
      ...(target === "openai" ? { max_completion_tokens: tokens } : { max_tokens: tokens }),
      // GPT-4.1 accepts temperature; reasoning models use their own defaults.
      ...(target !== "openai" || model.startsWith("gpt-4") ? { temperature: 0.2 } : {}),
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }

    let lastError = null

    for (let attempt = 1; attempt <= 4; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let retryAfter = null
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })

        const raw = await res.text()
        retryAfter = res.headers.get("retry-after")

        if (!res.ok) {
          let providerError
          try { providerError = JSON.parse(raw)?.error } catch {}
          const billingCodes = ['insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'billing_hard_limit_reached', 'usage_limit_reached']
          if (billingCodes.includes(providerError?.code) || providerError?.type === 'insufficient_quota') {
            const error = new Error(`${cfg.label} API credits or spending limit are exhausted. Check your provider's API billing account. DunkAI credits do not fund a BYOK provider account.`)
            error.code = 'PROVIDER_BILLING'
            throw error
          }
          // 402 ("not included in your free usage") and 404 (no such model) are
          // account facts, not weather: retrying wastes time and the message
          // has to reach the user unchanged.
          const detail = typeof providerError?.message === 'string' ? providerError.message.replace(/(?:sk-|gsk_)[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 400) : 'The provider rejected the request'
          lastError = new Error(`${cfg.label} HTTP ${res.status}: ${detail}`)
          const retryable = res.status === 429 || (res.status >= 500 && res.status < 600)
          if (!retryable || attempt === 4) throw lastError
          const wait = backoffMs(attempt, res.headers.get("retry-after"))
          note(
            `  ${cfg.label} HTTP ${res.status}, retrying in ${Math.round(wait / 1000)}s ` +
              `(attempt ${attempt}/4)`
          )
          await sleep(wait)
          continue
        }

        let parsed
        try { parsed = JSON.parse(raw) }
        catch {
          const error = new Error(`${cfg.label} returned an empty or incomplete JSON response. Retry PCB generation from the BOM.`)
          error.code = 'INVALID_PROVIDER_RESPONSE'
          throw error
        }
        const choice = parsed?.choices?.[0]
        const content = typeof choice?.message?.content === 'string' ? choice.message.content : ""
        if (choice?.message?.refusal) throw new Error(`${cfg.label} declined the PCB generation request`)

        // gpt-oss-class models spend the token budget in a separate `reasoning`
        // field. Empty content with a length stop is truncation, not refusal,
        // and saying which it is names the actual fix.
        if (!content.trim()) {
          const reasoning = choice?.message?.reasoning
          if (choice?.finish_reason === "length" || reasoning) {
            throw new Error(
              `${cfg.label} returned no content (finish_reason=${choice?.finish_reason}); ` +
                `the reply was cut off before the answer — raise DESIGNER_MAX_TOKENS`
            )
          }
          const error = new Error(`${cfg.label} returned an empty reply. Retry PCB generation from the BOM.`)
          error.code = 'INVALID_PROVIDER_RESPONSE'
          throw error
        }
        if (json && choice?.finish_reason === 'length') {
          throw new Error(`${cfg.label} cut off the PCB response at its token limit. Increase DESIGNER_MAX_TOKENS on the AI engine and retry from the BOM.`)
        }

        return { content, usage: parsed.usage }
      } catch (err) {
        const network = transportFailure(err)
        if (err.name === "AbortError") {
          lastError = new Error(`${cfg.label} timed out after ${Math.round(timeoutMs / 1000)}s`)
        } else if (network) {
          lastError = new Error(`${cfg.label}: ${network}`)
        } else {
          lastError = err
        }

        const worthRetrying =
          err.name === "AbortError" || Boolean(network) || err.code === 'INVALID_PROVIDER_RESPONSE' || isRetryableMessage(lastError.message)
        if (attempt === 4 || !worthRetrying) throw lastError

        const wait = backoffMs(attempt, retryAfter)
        note(
          `  ${cfg.label} ${network ?? "request failed"}, retrying in ` +
            `${Math.round(wait / 1000)}s (attempt ${attempt}/4)`
        )
        await sleep(wait)
      } finally {
        clearTimeout(timer)
      }
    }

    throw lastError
  }
}

export function createOpenAICompatibleProvider(target, options = {}) {
  const cfg = TARGETS[target]
  if (!cfg) throw new Error(`unknown openai-compatible target "${target}"`)

  const model = options.model ?? cfg.defaultModel()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  // Generous by default: reasoning-style models charge their thinking against
  // this budget, and a board's three files run to thousands of tokens.
  const maxTokens = options.maxTokens ?? Number(process.env.DESIGNER_MAX_TOKENS ?? 16000)
  const chat = createClient(target, { model, timeoutMs, maxTokens })

  return createChatProvider({ name: target, label: cfg.label, model, chat, maxTokens })
}
