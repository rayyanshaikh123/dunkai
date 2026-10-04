/**
 * board.tsx from a pin mapping — written by code, not by a model.
 *
 * Every freehand-generation failure on record (DECISIONS D-008) was a failure
 * to write this file: a `<>` fragment instead of `<board>`, an invented
 * `<component>` element, a duplicated `);`, the skeleton's example part copied
 * verbatim, a net referenced but never declared. None of those can happen
 * here. The shape is fixed, every net that is referenced is declared, every
 * part is imported by its real export name, and every connection key is a pin
 * that exists on that part (lib/pinmap.mjs only ever assigns real pins).
 */

const NET_NAME = (name) => String(name).replace(/[^A-Za-z0-9_]/g, "_")
const pinOrder = (a, b) => Number(a.replace(/^pin/, "")) - Number(b.replace(/^pin/, ""))
const q = (value) => JSON.stringify(String(value))

/**
 * @param {object} design       normalised design (Stage A)
 * @param {object[]} resolutions Stage B resolutions
 * @param {object} mapping       lib/pinmap.mjs result, answers applied
 * @param {{ widthMm?: number, heightMm?: number, placement?: Record<string, {x: number, y: number}> }} [size]
 *   board outline override, and part coordinates from lib/placement.mjs. With
 *   no placement the board uses layoutMode="grid" (only for the first build,
 *   which exists to measure footprints).
 * @param {object[]} [support]  passives from lib/support-parts.mjs
 * @returns {{ boardTsx: string, indexTsx: string, nets: string[] }}
 */
export function emitBoard(design, resolutions, mapping, size = {}, support = []) {
  // Names become tscircuit identifiers below. Distinct input nets must never
  // collapse to one identifier: that would silently join separate copper nets.
  const originalByIdentifier = new Map()
  const checkNet = (name) => {
    const original = String(name)
    const identifier = NET_NAME(original)
    const existing = originalByIdentifier.get(identifier)
    if (existing !== undefined && existing !== original) {
      throw new Error(`net names ${JSON.stringify(existing)} and ${JSON.stringify(original)} both become ${JSON.stringify(identifier)}`)
    }
    originalByIdentifier.set(identifier, original)
  }
  for (const net of design.nets) checkNet(net.name)
  for (const pins of Object.values(mapping.assignments)) Object.values(pins).forEach(checkNet)
  for (const part of support) Object.values(part.connections).forEach(checkNet)

  const c = design.constraints
  const width = size.widthMm ?? c.board_outline.width_mm
  const height = size.heightMm ?? c.board_outline.height_mm
  const layers = c.layer_count ?? 2

  const parts = resolutions.filter((r) => r.ok)

  // Only nets with at least two pins on the board. A net with one pin (its
  // other end answered NONE, or was omitted) connects nothing, and tscircuit
  // reports the lone port as "not connected by a PCB trace" — an error about a
  // wire that should simply not exist.
  const pinCount = {}
  const count = (net) => (pinCount[NET_NAME(net)] = (pinCount[NET_NAME(net)] ?? 0) + 1)
  for (const pins of Object.values(mapping.assignments)) Object.values(pins).forEach(count)
  for (const s of support) Object.values(s.connections).forEach(count)
  const used = new Set(Object.keys(pinCount).filter((n) => pinCount[n] >= 2))
  // The design's nets in their own order, then any the support parts created
  // (a reset pin's pull-up net, e.g. U1_NRST).
  const designNets = design.nets.map((n) => NET_NAME(n.name))
  const nets = [
    ...designNets.filter((n, i, all) => used.has(n) && all.indexOf(n) === i),
    ...[...used].filter((n) => !designNets.includes(n)).sort(),
  ]

  const imports = parts
    .filter((r) => r.chip?.exportName)
    .map((r) => `import { ${r.chip.exportName} } from "../imports/${r.chip.exportName}"`)
    .filter((line, i, all) => all.indexOf(line) === i)

  const placement = size.placement ?? null
  const placeProp = (ref) => {
    const at = placement?.[ref]
    return at ? `\n      pcbX={${at.x}}\n      pcbY={${at.y}}` : ""
  }

  const connectionsProp = (ref) => {
    const pins = mapping.assignments[ref] ?? {}
    const keys = Object.keys(pins).filter((k) => used.has(NET_NAME(pins[k]))).sort(pinOrder)
    if (!keys.length) return ""
    const body = keys.map((k) => `        ${k}: ${q(`net.${NET_NAME(pins[k])}`)},`).join("\n")
    return `\n      connections={{\n${body}\n      }}`
  }

  const elements = parts.map((r) => {
    const ref = r.component.ref_id
    if (r.chip?.exportName) {
      return `    <${r.chip.exportName}\n      name=${q(ref)}${placeProp(ref)}${connectionsProp(ref)}\n    />`
    }
    // Tier 5: no catalogue symbol, a synthesised footprint with numbered pads.
    return (
      `    <chip\n      name=${q(ref)}\n      footprint=${q(r.footprinter)}\n` +
      `      manufacturerPartNumber=${q(r.component.part_number)}${placeProp(ref)}${connectionsProp(ref)}\n    />`
    )
  })

  // Built-in passives (lib/support-parts.mjs): no import, no catalogue lookup.
  for (const s of support) {
    const props = s.kind === "capacitor" ? `capacitance=${q(s.value)}` : `resistance=${q(s.value)}`
    const conns = Object.entries(s.connections)
      .filter(([, net]) => used.has(NET_NAME(net)))
      .map(([pin, net]) => `        ${pin}: ${q(`net.${NET_NAME(net)}`)},`)
    if (conns.length < 2) continue
    elements.push(
      `    <${s.kind}\n      name=${q(s.ref)}\n      ${props}\n      footprint=${q(s.footprint)}\n` +
        `      supplierPartNumbers={{ jlcpcb: [${q(s.jlcpcb)}] }}${placeProp(s.ref)}\n` +
        `      connections={{\n${conns.join("\n")}\n      }}\n    />`
    )
  }

  const boardTsx = [
    "// Generated by dunkai-designer from the pin mapping in pinmap.json.",
    "// Edit the mapping, not this file: it is rewritten on every run.",
    ...imports,
    "",
    "export default () => (",
    `  <board width=${q(`${width}mm`)} height=${q(`${height}mm`)} layers={${layers}} autorouter="auto"${placement ? "" : ' layoutMode="grid" pcbGridGap="2mm"'}>`,
    ...nets.map((n) => `    <net name=${q(n)} />`),
    "",
    elements.join("\n"),
    "  </board>",
    ")",
    "",
  ].join("\n")

  const indexTsx = 'import Board from "./src/board"\nexport default Board\n'
  return { boardTsx, indexTsx, nets }
}
