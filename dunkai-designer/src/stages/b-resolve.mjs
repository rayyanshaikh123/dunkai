/**
 * Stage B — per-component resolution.
 *
 * Each component is resolved by an independent worker, several at a time, and
 * each worker walks a fixed ladder, stopping at the first tier whose result
 * passes the gates:
 *
 *   1 lcsc-in-IR      the IR already carries a catalogue number -> import it
 *   2 exact MPN       search by the manufacturer part number
 *   3 disambiguate    several catalogue hits -> score them against the declared
 *                     package, stock and basic/preferred status, import the best
 *   4 relax           drop the suffix that encodes packaging/tape-and-reel and
 *                     retry, since "-E/MC" style tails are ordering codes
 *   5 custom footprint nothing in the catalogue fits -> synthesise a footprinter
 *                     string from the declared package via the provider
 *
 * The ladder is ordered by how much is being ASSUMED, cheapest assumption first.
 * Tier 1 assumes nothing (dunkai already looked the part up). Tier 5 assumes the
 * most, so it runs only when every cheaper option has been tried and failed.
 *
 * Concurrency is bounded. These are live calls to a shared catalogue service and
 * a wide fan-out gets throttled, which reads downstream as a resolution failure
 * rather than as backpressure.
 */

import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { mkdir, readFile, readdir, mkdtemp, copyFile, rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { stage, item, note } from "../lib/events.mjs"
import { standardFootprintCandidates } from "../lib/package-footprints.mjs"
import { readCached, writeCached } from "../lib/resolution-cache.mjs"
import {
  parseImportedChip,
  parseImportOutput,
  applyGates,
  expectedPinCount,
  mpnMatches,
  validateFootprintString,
  footprintFamilies,
} from "../lib/footprint.mjs"

const DESIGNER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const TSCI = path.join(DESIGNER_ROOT, "node_modules", "tscircuit", "cli.mjs")

// Absolute path, not a bare specifier: footprinter's "exports" map does not
// publish ./dist/index.js. Same reason as the loader in e-outputs.mjs.
const _require = createRequire(path.join(DESIGNER_ROOT, "package.json"))
const req = (subpath) => _require(path.join(DESIGNER_ROOT, "node_modules", subpath))
const FAMILIES = footprintFamilies(req)
const JLC_SEARCH = "https://jlcsearch.tscircuit.com/api/search"

const DEFAULT_CONCURRENCY = 4

/** Run `tsci import` inside `cwd`, returning its combined output. */
function runTsciImport(query, cwd, { exactFootprint = false } = {}) {
  return new Promise((resolve) => {
    const args = [TSCI, "import", "--jlcpcb", query]
    if (exactFootprint) args.push("--use-exact-footprint")
    const child = spawn(process.execPath, args, { cwd, windowsHide: true })
    let out = ""
    child.stdout.on("data", (d) => (out += d.toString()))
    child.stderr.on("data", (d) => (out += d.toString()))
    child.on("error", (err) => resolve({ output: `spawn failed: ${err.message}`, code: -1 }))
    child.on("close", (code) => resolve({ output: out, code }))
  })
}

async function searchCatalogue(query) {
  try {
    const res = await fetch(`${JLC_SEARCH}?q=${encodeURIComponent(query)}`, {
      headers: { accept: "application/json" },
    })
    if (!res.ok) return []
    const body = await res.json()
    return Array.isArray(body.components) ? body.components : []
  } catch {
    return []
  }
}

/** Normalise a package string for comparison: "DFN-8-EP(2x3)" -> "DFN8EP2X3". */
const packageKey = (text) => String(text ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")

/**
 * Score a catalogue candidate against what the IR declared.
 *
 * Package agreement dominates on purpose: a part with the right function in the
 * wrong package is not a substitute, it is a different board. Stock and basic /
 * preferred status only break ties between candidates that already fit.
 */
function scoreCandidate(candidate, component) {
  const declared = packageKey(component.package)
  const actual = packageKey(candidate.package)
  let score = 0

  if (declared && actual) {
    if (declared === actual) score += 100
    else if (actual.startsWith(declared) || declared.startsWith(actual)) score += 60
    else {
      // Same family and pin count is still a real match: "DFN-8-EP(2x3)" vs
      // "DFN-8(2x3)" differ only by whether the vendor lists the exposed pad.
      const a = expectedPinCount(component.package)
      const b = expectedPinCount(candidate.package)
      if (a && b && a.pins === b.pins) score += 35
    }
  }

  if (String(candidate.mfr ?? "").toUpperCase() === String(component.part_number).toUpperCase()) {
    score += 50
  }
  if (candidate.is_basic) score += 8
  if (candidate.is_preferred) score += 5
  if (Number(candidate.stock) > 0) score += 4

  return score
}

/**
 * Strip an ordering/packaging suffix from an MPN.
 * "MCP9808T-E/MC" -> "MCP9808T", "IS25LP040E-JYLE-TR" -> "IS25LP040E".
 */
function relaxMpn(mpn) {
  const text = String(mpn ?? "").trim()
  const candidates = new Set()
  const beforeSlash = text.split("/")[0]
  if (beforeSlash !== text) candidates.add(beforeSlash)
  const noTail = text.replace(/[-_](TR|T|R|RL|REEL|TAPE|CT|ND)$/i, "")
  if (noTail !== text) candidates.add(noTail)
  const firstSegment = text.split(/[-_]/)[0]
  if (firstSegment && firstSegment.length >= 4) candidates.add(firstSegment)
  return [...candidates].filter((c) => c && c !== text)
}

/**
 * Read back whatever tsci just wrote.
 *
 * `importedPath` (parsed from tsci's own output) is the only trustworthy
 * source. There is deliberately NO "newest file in imports/" fallback: several
 * components resolve concurrently into the same directory, so picking a file
 * this call did not create would silently attribute another component's symbol
 * and footprint to this one — a wrong board that passes every gate.
 */
async function readImported(importedPath) {
  if (!importedPath) return null
  try {
    const source = await readFile(importedPath, "utf-8")
    return { file: importedPath, source, chip: parseImportedChip(source) }
  } catch {
    return null
  }
}

/**
 * One resolution attempt: import, read back, gate.
 *
 * `expectMpn` is the part number the import is checked against. For tiers 1-2
 * that is the requested MPN. For tiers 3-4, where a DIFFERENT catalogue part was
 * deliberately chosen, it is that candidate's MPN — the gate still verifies the
 * import is the part we picked, while the difference from the original request
 * is recorded separately as a substitution.
 */
export async function attempt(query, component, workdir, tier, opts, expectMpn) {
  // Each CLI invocation owns its directory. Hosted Node pipes can be empty,
  // so recovering a newly written file must never race another component's
  // import. Repeated attempts also cannot consume a previous attempt's file.
  const staging = await mkdtemp(path.join(workdir, '.catalogue-'))
  try {
  const importsDir = path.join(staging, "imports")
  const before = new Set(await readdir(importsDir).catch(() => []))

  const { output, code } = await (opts.importRunner ?? runTsciImport)(query, staging, opts)
  if (code !== 0) return { ok: false, tier, reason: `catalogue import failed for "${query}" (exit ${code})` }
  const info = parseImportOutput(output)

  if (info.noResults) {
    return { ok: false, tier, reason: `no catalogue result for "${query}"` }
  }

  // Used only when tsci reported no path AND this call created exactly one new
  // file — unambiguous by construction, so it cannot pick up a sibling worker's
  // import. Anything less certain is treated as a failed resolution.
  const after = await readdir(importsDir).catch(() => [])
  const fresh = after.filter((f) => !before.has(f) && f.endsWith(".tsx"))
  const importedPath =
    info.importedPath ?? (fresh.length === 1 ? path.join(importsDir, fresh[0]) : null)

  const read = await readImported(importedPath)
  if (!read) {
    return { ok: false, tier, reason: `import of "${query}" produced no file` }
  }

  const gates = applyGates(read.chip, info, component.package, {
    ...opts,
    declaredMpn: expectMpn ?? component.part_number,
  })
  if (gates.passed && read.chip.exportName) {
    const destination = path.join(workdir, 'imports', `${read.chip.exportName}.tsx`)
    await mkdir(path.dirname(destination), { recursive: true })
    await copyFile(read.file, destination)
    read.file = destination
  }
  return {
    ok: gates.passed,
    tier,
    query,
    file: read.file,
    chip: read.chip,
    iou: info.iou,
    lcsc: info.lcsc ?? read.chip.lcsc,
    footprinter: info.footprinter ?? read.chip.footprint,
    gates,
    reason: gates.passed ? null : gates.failures.join("; "),
  }
  } finally { await rm(staging, { recursive: true, force: true }) }
}

async function resolveOne(component, workdir, provider, opts) {
  const ref = component.ref_id
  const tried = []

  // --- tier 1: catalogue number already in the IR ---------------------------
  if (component.lcsc) {
    item("B", ref, 1, "running", `lcsc ${component.lcsc}`)
    const r = await attempt(component.lcsc, component, workdir, 1, opts)
    tried.push({ tier: 1, query: component.lcsc, reason: r.reason })
    if (r.ok) return { ...r, tier: 1, tried }
    item("B", ref, 1, "failed", r.reason)
  }

  // --- tier 2: exact manufacturer part number -------------------------------
  item("B", ref, 2, "running", component.part_number)
  {
    const r = await attempt(component.part_number, component, workdir, 2, opts)
    tried.push({ tier: 2, query: component.part_number, reason: r.reason })
    if (r.ok) return { ...r, tier: 2, tried }
    item("B", ref, 2, "failed", r.reason)
  }

  // --- tier 3: disambiguate among catalogue candidates ----------------------
  item("B", ref, 3, "running", "scoring catalogue candidates")
  const candidates = await searchCatalogue(component.part_number)
  if (candidates.length) {
    const ranked = candidates
      .map((c) => ({ c, score: scoreCandidate(c, component) }))
      .sort((a, b) => b.score - a.score)
    note(
      `  ${ref}: ${ranked.length} candidate(s); best ` +
        ranked.slice(0, 3).map((r) => `${r.c.mfr}/${r.c.package}=${r.score}`).join(", ")
    )
    for (const { c, score } of ranked.slice(0, 3)) {
      const lcsc = `C${c.lcsc}`
      const r = await attempt(lcsc, component, workdir, 3, opts, c.mfr)
      tried.push({ tier: 3, query: `${lcsc} (${c.mfr}, score ${score})`, reason: r.reason })
      if (r.ok) {
        const substituted = mpnMatches(component.part_number, c.mfr)
          ? null
          : { requested: component.part_number, got: c.mfr }
        return { ...r, tier: 3, tried, candidate: c, ...(substituted ? { substituted } : {}) }
      }
    }
  }
  item("B", ref, 3, "failed", `${candidates.length} candidate(s), none passed the gates`)

  // --- tier 4: relax the ordering suffix ------------------------------------
  for (const relaxed of relaxMpn(component.part_number)) {
    item("B", ref, 4, "running", relaxed)
    const hits = await searchCatalogue(relaxed)
    if (!hits.length) {
      tried.push({ tier: 4, query: relaxed, reason: "no catalogue result" })
      continue
    }
    const best = hits
      .map((c) => ({ c, score: scoreCandidate(c, component) }))
      .sort((a, b) => b.score - a.score)[0]
    const lcsc = `C${best.c.lcsc}`
    const r = await attempt(lcsc, component, workdir, 4, opts, best.c.mfr)
    tried.push({ tier: 4, query: `${relaxed} -> ${lcsc} (${best.c.mfr})`, reason: r.reason })
    if (r.ok) {
      // A relaxed match is a DIFFERENT part number from the one requested.
      // Recorded explicitly so the brief and the BOM can say so out loud.
      return { ...r, tier: 4, tried, substituted: { requested: component.part_number, got: best.c.mfr } }
    }
    item("B", ref, 4, "failed", r.reason)
  }

  // --- tier 5: synthesise a custom footprint --------------------------------
  //
  // The synthesised string is COMPILED before it is accepted. A string that
  // footprinter rejects is worse than no part at all: the component lands with
  // no pads, placement then fails, and the autorouter skips the entire board.
  // Two attempts, the second one told exactly what was wrong with the first.
  const expected = expectedPinCount(component.package)
  let lastError = null

  // A standard package needs a lookup, not a model (lib/package-footprints.mjs):
  // each candidate is compiled and pad-counted exactly like a model's answer.
  for (const footprint of standardFootprintCandidates(component.package)) {
    const check = validateFootprintString(footprint, req)
    const padsOk = check.valid && (!expected || check.pads === expected.pins || check.pads === expected.pins + 1)
    tried.push({ tier: 5, query: `standard ${footprint}`, reason: padsOk ? null : check.valid ? `${check.pads} pads` : check.error })
    if (!padsOk) continue
    item("B", ref, 5, "running", `standard footprint ${footprint} for "${component.package}"`)
    return {
      ok: true,
      tier: 5,
      component,
      custom: { footprint, rationale: `standard ${component.package} land pattern (not catalogue-verified)` },
      tried,
      chip: null,
      footprinter: footprint,
      padCount: check.pads,
      gates: { passed: true, failures: [], notes: [`standard package footprint, ${check.pads} pads`] },
    }
  }

  for (let attemptNo = 1; attemptNo <= 2; attemptNo++) {
    item("B", ref, 5, "running", `custom footprint for "${component.package}"${attemptNo > 1 ? " (retry)" : ""}`)

    const custom = await provider
      .synthesiseFootprint(component, { previousError: lastError, families: FAMILIES })
      .catch((err) => ({ error: err.message }))

    if (!custom?.footprint) {
      lastError = custom?.error ?? custom?.rationale ?? "no footprint returned"
      continue
    }

    const check = validateFootprintString(custom.footprint, req)
    if (!check.valid) {
      lastError = `"${custom.footprint}" is not a valid footprinter string: ${check.error}`
      note(`  ${ref}: tier 5 rejected — ${lastError}`)
      continue
    }

    if (expected && check.pads !== expected.pins && check.pads !== expected.pins + 1) {
      lastError =
        `"${custom.footprint}" compiles to ${check.pads} pads but package ` +
        `"${component.package}" implies ${expected.pins}`
      note(`  ${ref}: tier 5 rejected — ${lastError}`)
      continue
    }

    return {
      ok: true,
      tier: 5,
      component,
      custom,
      tried,
      chip: null,
      footprinter: custom.footprint,
      // Numbered pads only (no symbol): lib/pinmap.mjs asks about each of them.
      padCount: check.pads,
      gates: {
        passed: true,
        failures: [],
        notes: [
          `custom footprint, ${check.pads} pads: ${custom.rationale ?? "synthesised"}`,
        ],
      },
    }
  }

  return {
    ok: false,
    tier: 5,
    tried: [...tried, { tier: 5, query: component.package, reason: lastError }],
    reason: lastError ?? `could not resolve ${component.part_number}`,
  }
}

/** Bounded-concurrency map. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * @param {object} design  normalised design from Stage A
 * @param {string} workdir project directory (imports/ is written inside it)
 * @param {object} provider generation provider (used for tier 5 only)
 */
export async function resolveComponents(design, workdir, provider, opts = {}) {
  stage("B", "running", `${design.components.length} component(s)`)
  await mkdir(path.join(workdir, "imports"), { recursive: true })

  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY
  const resolutions = await mapLimit(design.components, concurrency, async (component) => {
    // A part that resolved on an earlier run resolves the same way now: the
    // catalogue search is a live service and has returned a different (wrong)
    // part for the same query between runs.
    const cached = opts.cache === false ? null : await readCached(component, workdir)
    if (cached) {
      item("B", component.ref_id, cached.tier, "resolved", `from cache · ${cached.footprinter ?? ""}`)
      return { component, ...cached }
    }
    const result = await resolveOne(component, workdir, provider, opts)
    if (result.ok && result.chip && opts.cache !== false) await writeCached(component, result, workdir).catch(() => {})
    if (result.ok) {
      item(
        "B",
        component.ref_id,
        result.tier,
        "resolved",
        [result.footprinter, result.iou != null ? `IoU ${result.iou}%` : null]
          .filter(Boolean)
          .join(" · ")
      )
    } else {
      item("B", component.ref_id, result.tier, "unresolved", result.reason)
    }
    return { component, ...result }
  })

  const resolved = resolutions.filter((r) => r.ok)
  const unresolved = resolutions.filter((r) => !r.ok)
  const placeholders = resolved.filter((r) => r.chip && r.chip.placeholderRatio > 0.5)
  const substituted = resolved.filter((r) => r.substituted)

  const byTier = {}
  for (const r of resolved) byTier[r.tier] = (byTier[r.tier] ?? 0) + 1

  stage(
    "B",
    "done",
    `${resolved.length}/${resolutions.length} resolved ` +
      `(${Object.entries(byTier).sort().map(([t, n]) => `tier${t}:${n}`).join(", ") || "none"})` +
      (placeholders.length ? ` · ${placeholders.length} with unnamed pins` : "") +
      (substituted.length ? ` · ${substituted.length} substituted` : "") +
      (unresolved.length ? ` · ${unresolved.length} UNRESOLVED` : "")
  )

  return { resolutions, resolved, unresolved, placeholders, substituted }
}
