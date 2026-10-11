/**
 * Placement in code, for the structured path.
 *
 * Measured on fresh-v2: the same nine parts route cleanly (37 traces) when
 * placed by coordinates, and route NOTHING under layoutMode="grid" — grid
 * layout rotates parts (the TP4110 to -90 deg), the rotated DFN-16 fails pad
 * clearance against itself (76 errors), and tscircuit skips the autorouter for
 * the whole board when placement DRC finds anything. Placement DRC is
 * board-wide; there is no per-part exemption. So placement is done here.
 *
 * Shelf packing, every part at 0 deg, using the real footprint sizes from a
 * first build's Circuit JSON. Parts are taken in connectivity order — breadth
 * first from the most-connected part — so a sensor lands next to the MCU it
 * talks to rather than wherever a grid slot falls. The board grows to fit,
 * never below the size the design asked for.
 */

const GAP_MM = 3
const MARGIN_MM = 4
/** Between a chip and its support parts, and between those parts. */
const KID_GAP_MM = 1

/**
 * Space each part needs, unrotated, from a built circuit: the larger of its
 * body and its COURTYARD (the keep-out tscircuit checks overlaps against,
 * often bigger than the body and not always centred on it). Packing by body
 * size alone left "Courtyard of U2 overlaps with courtyard of U10" on a real
 * run — one placement error, and the autorouter skipped the whole board.
 */
export function footprintSizes(circuitJson) {
  const names = new Map()
  for (const e of circuitJson) if (e.type === "source_component") names.set(e.source_component_id, e.name)

  const courtyards = new Map()
  const grow = (id, xs, ys) => {
    const box = courtyards.get(id) ?? { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
    box.minX = Math.min(box.minX, ...xs)
    box.maxX = Math.max(box.maxX, ...xs)
    box.minY = Math.min(box.minY, ...ys)
    box.maxY = Math.max(box.maxY, ...ys)
    courtyards.set(id, box)
  }
  for (const e of circuitJson) {
    if (e.type === "pcb_courtyard_outline" && e.outline?.length) {
      grow(e.pcb_component_id, e.outline.map((p) => p.x), e.outline.map((p) => p.y))
    } else if (e.type === "pcb_courtyard_rect" && e.center) {
      grow(e.pcb_component_id, [e.center.x - e.width / 2, e.center.x + e.width / 2], [e.center.y - e.height / 2, e.center.y + e.height / 2])
    }
  }

  const sizes = {}
  for (const e of circuitJson) {
    if (e.type !== "pcb_component") continue
    const ref = names.get(e.source_component_id)
    if (!ref) continue
    let w = e.width
    let h = e.height
    const box = courtyards.get(e.pcb_component_id)
    if (box && e.center) {
      // Reserve the courtyard symmetrically about the part's centre, so an
      // off-centre courtyard is still fully covered at any position.
      const halfX = Math.max(Math.abs(box.maxX - e.center.x), Math.abs(e.center.x - box.minX))
      const halfY = Math.max(Math.abs(box.maxY - e.center.y), Math.abs(e.center.y - box.minY))
      w = Math.max(w, 2 * halfX)
      h = Math.max(h, 2 * halfY)
    }
    const quarterTurns = Math.round((e.rotation ?? 0) / 90)
    const swapped = Math.abs(quarterTurns) % 2 === 1
    sizes[ref] = { w: swapped ? h : w, h: swapped ? w : h }
  }
  return sizes
}

/** Breadth-first from the most-connected part, strongest links first. */
function connectivityOrder(refs, assignments) {
  const netsOf = {}
  for (const ref of refs) netsOf[ref] = new Set(Object.values(assignments[ref] ?? {}))
  // Power and ground connect everything to everything; they say nothing about
  // which parts belong together.
  const isRail = (net) => /^(GND|POWER_RAIL|VCC|VDD|3V3|5V)$/i.test(net)
  const weight = (a, b) => [...netsOf[a]].filter((n) => !isRail(n) && netsOf[b].has(n)).length

  const degree = (ref) => refs.reduce((sum, other) => sum + (other === ref ? 0 : weight(ref, other)), 0)
  const remaining = new Set(refs)
  const order = []
  while (remaining.size) {
    const start = [...remaining].sort((a, b) => degree(b) - degree(a))[0]
    const queue = [start]
    remaining.delete(start)
    while (queue.length) {
      const ref = queue.shift()
      order.push(ref)
      const next = [...remaining].filter((o) => weight(ref, o) > 0).sort((a, b) => weight(ref, b) - weight(ref, a))
      for (const o of next) {
        remaining.delete(o)
        queue.push(o)
      }
    }
  }
  return order
}

/**
 * @param {Record<string, {w: number, h: number}>} sizes  from footprintSizes()
 * @param {Record<string, Record<string, string>>} assignments  pin map
 * @param {{ widthMm: number, heightMm: number }} minimum  the design's outline
 * @param {Record<string, string>} [attach]  support part -> the part it serves.
 *   A decoupling capacitor is only useful next to its chip, so each chip is
 *   packed as a block with its support parts in a row directly beneath it.
 * @returns {{ placement: Record<string, {x: number, y: number}>, widthMm: number, heightMm: number }}
 */
export function packParts(partSizes, assignments, minimum, attach = {}, gapMm = GAP_MM) {
  const gap = Number.isFinite(gapMm) ? Math.max(GAP_MM, gapMm) : GAP_MM
  // Collapse each part and its attached support parts into one block.
  const kidsOf = {}
  for (const [kid, host] of Object.entries(attach)) {
    if (partSizes[kid] && partSizes[host]) (kidsOf[host] ??= []).push(kid)
  }
  const attached = new Set(Object.values(kidsOf).flat())
  const sizes = {}
  for (const [ref, s] of Object.entries(partSizes)) {
    if (attached.has(ref)) continue
    const kids = kidsOf[ref] ?? []
    const rowW = kids.reduce((sum, k) => sum + partSizes[k].w, 0) + KID_GAP_MM * Math.max(0, kids.length - 1)
    const rowH = Math.max(0, ...kids.map((k) => partSizes[k].h))
    sizes[ref] = { w: Math.max(s.w, rowW), h: s.h + (kids.length ? KID_GAP_MM + rowH : 0), partH: s.h, rowW, rowH, kids }
  }

  const refs = Object.keys(sizes)
  const order = connectivityOrder(refs, assignments)
  const widest = Math.max(0, ...refs.map((r) => sizes[r].w))
  const area = refs.reduce((sum, r) => sum + (sizes[r].w + gap) * (sizes[r].h + gap), 0)

  // Start from the requested width (or what the widest part needs) and widen
  // until the packed board is no taller than it is wide.
  let width = Math.max(minimum.widthMm, widest + 2 * MARGIN_MM, Math.sqrt(area * 1.3))
  for (let attempt = 0; attempt < 12; attempt++) {
    const usable = width - 2 * MARGIN_MM
    const rows = []
    let row = { items: [], width: 0, height: 0 }
    for (const ref of order) {
      const { w, h } = sizes[ref]
      const needed = row.items.length ? row.width + gap + w : w
      if (row.items.length && needed > usable) {
        rows.push(row)
        row = { items: [], width: 0, height: 0 }
      }
      row.items.push(ref)
      row.width = row.items.length === 1 ? w : row.width + gap + w
      row.height = Math.max(row.height, h)
    }
    if (row.items.length) rows.push(row)

    const contentHeight = rows.reduce((sum, r) => sum + r.height, 0) + gap * Math.max(0, rows.length - 1)
    const height = Math.max(minimum.heightMm, contentHeight + 2 * MARGIN_MM)
    if (height > width * 1.1 && attempt < 11) {
      width *= 1.15
      continue
    }

    // Board centred on the origin; rows from the top, parts from the left,
    // each row centred horizontally.
    const placement = {}
    let top = height / 2 - MARGIN_MM
    for (const r of rows) {
      let x = -r.width / 2
      for (const ref of r.items) {
        const block = sizes[ref]
        const cx = x + block.w / 2
        const blockTop = top - (r.height - block.h) / 2
        placement[ref] = { x: round(cx), y: round(blockTop - block.partH / 2) }
        // Support parts in a row under their chip.
        let kx = cx - block.rowW / 2
        const ky = blockTop - block.partH - KID_GAP_MM - block.rowH / 2
        for (const kid of block.kids) {
          placement[kid] = { x: round(kx + partSizes[kid].w / 2), y: round(ky) }
          kx += partSizes[kid].w + KID_GAP_MM
        }
        x += block.w + gap
      }
      top -= r.height + gap
    }
    return { placement, widthMm: Math.ceil(width), heightMm: Math.ceil(height) }
  }
  throw new Error("placement did not converge")
}

const round = (v) => Math.round(v * 100) / 100
