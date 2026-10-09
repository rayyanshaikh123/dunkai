/**
 * Support parts every real board needs and no pcb_ir lists: decoupling
 * capacitors, bulk capacitance, I2C pull-ups, reset pull-ups.
 *
 * These are rules, not judgement, so they are applied in code. claude-code
 * adds them on its own when it writes a board freehand (the fresh-v2 reference
 * has C4, C5, C8, C9); the structured path had none until now.
 *
 * Every part here is a tscircuit built-in passive (`<capacitor>`,
 * `<resistor>`), so nothing depends on a catalogue lookup that could fail, and
 * each carries a JLCPCB *basic* part number so the BOM is orderable as-is.
 *
 * Deliberately conservative:
 * - Pull-ups go only on EXPLICITLY active-low reset pins (NRST, RST_N, ...).
 *   An 8051's RST is active HIGH — a blanket "pull RST up" rule would hold it
 *   in reset forever — and an EN_N needs pulling DOWN. Unknown polarity: leave it.
 * - I2C pull-ups once per bus, to the supply of a part actually on that bus,
 *   and only when the bus has at least two parts on it.
 * - A part with no supply pin on a rail gets no decoupling (a display, a
 *   passive network): there is nothing to decouple.
 */

/** JLCPCB basic parts: in stock, no extended-part setup fee. */
export const PASSIVES = {
  decoupling: { kind: "capacitor", value: "100nF", footprint: "0402", jlcpcb: "C1525" },
  bulk: { kind: "capacitor", value: "10uF", footprint: "0603", jlcpcb: "C19702" },
  i2cPullUp: { kind: "resistor", value: "4.7k", footprint: "0402", jlcpcb: "C25900" },
  resetPullUp: { kind: "resistor", value: "10k", footprint: "0402", jlcpcb: "C25744" },
}

/** At most this many 100 nF per part: a 40-pin MCU with 4 VDD pins gets 3, not 4+. */
const MAX_DECOUPLING_PER_PART = 3

const ACTIVE_LOW_RESET = /^(N_?RST|N_?RESET|RST_?N|RESET_?N|RSTB|RESETB|NRSTIN)$/i

const isGroundNet = (net) => net.net_class === "ground" || net.members.every((m) => m.role === "GROUND")
const isSupplyNet = (net) =>
  !isGroundNet(net) && (net.net_class === "power" || net.members.some((m) => m.role === "SUPPLY"))

/**
 * @param {object} design       normalised design
 * @param {object[]} resolutions Stage B resolutions
 * @param {object} mapping       pin map, answers applied (assignments is extended
 *                               in place for reset pins pulled up here)
 * @returns {Array<{ref: string, kind: string, value: string, footprint: string,
 *   jlcpcb: string, connections: {pin1: string, pin2: string}, near: string, why: string}>}
 */
export function supportParts(design, resolutions, mapping) {
  const supplyNets = new Set(design.nets.filter(isSupplyNet).map((n) => n.name))
  const groundNets = new Set(design.nets.filter(isGroundNet).map((n) => n.name))
  const defaultGround = [...groundNets][0] ?? null

  const parts = []
  let c = 0
  let r = 0
  const add = (spec, connections, near, why) => {
    const ref = spec.kind === "capacitor" ? `C${++c + 100}` : `R${++r + 100}`
    parts.push({ ref, kind: spec.kind, value: spec.value, footprint: spec.footprint, jlcpcb: spec.jlcpcb, connections, near, why })
  }

  // Which supply and ground net each part actually has pins on.
  const railsOf = (ref) => {
    const pins = Object.entries(mapping.assignments[ref] ?? {})
    return {
      supply: pins.filter(([, n]) => supplyNets.has(n)),
      ground: pins.find(([, n]) => groundNets.has(n))?.[1] ?? null,
    }
  }

  // --- decoupling: 100 nF per supply pin, at the part ------------------------
  for (const res of resolutions) {
    if (!res.ok) continue
    const ref = res.component.ref_id
    const { supply, ground } = railsOf(ref)
    const gnd = ground ?? defaultGround
    if (!supply.length || !gnd) continue
    if (res.component.board_profile === "tlv75533-dbv") {
      for (const pin of ["pin1", "pin5"]) {
        const net = mapping.assignments[ref]?.[pin]
        if (net) add(PASSIVES.bulk, { pin1: net, pin2: gnd }, ref, `local input/output capacitor for ${ref}.${pin}; TI requires at least 1uF effective capacitance`)
      }
    }
    for (const [pin, net] of supply.slice(0, MAX_DECOUPLING_PER_PART)) {
      add(PASSIVES.decoupling, { pin1: net, pin2: gnd }, ref, `decoupling for ${ref}.${pin} on ${net}`)
    }
  }

  // --- bulk: one 10 uF per rail, at the part with the most supply pins on it --
  for (const rail of supplyNets) {
    let best = null
    for (const res of resolutions) {
      if (!res.ok) continue
      const ref = res.component.ref_id
      const count = railsOf(ref).supply.filter(([, n]) => n === rail).length
      const processing = res.component.part_class === "processing" ? 0.5 : 0
      if (count && (!best || count + processing > best.score)) best = { ref, score: count + processing }
    }
    const gnd = best ? railsOf(best.ref).ground ?? defaultGround : null
    if (best && gnd) add(PASSIVES.bulk, { pin1: rail, pin2: gnd }, best.ref, `bulk capacitance on ${rail}`)
  }

  // --- I2C pull-ups: one pair per bus --------------------------------------------
  const isI2c = (net) => net.interface === "I2C"
  const connectedRefs = (netName) =>
    Object.entries(mapping.assignments)
      .filter(([, pins]) => Object.values(pins).includes(netName))
      .map(([ref]) => ref)
  for (const net of design.nets.filter(isI2c)) {
    const refs = connectedRefs(net.name)
    if (refs.length < 2) continue
    // The bus is pulled to the supply of a part on it; the controller's first.
    const controller =
      refs.find((ref) => resolutions.find((x) => x.component?.ref_id === ref)?.component.part_class === "processing") ?? refs[0]
    const rail = railsOf(controller).supply[0]?.[1] ?? refs.map((x) => railsOf(x).supply[0]?.[1]).find(Boolean)
    if (!rail) continue
    add(PASSIVES.i2cPullUp, { pin1: net.name, pin2: rail }, controller, `I2C pull-up on ${net.name}`)
  }

  // --- active-low reset pins: 10 k to the part's own supply ---------------------
  for (const res of resolutions) {
    if (!res.ok || !res.chip) continue
    const ref = res.component.ref_id
    const rail = railsOf(ref).supply[0]?.[1]
    if (!rail) continue
    for (const [pin, labels] of Object.entries(res.chip.pinLabels)) {
      if (!labels.some((l) => ACTIVE_LOW_RESET.test(l))) continue
      if (mapping.assignments[ref]?.[pin]) continue
      const net = `${ref}_${labels[0].toUpperCase()}`
      ;(mapping.assignments[ref] ??= {})[pin] = net
      add(PASSIVES.resetPullUp, { pin1: net, pin2: rail }, ref, `pull-up holding ${ref}.${labels[0]} out of reset`)
    }
  }

  return parts
}
