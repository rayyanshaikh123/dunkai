/**
 * Progress protocol.
 *
 * stdout carries NDJSON and NOTHING else — one JSON object per line — because
 * the caller (the supervisor's `generate_board` node) parses it line by line and
 * re-emits each line as an SSE `progress` event. Anything meant for a human goes
 * to stderr. A stray console.log on stdout corrupts the stream for the whole
 * run, so every human-facing message in this project must use `note()`.
 *
 * Event shapes:
 *   {ev:"stage",  stage:"A", label, status:"running"|"done"|"skipped", detail?}
 *   {ev:"item",   stage:"B", ref_id, tier, status, detail?}   per-component detail
 *   {ev:"result", outDir, files:{...}, stats:{...}}
 *   {ev:"error",  stage, message}
 */

const emit = (obj) => {
  process.stdout.write(JSON.stringify(obj) + "\n")
}

export const STAGES = {
  A: "Reading the design handoff",
  B: "Resolving components against the catalogue",
  C: "Synthesising the design brief",
  D: "Generating the tscircuit project",
  E: "Building manufacturing outputs",
  F: "Optimising the 3D model",
}

export const stage = (id, status, detail) =>
  emit({ ev: "stage", stage: id, label: STAGES[id], status, ...(detail ? { detail } : {}) })

export const item = (id, ref_id, tier, status, detail) =>
  emit({ ev: "item", stage: id, ref_id, tier, status, ...(detail ? { detail } : {}) })

export const result = (payload) => emit({ ev: "result", ...payload })

export const failure = (id, message) => emit({ ev: "error", stage: id, message })

/** Provider token counts only; prompts and credentials never leave the worker. */
export const usage = (provider, model, tokens) => emit({ ev: 'usage', provider, model, tokens })

/** Human-readable log line. stderr on purpose — see the note above. */
export const note = (...args) => {
  process.stderr.write(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") + "\n")
}
