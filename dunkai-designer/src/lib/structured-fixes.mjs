/**
 * The structured path's model-free build fixes, shared by the CLI and the
 * eval so both measure the same pipeline.
 *
 * 1. Place in code (lib/placement.mjs): the first build uses grid layout only
 *    to learn each footprint's real size; the parts are then packed at 0 deg
 *    in connectivity order and the board rebuilt with explicit coordinates.
 *    Grid layout rotates parts and can leave a board unroutable — see
 *    lib/placement.mjs for the measurement.
 * 2. Parts still outside the board mean the outline is too small: grow it
 *    30%, up to three times.
 *
 * A step is kept only when it does not make the board worse.
 */

import { note, stage } from "./events.mjs"
import { hasOffBoardParts } from "./drc.mjs"
import { footprintSizes, packParts } from "./placement.mjs"

const better = (next, prev) =>
  next.stats.traces > prev.stats.traces ||
  (next.stats.traces === prev.stats.traces && next.stats.errors <= prev.stats.errors)

export async function applyStructuredFixes(structured, outputs, build) {
  const sizes = footprintSizes(outputs.circuitJson)
  const attach = Object.fromEntries((structured.support ?? []).map((s) => [s.ref, s.near]))
  if (Object.keys(sizes).length) {
    const packed = packParts(
      sizes,
      structured.mapping.assignments,
      { widthMm: structured.size.widthMm, heightMm: structured.size.heightMm },
      attach
    )
    const before = { ...structured.size }
    structured.size.placement = packed.placement
    structured.size.widthMm = packed.widthMm
    structured.size.heightMm = packed.heightMm
    note(`  placed ${Object.keys(packed.placement).length} part(s) in code on a ${packed.widthMm} x ${packed.heightMm} mm board`)
    stage("E", "running", `parts placed in code — ${packed.widthMm} x ${packed.heightMm} mm`)
    await structured.emit()
    const placed = await build()
    if (better(placed, outputs)) outputs = placed
    else {
      note("  code placement did not improve the board; keeping grid layout")
      Object.assign(structured.size, before)
      delete structured.size.placement
      await structured.emit()
    }
  }

  for (let grow = 1; grow <= 3 && hasOffBoardParts(outputs.circuitJson); grow++) {
    structured.size.widthMm = Math.round(structured.size.widthMm * 1.3)
    structured.size.heightMm = Math.round(structured.size.heightMm * 1.3)
    note(`  parts outside the board — growing it to ${structured.size.widthMm} x ${structured.size.heightMm} mm`)
    stage("E", "running", `board grown to ${structured.size.widthMm} x ${structured.size.heightMm} mm`)
    await structured.emit()
    const grown = await build()
    if (grown.stats.errors > outputs.stats.errors) break
    outputs = grown
  }

  // A valid source net can still have an unrouted PCB port. Give the
  // autorouter a few more spacious, deterministic placements before failing a
  // required-device connection. This keeps the electrical contract strict:
  // a route error is never waived; the board is rebuilt until it routes or the
  // final required-connection gate reports the open pin.
  const unrouted = (result) => result.circuitJson.filter((e) => e.type === "pcb_port_not_connected_error").length
  if (unrouted(outputs) > 0 && Object.keys(sizes).length) {
    const base = { widthMm: structured.size.widthMm, heightMm: structured.size.heightMm }
    const snapshot = () => ({
      widthMm: structured.size.widthMm,
      heightMm: structured.size.heightMm,
      placement: structured.size.placement ? { ...structured.size.placement } : null,
    })
    const restore = (saved) => {
      structured.size.widthMm = saved.widthMm
      structured.size.heightMm = saved.heightMm
      if (saved.placement) structured.size.placement = { ...saved.placement }
      else delete structured.size.placement
    }
    let best = outputs
    let bestLayout = snapshot()
    let current = outputs
    for (const gap of [5, 7, 10]) {
      const packed = packParts(sizes, structured.mapping.assignments, base, attach, gap)
      structured.size.widthMm = packed.widthMm
      structured.size.heightMm = packed.heightMm
      structured.size.placement = packed.placement
      note(`  ${unrouted(current)} PCB port(s) remain unrouted — retrying placement with ${gap}mm part spacing`)
      stage("E", "running", `retry routing with ${gap}mm part spacing`)
      await structured.emit()
      current = await build()
      const routeErrors = unrouted(current)
      const bestRouteErrors = unrouted(best)
      if (routeErrors < bestRouteErrors ||
          (routeErrors === bestRouteErrors && (current.stats.errors < best.stats.errors ||
            (current.stats.errors === best.stats.errors && current.stats.traces > best.stats.traces)))) {
        best = current
        bestLayout = snapshot()
      }
      if (routeErrors === 0) {
        best = current
        bestLayout = snapshot()
        break
      }
    }
    if (best !== current) {
      restore(bestLayout)
      await structured.emit()
      outputs = await build()
    } else {
      restore(bestLayout)
      outputs = best
    }
  }
  return outputs
}
