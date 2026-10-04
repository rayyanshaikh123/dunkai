/**
 * Shared implementation for every NON-agentic provider.
 *
 * A chat API cannot touch a filesystem, so the model returns file contents as
 * JSON and THIS module writes them — which means it also owns the checks the
 * agentic path gets for free: that the reply is well-formed, that it contains
 * the files stage D requires, and that no path escapes the work directory.
 *
 * Everything above the transport is identical between the OpenAI-compatible
 * targets and Anthropic — the same prompts, the same JSON contract, the same
 * validation before anything lands on disk. Only `chat()` differs. Keeping the
 * shared half here is what stopped adding Anthropic from forking 150 lines of
 * prompt text that would then drift out of step with the other providers.
 *
 * A transport is `chat(messages, {json, tokens}) -> {content, usage}` where
 * `content` is the assistant's reply text. It owns its own retries, timeouts
 * and error messages, because what is worth retrying is a property of the
 * endpoint rather than of this contract.
 */

import { mkdir, writeFile, readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import path from "node:path"
import { note, usage as emitUsage } from "../lib/events.mjs"
import { findUndeclaredNetRefs } from "../lib/nets.mjs"
import {
  FOOTPRINTER_GUIDE,
  BOARD_FILE_RULES,
  PLACEMENT_RULES,
  TSCIRCUIT_SKELETON,
  REPAIR_RULES,
  REPAIR_PREAMBLE,
  pinQuestionPrompt,
} from "./prompts.mjs"

/**
 * Catch the model copying the skeleton's EXAMPLE part/net verbatim instead of
 * this design's own resolved parts. Seen live with Groq's gpt-oss-120b: it
 * reproduced STC89C52RC_40I_PDIP40 / POWER_RAIL from the few-shot example even
 * though neither appears anywhere in the brief. Checked against the brief
 * itself (not just "does this string appear") because a real design that
 * genuinely happens to use that exact part/net name is legitimate.
 */
function echoesSkeletonPlaceholder(files, brief) {
  const text = Object.values(files).join("\n")
  const usesPlaceholderPart = /STC89C52RC_40I_PDIP40/.test(text) && !brief.includes("STC89C52RC_40I_PDIP40")
  const usesPlaceholderNet = /POWER_RAIL/.test(text) && !brief.includes("POWER_RAIL")
  return usesPlaceholderPart && usesPlaceholderNet
}

/** Strip ``` fences a model may wrap an answer in. */
export function unfence(text) {
  const fenced = String(text).match(/```(?:[a-z]*)\n([\s\S]*?)```/i)
  return (fenced ? fenced[1] : String(text)).trim()
}

/**
 * Parse a JSON object out of a reply.
 *
 * Models that ignore response_format still usually emit the object surrounded
 * by prose, so a brace-slice is tried before giving up. The alternative is
 * discarding an otherwise correct board over a leading "Here is the".
 */
export function parseJsonObject(text) {
  const cleaned = unfence(text)
  try {
    return JSON.parse(cleaned)
  } catch {}
  const first = cleaned.indexOf("{")
  const last = cleaned.lastIndexOf("}")
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(cleaned.slice(first, last + 1))
    } catch {}
  }
  return null
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * How long to wait before retrying attempt N.
 *
 * 5s / 15s / 45s rather than something brisk. These endpoints answer 503
 * "spikes in demand are usually temporary" and 429 on a free tier, and by the
 * time stage D runs the pipeline has already spent minutes resolving
 * components — giving up after a few seconds of retries throws that away to
 * save a minute. A server-sent Retry-After always wins over the guess.
 */
export function backoffMs(attempt, retryAfterHeader) {
  const retryAfter = Number(retryAfterHeader)
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 60_000)
  return 5000 * 3 ** (attempt - 1)
}

const requireFromDesigner = createRequire(import.meta.url)

/**
 * Reject TypeScript/TSX that does not parse.
 *
 * This exists because of a real failure: a repair pass returned a board.tsx
 * with a duplicated closing `);` on line 42, which replaced a file that had
 * parsed fine and killed the run at the next build with a syntax error. An
 * agentic provider edits through tooling and cannot do that; one that returns
 * whole files can, so the file has to be checked BEFORE it lands on disk.
 *
 * Only syntax is checked. Type errors are expected here — the imports these
 * files reference are generated in a directory this parser cannot see — so
 * semantic diagnostics are deliberately ignored.
 */
function syntaxErrorIn(rel, contents) {
  if (!/\.tsx?$/.test(rel)) return null
  let ts
  try {
    ts = requireFromDesigner("typescript")
  } catch {
    return null // no parser available; the build downstream remains the backstop
  }

  const file = ts.createSourceFile(
    rel,
    contents,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )

  const diagnostics = file.parseDiagnostics ?? []
  if (diagnostics.length === 0) return null

  const first = diagnostics[0]
  const message = ts.flattenDiagnosticMessageText(first.messageText, " ")
  const { line, character } = file.getLineAndCharacterOfPosition(first.start ?? 0)
  return `${rel} does not parse at ${line + 1}:${character + 1} — ${message}`
}

/**
 * Write a {path: contents} map into workdir.
 *
 * Validated in full before anything is written, so a reply with one broken file
 * leaves the previous good files untouched rather than half-replacing them.
 * Every path is resolved and checked to stay inside workdir: a model is choosing
 * these strings, so "../../.ssh/authorized_keys" is a case to handle rather than
 * one to assume away.
 */
export async function writeFiles(files, workdir) {
  const root = path.resolve(workdir)

  const planned = []
  for (const [rel, contents] of Object.entries(files)) {
    if (typeof contents !== "string") continue
    const target = path.resolve(root, rel)
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`provider tried to write outside the project: ${rel}`)
    }
    const problem = syntaxErrorIn(rel, contents)
    if (problem) throw new Error(`provider returned invalid source: ${problem}`)
    planned.push({ target, contents })
  }

  const written = []
  for (const { target, contents } of planned) {
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, contents, "utf-8")
    written.push(path.relative(root, target).replace(/\\/g, "/"))
  }
  return written
}

/**
 * Build the four-member provider interface on top of a transport.
 *
 * `name` is the registry key the CLI's --provider takes; `label` is what a
 * human sees in an error message.
 */
export function createChatProvider({ name, label, model, chat, maxTokens }) {
  const meteredChat = async (messages, options) => {
    const answer = await chat(messages, options)
    if (answer.usage) emitUsage(name, model, answer.usage)
    return answer
  }
  return {
    name,
    model,

    /** Tier 5 — derive a land pattern from the declared package text alone. */
    async synthesiseFootprint(component, context = {}) {
      const families = context.families ?? []
      const prompt = [
        "You are resolving a PCB land pattern for a part that is not in the JLCPCB catalogue.",
        "",
        FOOTPRINTER_GUIDE,
        "",
        families.length
          ? `The family token MUST be one of these ${families.length} implemented builders:\n${families.join(", ")}`
          : "",
        "",
        `Part number: ${component.part_number}`,
        `Declared package: ${component.package}`,
        `Part class: ${component.part_class}`,
        "",
        context.previousError
          ? `Your previous answer was REJECTED: ${context.previousError}\nReturn a different string that compiles.`
          : "",
        "",
        "Produce a single footprinter string for this package.",
        "It must compile with @tscircuit/footprinter and produce exactly the pad",
        "count the package implies.",
        'Reply with ONLY a JSON object: {"footprint": "<footprinter string>", "rationale": "<one short sentence>"}',
        'If the package text is too vague to place pads at all, reply {"footprint": null, "rationale": "<why>"}.',
      ]
        .filter((line) => line !== "")
        .join("\n")

      const { content } = await meteredChat([{ role: "user", content: prompt }], {
        json: true,
        tokens: Math.min(maxTokens, 4000),
      })

      const parsed = parseJsonObject(content)
      if (parsed) {
        return { footprint: parsed.footprint ?? null, rationale: parsed.rationale ?? "" }
      }
      // A bare footprinter string is still usable; anything else is not.
      const bare = unfence(content).split(/\s/)[0]
      if (/^[a-z]+\d+_/.test(bare)) return { footprint: bare, rationale: "unparsed reply" }
      return { footprint: null, rationale: `unparseable reply: ${content.slice(0, 200)}` }
    },

    /**
     * Stage D, structured strategy: choose a pin for each question. The model
     * only picks from listed pins; lib/pinmap.mjs validates every answer.
     */
    async answerPinQuestions(questions, context = {}) {
      const { content } = await meteredChat([{ role: "user", content: pinQuestionPrompt(questions, context) }], {
        json: true,
        tokens: Math.min(maxTokens, 6000),
      })
      const parsed = parseJsonObject(content)
      if (!parsed?.answers || typeof parsed.answers !== "object") {
        throw new Error(`${label} did not return an {answers:{...}} object — got: ${content.slice(0, 300)}`)
      }
      return parsed.answers
    },

    /** Stage D — the model returns the sources, this module writes them. */
    async generateProject({ brief, workdir }) {
      const basePrompt = [
        "Write a complete tscircuit board from the design brief below.",
        "",
        "The brief is the specification. Follow it exactly: every component,",
        "every net, and every constraint it lists must appear in the board.",
        "",
        "=== DESIGN BRIEF ===",
        brief,
        "=== END BRIEF ===",
        "",
        TSCIRCUIT_SKELETON,
        "",
        "Produce these two files:",
        "  src/board.tsx      the board: nets, components, connections",
        "  index.tsx          `import Board from './src/board'; export default Board`",
        "",
        ...BOARD_FILE_RULES,
        "",
        ...PLACEMENT_RULES,
        "",
        "Reply with ONLY a JSON object, no prose and no code fences, shaped:",
        '{"files": {"index.tsx": "<file contents>", "src/board.tsx": "<file contents>"}, "summary": "<one or two sentences>"}',
        "Every value must be the COMPLETE text of that file. Do not abbreviate,",
        "do not write placeholders such as ... or TODO, and do not omit a file.",
      ].join("\n")

      note(`  provider: ${name} (${model}) generating into ${workdir}`)

      const ask = async (extra) => {
        const prompt = extra ? `${basePrompt}\n\n${extra}` : basePrompt
        const { content, usage } = await meteredChat([{ role: "user", content: prompt }], { json: true })
        const parsed = parseJsonObject(content)
        if (!parsed?.files || typeof parsed.files !== "object") {
          throw new Error(
            `${label} did not return a {files:{...}} object — got: ${content.slice(0, 300)}`
          )
        }
        return { parsed, usage }
      }

      let { parsed, usage } = await ask()

      // Groq's gpt-oss-120b has reproduced the skeleton's example part/net
      // verbatim instead of this design's own — retry once with an explicit
      // correction rather than silently shipping a board built from the
      // wrong components.
      if (echoesSkeletonPlaceholder(parsed.files, brief)) {
        note(`  ${name} echoed the skeleton's example part/net — retrying once`)
        ;({ parsed, usage } = await ask(
          "Your previous answer copied the SKELETON EXAMPLE's part name and net " +
            "name (STC89C52RC_40I_PDIP40 / POWER_RAIL) instead of using this " +
            "design's own resolved parts and nets from the brief above. Write the " +
            "board again using ONLY the parts and nets the brief actually names."
        ))
      }

      // createNetsFromProps silently creates an orphan net on any name
      // mismatch instead of erroring — see lib/nets.mjs — so this is the one
      // class of net bug with no DRC message to catch it downstream.
      const boardTsxDraft = parsed.files["src/board.tsx"] ?? ""
      const { missing } = boardTsxDraft ? findUndeclaredNetRefs(boardTsxDraft) : { missing: [] }
      if (missing.length > 0) {
        note(`  ${name} referenced undeclared net(s): ${missing.join(", ")} — retrying once`)
        ;({ parsed, usage } = await ask(
          `Your previous answer referenced these net names without declaring them ` +
            `with <net name="..." />: ${missing.join(", ")}. tscircuit does not error ` +
            `on this — it silently creates a new disconnected net instead — so every ` +
            `pin using one of these names would end up unconnected. Add the missing ` +
            `<net> declaration(s), or fix the typo if one was intended to match an ` +
            `existing declared net.`
        ))
      }

      const written = await writeFiles(parsed.files, workdir)
      note(`  ${name} wrote ${written.length} file(s): ${written.join(", ")}`)
      if (usage?.total_tokens) note(`  ${name} used ${usage.total_tokens} tokens`)

      return { summary: String(parsed.summary ?? `${written.length} files written`).slice(0, 4000) }
    },

    /** Repair pass — same contract, and the DRC text is handed over verbatim. */
    async repair({ workdir, errors }) {
      let boardTsx = ""
      try {
        boardTsx = await readFile(path.join(workdir, "src", "board.tsx"), "utf-8")
      } catch {}

      const prompt = [
        "The board you generated has errors.",
        "",
        ...REPAIR_PREAMBLE,
        "",
        "=== DRC ERRORS ===",
        errors,
        "=== END ERRORS ===",
        "",
        "=== CURRENT src/board.tsx ===",
        boardTsx,
        "=== END ===",
        "",
        "Fix it. Rules:",
        ...REPAIR_RULES,
        "",
        "Change only what the errors above require — do not touch anything else.",
        "Reply with ONLY a JSON object, no prose and no code fences, shaped:",
        '{"files": {"src/board.tsx": "<complete corrected file>"}, "summary": "<what you changed>"}',
        "Every value must be the COMPLETE text of that file.",
      ]
        .filter((line) => line !== "")
        .join("\n")

      note(`  provider: ${name} (${model}) repairing the board`)

      const { content } = await meteredChat([{ role: "user", content: prompt }], { json: true })
      const parsed = parseJsonObject(content)
      if (!parsed?.files || typeof parsed.files !== "object") {
        throw new Error(
          `${label} repair did not return a {files:{...}} object — got: ${content.slice(0, 300)}`
        )
      }

      const written = await writeFiles(parsed.files, workdir)
      note(`  ${name} rewrote ${written.length} file(s): ${written.join(", ")}`)
      return { summary: String(parsed.summary ?? `${written.length} files rewritten`).slice(0, 2000) }
    },
  }
}
