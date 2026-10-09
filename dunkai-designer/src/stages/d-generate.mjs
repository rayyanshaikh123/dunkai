/**
 * Stage D — generation.
 *
 * The provider writes the tscircuit sources; this stage owns the contract around
 * that call: what must exist when it returns, and what counts as a usable
 * result. A provider that "succeeded" but wrote no board is a failure here, not
 * a mystery two stages later when the evaluator reports an empty circuit.
 */

import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { stage, note } from "../lib/events.mjs"

const exists = (p) => access(p).then(() => true).catch(() => false)

const REQUIRED = ["index.tsx", "src/board.tsx"]

export async function generateProject(design, brief, provider, workdir, opts = {}) {
  stage("D", "running", `provider ${provider.name}${provider.model ? ` (${provider.model})` : ""}`)

  // The brief is written to disk before the call, not after: if generation fails
  // or produces something wrong, the exact specification it was given is still
  // on disk to compare against, rather than having only existed in a process.
  const briefPath = path.join(workdir, "design-brief.md")
  await writeFile(briefPath, brief, "utf-8")

  const generation = await provider.generateProject({ design, brief, workdir, ...opts })

  const missing = []
  for (const rel of REQUIRED) {
    if (!(await exists(path.join(workdir, rel)))) missing.push(rel)
  }
  if (missing.length) {
    throw new Error(
      `provider ${provider.name} did not write: ${missing.join(", ")} ` +
        `(brief is at ${briefPath} for comparison)`
    )
  }

  const board = await readFile(path.join(workdir, "src", "board.tsx"), "utf-8")

  // Cheap structural checks. These catch a plausible-looking file that is not
  // actually a board before the evaluator has to say so in a longer way.
  const findings = []
  if (!/<board[\s>]/.test(board)) findings.push("src/board.tsx has no <board> element")
  const netCount = (board.match(/<net\s/g) ?? []).length
  if (netCount === 0) findings.push("no <net> declarations")

  if (findings.length) {
    throw new Error(`generated board is not usable: ${findings.join("; ")}`)
  }

  for (const line of String(generation?.summary ?? "").split("\n").slice(0, 6)) {
    if (line.trim()) note(`  ${line.trim()}`)
  }

  stage("D", "done", `${board.length} chars · ${netCount} net declaration(s)`)
  return { briefPath, board, generation }
}

// ---------------------------------------------------------------------------
// Structured strategy
// ---------------------------------------------------------------------------

/**
 * Stage D without freehand code: map pins in code, ask the model only what
 * code cannot decide (as multiple choice), then emit board.tsx from the table.
 *
 * Every connection in the result is traceable in pinmap.json to its source —
 * a vendor attribute, a pin label, or a model answer that was validated
 * against the part's real free pins.
 *
 * @returns {{ briefPath: string, board: string, mapping: object, size: object, emit: Function }}
 */
export async function generateStructured(design, brief, resolution, provider, workdir) {
  const { mapPins, applyAnswers, mappingStats, findMismatches } = await import("../lib/pinmap.mjs")
  const { emitBoard } = await import("../lib/emit-board.mjs")
  const { supportParts } = await import("../lib/support-parts.mjs")

  stage("D", "running", `structured · provider ${provider.name}${provider.model ? ` (${provider.model})` : ""}`)
  const briefPath = path.join(workdir, "design-brief.md")
  await writeFile(briefPath, brief, "utf-8")

  const mapping = mapPins(design, resolution.resolutions)
  const deterministic = mappingStats(mapping)
  note(
    `  pin map: ${deterministic.connected}/${deterministic.members} member(s) decided in code, ` +
      `${mapping.questions.length} question(s) for the model`
  )

  let modelNote = "no questions"
  if (mapping.questions.length && typeof provider.answerPinQuestions === "function") {
    try {
      const first = await provider.answerPinQuestions(mapping.questions)
      const round1 = applyAnswers(mapping, first)
      modelNote = `${round1.applied} answered`

      // One retry, only for answers that were rejected (not a listed pin, or a
      // pin already taken). Candidates are recomputed so taken pins are gone.
      const retry = round1.rejected
      if (retry.length) {
        const taken = {}
        for (const [ref, pins] of Object.entries(mapping.assignments)) taken[ref] = new Set(Object.keys(pins))
        const again = mapping.questions
          .filter((q) => retry.some((r) => r.id === q.id))
          .map((q) => ({ ...q, candidates: q.candidates.filter((c) => !taken[q.ref_id]?.has(c.pin)) }))
          .filter((q) => q.candidates.length)
        if (again.length) {
          note(`  ${again.length} answer(s) rejected — asking once more`)
          const second = await provider.answerPinQuestions(again, { rejected: retry })
          const round2 = applyAnswers({ ...mapping, questions: again }, second)
          modelNote += `, ${round2.applied} more on retry, ${round2.rejected.length} left unconnected`
        }
      }
    } catch (err) {
      // Provider rejection is a failed run, not a licence to build an unwired
      // board and spend the user's credits as though the model answered.
      throw new Error(`Pin mapping failed: ${err.message}`, { cause: err })
    }
  } else if (mapping.questions.length) {
    modelNote = `provider ${provider.name} cannot answer pin questions; ${mapping.questions.length} left unconnected`
  }

  // Decoupling, bulk, I2C and reset pull-ups: rules, applied after the pins
  // are final because they hang off the mapped supply and bus pins.
  const support = supportParts(design, resolution.resolutions, mapping)
  if (support.length) {
    const counts = {}
    for (const s of support) counts[`${s.value} ${s.kind}`] = (counts[`${s.value} ${s.kind}`] ?? 0) + 1
    note(`  support parts: ${Object.entries(counts).map(([k, n]) => `${n}x ${k}`).join(", ")}`)
  }

  const size = {
    widthMm: design.constraints.board_outline.width_mm,
    heightMm: design.constraints.board_outline.height_mm,
  }
  const emit = async () => {
    const { boardTsx, indexTsx, nets } = emitBoard(design, resolution.resolutions, mapping, size, support)
    await mkdir(path.join(workdir, "src"), { recursive: true })
    await writeFile(path.join(workdir, "src", "board.tsx"), boardTsx, "utf-8")
    await writeFile(path.join(workdir, "index.tsx"), indexTsx, "utf-8")
    return { boardTsx, nets }
  }
  const { boardTsx, nets } = await emit()
  if (design.nets.length && !nets.length) {
    throw new Error('No required nets could be connected. Verify the BOM and component pinouts before generating this PCB; an unwired layout is not a completed design.')
  }

  const stats = mappingStats(mapping)
  // Connections left open because a part cannot do what the architecture asked
  // (a display on SPI): reported up, so the architecture can be revised.
  const mismatches = findMismatches(mapping, resolution.resolutions)
  if (mismatches.length) {
    note(`  ${mismatches.length} connection(s) left open — part cannot do the requested interface:`)
    for (const m of mismatches) note(`    ${m.ref_id} ${m.part_number}: ${m.interface} ${m.role} — supports ${m.supports.join(", ")}`)
  }
  await writeFile(
    path.join(workdir, "pinmap.json"),
    JSON.stringify({ stats, members: mapping.members, questions: mapping.questions, support, mismatches }, null, 2),
    "utf-8"
  )

  stage(
    "D",
    "done",
    `${stats.connected}/${stats.members} connections · ${nets.length} nets · ` +
      Object.entries(stats.bySource).map(([k, v]) => `${k} ${v}`).join(", ") +
      ` · ${modelNote}`
  )
  return { briefPath, board: boardTsx, mapping, size, emit, support, mismatches }
}
