#!/usr/bin/env node
/**
 * dunkai-designer — turn a dunkai pcb_ir handoff into a real tscircuit project
 * and its manufacturing outputs.
 *
 *   node src/cli.mjs --ir pcb_ir.json --out ./build/my-design
 *   cat pcb_ir.json | node src/cli.mjs --ir - --out ./build/my-design
 *
 * stdout is NDJSON progress (see lib/events.mjs). Human output goes to stderr.
 */

import { mkdir, readFile, writeFile, stat } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import { intake } from "./stages/a-intake.mjs"
import { resolveComponents } from "./stages/b-resolve.mjs"
import { synthesiseBrief } from "./stages/c-brief.mjs"
import { generateProject, generateStructured } from "./stages/d-generate.mjs"
import { applyStructuredFixes } from "./lib/structured-fixes.mjs"
import { buildOutputsIsolated as buildOutputs } from "./lib/isolated-build.mjs"
import { buildGltf } from "./stages/f-gltf.mjs"
import { getProvider, PROVIDER_NAMES } from "./providers/index.mjs"
import { result, failure, note, stage } from "./lib/events.mjs"

function parseArgs(argv) {
  const args = {
    ir: null,
    out: null,
    provider: "claude-code",
    model: undefined,
    skip3d: false,
    failOnError: false,
    concurrency: 4,
    iouThreshold: 98,
    repairAttempts: 2,
    strategy: "auto",
    cache: true,
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    switch (a) {
      case "--ir": args.ir = next(); break
      case "--out": args.out = next(); break
      case "--provider": args.provider = next(); break
      case "--model": args.model = next(); break
      case "--skip-3d": args.skip3d = true; break
      case "--fail-on-error": args.failOnError = true; break
      case "--concurrency": args.concurrency = Number(next()); break
      case "--iou-threshold": args.iouThreshold = Number(next()); break
      case "--repair-attempts": args.repairAttempts = Number(next()); break
      case "--strategy": args.strategy = next(); break
      case "--no-cache": args.cache = false; break
      case "-h":
      case "--help": args.help = true; break
      default:
        throw new Error(`unknown argument: ${a}`)
    }
  }
  return args
}

const USAGE = `
dunkai-designer — pcb_ir -> tscircuit project -> manufacturing outputs

  --ir <path|->          pcb_ir JSON file, or - for stdin        (required)
  --out <dir>            project directory to build into        (required)
  --provider <name>      generation provider (default claude-code)
                         available: ${PROVIDER_NAMES.join(", ")}
  --model <name>         model for the provider
  --concurrency <n>      parallel component resolutions (default 4)
  --iou-threshold <n>    minimum copper IoU % to accept (default 98)
  --repair-attempts <n>  placement repair passes after a failed build (default 2)
  --strategy <s>         structured | freeform | auto (default auto)
                         structured: pins mapped in code, the model only answers
                         multiple-choice pin questions, board.tsx is emitted.
                         freeform: the model writes board.tsx itself.
                         auto: freeform for claude-code, structured otherwise.
  --no-cache             resolve every part live, ignoring earlier resolutions
  --skip-3d              stop after stage E, do not build the glTF
  --fail-on-error        exit non-zero when the board has DRC error elements
`.trim()

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString("utf-8")
}

async function main() {
  const args = parseArgs(process.argv)

  if (args.help || !args.ir || !args.out) {
    process.stderr.write(USAGE + "\n")
    process.exit(args.help ? 0 : 2)
  }

  const workdir = path.resolve(args.out)
  await mkdir(workdir, { recursive: true })

  const provider = getProvider(args.provider, { model: args.model })
  // A provider that cannot run at all (CLI missing or logged out) must say so
  // now, not minutes into Stage B or D where it would look like a hang.
  await provider.preflight?.()
  const gateOpts = { iouThreshold: args.iouThreshold, concurrency: args.concurrency, cache: args.cache }

  // --- A ---------------------------------------------------------------------
  const source = args.ir === "-" ? JSON.parse(await readStdin()) : path.resolve(args.ir)
  const design = await intake(source)
  await writeFile(
    path.join(workdir, "design.normalised.json"),
    JSON.stringify(design, null, 2),
    "utf-8"
  )

  // --- B ---------------------------------------------------------------------
  const resolution = await resolveComponents(design, workdir, provider, gateOpts)
  await writeFile(
    path.join(workdir, "resolution.json"),
    JSON.stringify(
      {
        resolved: resolution.resolutions.map((r) => ({
          ref_id: r.component.ref_id,
          part_number: r.component.part_number,
          declared_package: r.component.package,
          ok: r.ok,
          tier: r.tier,
          lcsc: r.lcsc ?? null,
          footprint: r.footprinter ?? null,
          iou: r.iou ?? null,
          import_name: r.chip?.exportName ?? null,
          pin_count: r.chip?.pinCount ?? null,
          placeholder_pins: r.chip?.placeholderPins?.length ?? 0,
          substituted: r.substituted ?? null,
          gate_notes: r.gates?.notes ?? [],
          gate_failures: r.gates?.failures ?? [],
          tried: r.tried ?? [],
          reason: r.reason ?? null,
        })),
      },
      null,
      2
    ),
    "utf-8"
  )

  // --- C ---------------------------------------------------------------------
  const brief = synthesiseBrief(design, resolution)

  // --- D ---------------------------------------------------------------------
  // claude-code is agentic: it reads the imports and has built clean boards
  // freehand. The chat-API models do far better choosing pins than writing
  // tscircuit, so they default to the structured path (DECISIONS D-011).
  const strategy = args.strategy === "auto" ? (provider.name === "claude-code" ? "freeform" : "structured") : args.strategy
  if (!["structured", "freeform"].includes(strategy)) throw new Error(`unknown --strategy "${args.strategy}"`)
  note(`  strategy: ${strategy}`)
  const structured =
    strategy === "structured" ? await generateStructured(design, brief, resolution, provider, workdir) : null
  if (!structured) await generateProject(design, brief, provider, workdir)

  // --- E (build, then verify and repair) -------------------------------------
  //
  // tscircuit checks placement BEFORE routing and skips the autorouter entirely
  // if placement fails, so a single misplaced part costs every trace on the
  // board. On a real run one DIP-40 sitting 12.93mm past the edge produced 63
  // error elements and zero traces. The DRC messages name the component and the
  // distance, which is enough for a repair pass, so the build is verified and
  // retried rather than shipped broken.
  let outputs = await buildOutputs(workdir, {})

  // Structured boards: footprint defects and an undersized outline are fixed
  // in code (lib/structured-fixes.mjs) before any model repair is considered.
  if (structured) outputs = await applyStructuredFixes(structured, outputs, () => buildOutputs(workdir, {}))

  // A freehand repair would rewrite the emitted board.tsx — and the repair
  // prompt tells the model to use grid layout, which is exactly what the
  // structured path replaced (lib/placement.mjs). Structured boards are fixed
  // in code above, not repaired freehand.
  const repairAttempts = structured ? 0 : args.repairAttempts
  for (let attempt = 1; attempt <= repairAttempts && outputs.stats.errors > 0; attempt++) {
    const placementErrors = outputs.circuitJson.filter(
      (e) => e.type.includes("error") && !e.type.startsWith("pcb_port_not_connected")
    )
    if (placementErrors.length === 0) break

    // Cap the list: the cascade repeats one root cause many times, and the
    // distinct messages are what the repair needs.
    const seen = new Set()
    const distinct = []
    for (const e of placementErrors) {
      const message = `${e.type}: ${e.message ?? ""}`
      if (seen.has(message)) continue
      seen.add(message)
      distinct.push(message)
      if (distinct.length >= 25) break
    }

    note(`\n  repair ${attempt}/${args.repairAttempts}: ${outputs.stats.errors} error(s), ${distinct.length} distinct`)
    stage("E", "running", `repair pass ${attempt} — ${outputs.stats.errors} error(s)`)

    // A failed repair must not lose a board that already builds. The pass is an
    // improvement attempt on top of a result we already have, so a provider that
    // errors — a rejected reply, a rate limit, invalid source — ends the repair
    // loop and keeps the last good outputs instead of failing the whole run.
    // Each provider reads src/board.tsx itself (there is no separate floorplan
    // file any more — placement is automatic via layoutMode="grid").
    // Kept so a repair that makes things worse can be undone: the pass
    // rewrites src/board.tsx in place.
    const boardPath = path.join(workdir, "src", "board.tsx")
    const previousBoard = await readFile(boardPath, "utf-8").catch(() => null)
    try {
      await provider.repair({ workdir, errors: distinct.join("\n") })
    } catch (err) {
      note(`  repair ${attempt} failed: ${err.message}`)
      stage("E", "running", `repair pass ${attempt} failed — keeping the previous board`)
      break
    }

    const retried = await buildOutputs(workdir, {}).catch((err) => {
      note(`  repair ${attempt} produced a board that does not build: ${err.message}`)
      return null
    })
    if (!retried || (retried.stats.errors >= outputs.stats.errors && retried.stats.traces <= outputs.stats.traces)) {
      // This used to keep the repaired board even when it was worse — the
      // files on disk had already been overwritten. Put the previous source
      // back and rebuild it, so the run ends on the better board.
      note(`  repair ${attempt} did not improve the board; restoring the previous one and stopping`)
      if (previousBoard !== null) {
        await writeFile(boardPath, previousBoard, "utf-8")
        outputs = await buildOutputs(workdir, {})
      }
      break
    }
    outputs = retried
  }

  if (args.failOnError && outputs.stats.errors > 0) {
    const err = new Error(
      `${outputs.stats.errors} DRC error element(s): ${outputs.stats.errorTypes.join(", ")}`
    )
    err.stage = "E"
    throw err
  }

  // --- F ---------------------------------------------------------------------
  let gltfStats = null
  if (!args.skip3d) {
    gltfStats = await buildGltf(outputs.outDir)
  }

  const rel = (p) => path.relative(workdir, p).split(path.sep).join("/")
  const files = {
    circuitJson: rel(path.join(outputs.outDir, "circuit.json")),
    schematicSvg: rel(path.join(outputs.outDir, "schematic.svg")),
    pcbSvg: rel(path.join(outputs.outDir, "pcb.svg")),
    bomCsv: rel(path.join(outputs.outDir, "bom.csv")),
    pickAndPlaceCsv: rel(path.join(outputs.outDir, "pick-and-place.csv")),
    gerbersDir: rel(path.join(outputs.outDir, "gerbers")),
    // The whole Gerber set as one archive. `gerbersDir` stays because the loose
    // files are still on disk and still the thing to look at; the zip is what a
    // browser can actually hand to somebody, and what a fabricator expects.
    gerbersZip: rel(path.join(outputs.outDir, "gerbers.zip")),
    designBrief: "design-brief.md",
    resolution: "resolution.json",
  }
  if (gltfStats) {
    files.boardGlb = rel(path.join(outputs.outDir, "board.glb"))
    files.boardGltfJson = rel(path.join(outputs.outDir, "board.gltf.json"))
  }

  const sizes = {}
  for (const [key, relPath] of Object.entries(files)) {
    if (key === "gerbersDir") continue
    try {
      sizes[key] = (await stat(path.join(workdir, relPath))).size
    } catch {
      /* optional output */
    }
  }

  result({
    outDir: workdir,
    designName: design.design_name,
    files,
    sizes,
    stats: {
      ...outputs.stats,
      resolvedComponents: resolution.resolved.length,
      unresolvedComponents: resolution.unresolved.length,
      placeholderPinComponents: resolution.placeholders.length,
      substitutedComponents: resolution.substituted.length,
      gltf: gltfStats,
      // Open connections the architecture asked for and the parts cannot do;
      // the workspace offers to revise the architecture around them.
      mismatches: structured?.mismatches ?? [],
      supportParts: structured?.support?.length ?? 0,
    },
  })

  note(`\ndone: ${workdir}`)
  process.exit(args.failOnError && outputs.stats.errors > 0 ? 1 : 0)
}

main().catch((err) => {
  failure(err.stage ?? "?", err.message)
  note(err.stack ?? String(err))
  process.exit(1)
})
