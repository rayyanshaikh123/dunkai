/**
 * Deterministic pin mapping: which pad of each part sits on which net.
 *
 * Why this exists
 * ---------------
 * Every net member in a pcb_ir is an (interface, role) pair from a closed
 * vocabulary — (I2C, DATA), (SPI, CHIP_SELECT), (Power, GROUND) — and every
 * imported part carries its real pin labels and, for power, explicit
 * `requiresPower` / `requiresGround` attributes. For most pins the mapping is
 * therefore not a judgement call at all: (I2C, DATA) on a part with a pin
 * labelled SDA is that pin.
 *
 * Generating board.tsx freehand asked a model to rediscover all of that and to
 * write a DSL it barely knows at the same time. Smaller models failed at the
 * second job long before the first (a `<>` fragment, an invented `<component>`
 * element, a duplicated `);`, typo'd net names — DECISIONS D-008). Here the
 * mapping is done in code wherever the evidence allows, and only what is
 * genuinely ambiguous becomes a QUESTION: a multiple-choice ask over that
 * part's free pins, answered by a model and validated against the choices.
 *
 * The result is a plain table; lib/emit-board.mjs turns it into source.
 */

// ---------------------------------------------------------------------------
// Label vocabulary
// ---------------------------------------------------------------------------

/**
 * For each (interface, role): label patterns in tiers, most specific first.
 * A label matches when the whole label, or one of its tokens, matches — so
 * "UART0_TXD", "PB7/SDA" and "I2C1_SCL" all count. Within a tier the
 * lowest-numbered instance wins (SDA0 before SDA1), then the lowest pin.
 */
const ROLE_PATTERNS = {
  "I2C:CLOCK": [[/^SCL\d*$/, /^I2C\d*SCL$/], [/^SCK$/, /^SCLK$/, /^SPC$/]],
  "I2C:DATA": [[/^SDA\d*$/, /^I2C\d*SDA$/], [/^SDI$/, /^SDIO$/]],
  "SPI:CLOCK": [[/^SCK\d*$/, /^SCLK\d*$/, /^SPC$/, /^SPI\d*SCK$/, /^SPI\d*CLK$/], [/^DCLK$/, /^CLK$/, /^SCL$/]],
  "SPI:MOSI": [[/^MOSI\d*$/, /^COPI$/, /^SDI$/, /^DIN$/, /^SI$/, /^SPI\d*MOSI$/], [/^DI$/, /^SDA$/, /^DATA$/]],
  "SPI:MISO": [[/^MISO\d*$/, /^CIPO$/, /^SDO$/, /^DOUT$/, /^SO$/, /^SPI\d*MISO$/], [/^DO$/]],
  "SPI:CHIP_SELECT": [[/^N?CS\d*$/, /^CS[BN]$/, /^N?SS\d*$/, /^NSS$/, /^SPI\d*N?CS$/, /^SPI\d*N?SS$/], [/^LE$/, /^LAT(CH)?$/, /^STB$/]],
  "UART:TX": [[/^U?\d*TXD?\d*$/, /^UART\d*TXD?$/], []],
  "UART:RX": [[/^U?\d*RXD?\d*$/, /^UART\d*RXD?$/], []],
  "USB:DP": [[/^D\+$/, /^DP\d*$/, /^USB\d*DP$/, /^UDP$/, /^DPLUS$/], []],
  "USB:DM": [[/^D-$/, /^DM\d*$/, /^USB\d*DM$/, /^UDM$/, /^DMINUS$/, /^DN$/], []],
  "USB:VBUS": [[/^VBUS$/, /^VUSB$/, /^VBUS_?DET$/], []],
  "CAN:CAN_H": [[/^CANH$/, /^CAN_H$/], []],
  "CAN:CAN_L": [[/^CANL$/, /^CAN_L$/], []],
  "I2S:BIT_CLOCK": [[/^BCLK$/, /^BCK$/, /^I2S\d*SCK$/, /^SCK$/], []],
  "I2S:WORD_CLOCK": [[/^WS$/, /^LRCLK$/, /^LRCK$/, /^LRC$/, /^WSEL$/], []],
  "I2S:DATA": [[/^SD(ATA)?$/, /^DIN$/, /^DOUT$/, /^SDIN$/, /^SDOUT$/], []],
  "SDIO:CLOCK": [[/^SD_?CLK$/, /^CLK$/], []],
  "SDIO:CMD": [[/^SD_?CMD$/, /^CMD$/], []],
  "SDIO:DATA": [[/^SD_?DAT(A)?0$/, /^DAT(A)?0$/, /^D0$/], []],
  "OneWire:DATA": [[/^DQ\d*$/, /^1-?WIRE$/, /^OW$/, /^ONEWIRE$/], [/^DATA$/, /^IO$/]],
  "Ethernet:TXP": [[/^TX[P+]$/, /^TD\+$/, /^TXD?P$/], []],
  "Ethernet:TXN": [[/^TX[N-]$/, /^TD-$/, /^TXD?N$/], []],
  "Ethernet:RXP": [[/^RX[P+]$/, /^RD\+$/, /^RXD?P$/], []],
  "Ethernet:RXN": [[/^RX[N-]$/, /^RD-$/, /^RXD?N$/], []],
}

/** Supply and ground, when a part carries no pinAttributes to say so. */
const SUPPLY_LABEL = /^(VCC|VDD|VDDIO|VDDA|VDDD|AVDD|DVDD|VCCIO|VCCA|VIN|VS|V\+|3V3|3\.3V|5V)\d*$/
const GROUND_LABEL = /^(GND|VSS|AGND|DGND|PGND|SGND|GNDA|GNDD|VSSA|VSSD|V-)\d*$/

/**
 * Pins with a fixed job that must never be offered for a signal: reset, the
 * crystal, 8051 bus-control strobes, boot straps, the antenna, a thermal pad.
 */
const DEDICATED_LABEL = /^(N_?)?(RST|RESET|NRST|XTAL\d*|XIN|XOUT|OSC\w*|ALE|PSEN|EA|BOOT\d*|VREF\w*|ANT|EP|EPAD|THERMAL\w*|VBAT|VCHG|VMID|REXT)$/

/** Pins that look like general-purpose IO, for GPIO/PWM/ADC roles. */
const GPIO_LABEL = /^(GPIO\d+|IO\d+|P[A-K]\d+|P\d+[._]?\d+|D\d+|PIO\d+)$/
const ADC_LABEL = /^(ADC\d*|AIN\d*|A\d+|ADC\d+_?IN\d+)$/
const PWM_LABEL = /PWM/

/** Interfaces whose roles are interchangeable within a part (any free IO works). */
const GENERIC = new Set(["GPIO", "PWM", "ADC", "Analog", "Audio"])

const tokensOf = (label) => {
  const upper = String(label).toUpperCase().trim()
  const parts = upper.split(/[\/,\s]+/).filter(Boolean)
  const tokens = new Set([upper, ...parts])
  // I2C1_SDA, UART0_TXD -> also the pieces, and the joined form (UART0TXD).
  for (const p of parts) {
    if (p.includes("_")) {
      p.split("_").filter(Boolean).forEach((t) => tokens.add(t))
      tokens.add(p.replace(/_/g, ""))
    }
  }
  return [...tokens]
}

const labelMatches = (labels, re) => labels.some((label) => tokensOf(label).some((t) => re.test(t)))

const pinNumber = (key) => Number(String(key).replace(/^pin/, "")) || 0
const suffixNumber = (labels) => {
  const m = String(labels[0] ?? "").match(/(\d+)\D*$/)
  return m ? Number(m[1]) : 0
}

// ---------------------------------------------------------------------------
// Part model
// ---------------------------------------------------------------------------

/**
 * The pins of one resolved part, as the mapper sees them.
 *
 * Catalogue parts have labels and attributes. A tier-5 part (synthesised
 * footprint) has only numbered pads, so every one of its members becomes a
 * question; its pad count comes from the footprint check in Stage B.
 */
function partPins(resolution) {
  const chip = resolution.chip
  if (chip) {
    const attrs = chip.pinAttributes ?? {}
    return Object.entries(chip.pinLabels).map(([key, labels]) => {
      const placeholder = labels.length === 1 && labels[0] === key
      return {
        key,
        labels: placeholder ? [] : labels,
        requiresPower: Boolean(attrs[key]?.requiresPower),
        requiresGround: Boolean(attrs[key]?.requiresGround),
        doNotConnect: Boolean(attrs[key]?.doNotConnect) || labels.some((l) => /^N\.?C\.?\d*$/i.test(l)),
      }
    })
  }
  const pads = resolution.padCount ?? 0
  return Array.from({ length: pads }, (_, i) => ({
    key: `pin${i + 1}`,
    labels: [],
    requiresPower: false,
    requiresGround: false,
    doNotConnect: false,
  }))
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * @param {object} design      normalised design from Stage A
 * @param {object[]} resolutions Stage B resolutions (ok and not)
 * @returns {{
 *   assignments: Record<string, Record<string, string>>,  ref -> pinKey -> net
 *   members: object[],    one row per net member: how it was decided
 *   questions: object[],  what the code could not decide
 * }}
 */
export function mapPins(design, resolutions) {
  const parts = new Map()
  for (const r of resolutions) {
    if (!r.ok) continue
    parts.set(r.component.ref_id, { resolution: r, pins: partPins(r), used: new Set() })
  }

  const assignments = {}
  const members = []
  const questions = []

  const assign = (ref, pinKey, net) => {
    const part = parts.get(ref)
    part.used.add(pinKey)
    ;(assignments[ref] ??= {})[pinKey] = net
  }
  const record = (row) => members.push(row)

  const freePins = (part) => part.pins.filter((p) => !part.used.has(p.key) && !p.doNotConnect)
  /** Free pins a SIGNAL could use: not power, not ground, not a dedicated pin. */
  const signalCandidates = (part) =>
    freePins(part).filter(
      (p) =>
        !p.requiresPower &&
        !p.requiresGround &&
        !labelMatches(p.labels, SUPPLY_LABEL) &&
        !labelMatches(p.labels, GROUND_LABEL) &&
        !labelMatches(p.labels, DEDICATED_LABEL)
    )

  const ask = (part, ref, net, iface, role, candidates, why) => {
    const id = `q${questions.length + 1}`
    questions.push({
      id,
      ref_id: ref,
      part_number: part.resolution.component.part_number,
      package: part.resolution.component.package,
      net: net.name,
      interface: iface,
      role,
      candidates: candidates.map((p) => ({ pin: p.key, labels: p.labels })),
      why,
    })
    record({ ref_id: ref, net: net.name, interface: iface, role, pins: [], source: "question", question: id })
  }

  // Order matters: power first (it claims the most pins and is the most
  // certain), then specific signal roles, then generic IO last — so a GPIO
  // never takes the pin an SDA needed.
  const ordered = [...design.nets].sort((a, b) => rank(a) - rank(b))

  for (const net of ordered) {
    for (const member of net.members) {
      const ref = member.ref_id
      const part = parts.get(ref)
      if (!part) {
        record({ ref_id: ref, net: net.name, interface: net.interface, role: member.role, pins: [], source: "omitted", why: "part unresolved" })
        continue
      }
      const iface = net.interface
      const role = member.role
      const placeholdersLeft = part.pins.some((p) => !p.labels.length && !part.used.has(p.key))

      // Explicit LDO functions identify distinct rails. Selecting all supply
      // pins here would short the regulator input, enable and output together.
      // The function is verified against the resolved symbol, never promoted
      // directly from an asserted pad number.
      if (member.pin_function) {
        const functionName = member.pin_function.toUpperCase()
        const chosen = part.pins.filter((p) => !p.doNotConnect && p.labels.some((label) => String(label).toUpperCase() === functionName))
        if (!chosen.length) throw new Error(`${ref}: no verified pin for function ${functionName}`)
        for (const pin of chosen) {
          if (part.used.has(pin.key) && assignments[ref]?.[pin.key] !== net.name) {
            throw new Error(`${ref}.${pin.key} cannot be assigned to two different rails`)
          }
          assign(ref, pin.key, net.name)
        }
        record({ ref_id: ref, net: net.name, interface: iface, role, pins: chosen.map((p) => p.key), source: "label", label: functionName })
        continue
      }

      // --- supply / ground: every matching pin, not just the first -----------
      if (role === "SUPPLY" || role === "GROUND") {
        const byAttr = freePins(part).filter((p) => (role === "SUPPLY" ? p.requiresPower : p.requiresGround))
        const byLabel = freePins(part).filter((p) =>
          labelMatches(p.labels, role === "SUPPLY" ? SUPPLY_LABEL : GROUND_LABEL)
        )
        // Attributes win, but only for the rail they actually describe: a part
        // that flags its grounds and not its supply still needs the label path
        // for the supply.
        const hasAttributes = part.pins.some((p) => (role === "SUPPLY" ? p.requiresPower : p.requiresGround))
        const chosen = hasAttributes ? byAttr : byLabel
        if (chosen.length) {
          chosen.forEach((p) => assign(ref, p.key, net.name))
          record({ ref_id: ref, net: net.name, interface: iface, role, pins: chosen.map((p) => p.key), source: hasAttributes ? "attribute" : "label" })
        } else if (placeholdersLeft) {
          ask(part, ref, net, iface, role, freePins(part).filter((p) => !p.labels.length), "no labelled supply/ground pin; part has unnamed pins")
        } else {
          // A display or passive network with no pin for this rail. Honest
          // omission beats a guessed connection that would short something.
          record({ ref_id: ref, net: net.name, interface: iface, role, pins: [], source: "none", why: `no ${role.toLowerCase()} pin on this part` })
        }
        continue
      }

      // --- schema 1.0: role SIGNAL plus a CLAIMED pin name -----------------
      // The claim was made without consulting the part (intake.mjs), so it is
      // verified here: an exact label match is used; otherwise the claimed
      // name is used only to tell which role on the interface was meant.
      let effectiveRole = role
      if (role === "SIGNAL" && member.asserted_pin) {
        const claim = String(member.asserted_pin).toUpperCase()
        const exact = signalCandidates(part).find((p) => p.labels.some((l) => tokensOf(l).includes(claim)))
        if (exact) {
          assign(ref, exact.key, net.name)
          record({ ref_id: ref, net: net.name, interface: iface, role, pins: [exact.key], source: "label", label: `${exact.labels.join("/")} (claimed ${member.asserted_pin}, verified)` })
          continue
        }
        const inferred = Object.keys(ROLE_PATTERNS).find(
          (key) => key.startsWith(`${iface}:`) && ROLE_PATTERNS[key].some((tier) => tier.some((re) => re.test(claim)))
        )
        if (inferred) effectiveRole = inferred.split(":")[1]
      }

      // --- specific roles: label patterns, tier by tier ---------------------
      const tiers = ROLE_PATTERNS[`${iface}:${effectiveRole}`]
      if (tiers) {
        let pick = null
        for (const tier of tiers) {
          const hits = freePins(part).filter((p) => tier.some((re) => labelMatches(p.labels, re)))
          if (hits.length) {
            hits.sort((a, b) => suffixNumber(a.labels) - suffixNumber(b.labels) || pinNumber(a.key) - pinNumber(b.key))
            pick = hits[0]
            break
          }
        }
        if (pick) {
          assign(ref, pick.key, net.name)
          record({ ref_id: ref, net: net.name, interface: iface, role, pins: [pick.key], source: "label", label: pick.labels.join("/") })
        } else {
          const candidates = signalCandidates(part)
          if (candidates.length) ask(part, ref, net, iface, effectiveRole, candidates, `no pin labelled for ${iface} ${effectiveRole}`)
          else record({ ref_id: ref, net: net.name, interface: iface, role, pins: [], source: "none", why: "no free pin left" })
        }
        continue
      }

      // A 1.0 SIGNAL whose claim matched nothing: ask, with the claim as a hint.
      if (role === "SIGNAL") {
        const candidates = signalCandidates(part)
        const hint = member.asserted_pin ? `dunkai claimed pin "${member.asserted_pin}" (unverified)` : "no role given"
        if (candidates.length) ask(part, ref, net, iface, member.asserted_pin ? `SIGNAL (claimed ${member.asserted_pin})` : "SIGNAL", candidates, hint)
        else record({ ref_id: ref, net: net.name, interface: iface, role, pins: [], source: "none", why: "no free pin left" })
        continue
      }

      // --- generic IO: any free general-purpose pin -------------------------
      if (GENERIC.has(iface) || role === "GPIO") {
        const prefer = role === "ANALOG_IN" ? ADC_LABEL : role === "PWM" ? PWM_LABEL : GPIO_LABEL
        const free = freePins(part)
        let hits = free.filter((p) => labelMatches(p.labels, prefer))
        if (!hits.length && role !== "ANALOG_IN") hits = free.filter((p) => labelMatches(p.labels, GPIO_LABEL))
        if (hits.length) {
          hits.sort((a, b) => pinNumber(a.key) - pinNumber(b.key))
          assign(ref, hits[0].key, net.name)
          record({ ref_id: ref, net: net.name, interface: iface, role, pins: [hits[0].key], source: "label", label: hits[0].labels.join("/") })
        } else {
          const candidates = signalCandidates(part)
          if (candidates.length) ask(part, ref, net, iface, role, candidates, `no general-purpose IO pin recognisable by name`)
          else record({ ref_id: ref, net: net.name, interface: iface, role, pins: [], source: "none", why: "no free pin left" })
        }
        continue
      }

      record({ ref_id: ref, net: net.name, interface: iface, role, pins: [], source: "none", why: `unknown role ${iface}:${role}` })
    }
  }

  // A pin offered in an early question may have been claimed afterwards by a
  // deterministic match on a later net. Offer only what is still free, and
  // drop questions with nothing left to choose.
  for (const q of questions) {
    const used = parts.get(q.ref_id).used
    q.candidates = q.candidates.filter((c) => !used.has(c.pin))
  }
  const answerable = questions.filter((q) => q.candidates.length)
  for (const q of questions) {
    if (q.candidates.length) continue
    const row = members.find((m) => m.question === q.id)
    row.source = "none"
    row.why = "no free pin left"
    delete row.question
  }

  return { assignments, members, questions: answerable }
}

function rank(net) {
  if (net.interface === "Power") return 0
  if (GENERIC.has(net.interface)) return 2
  return 1
}

/**
 * Apply validated answers to a mapping in place.
 *
 * An answer must be one of that question's candidates, and a pin may only be
 * used once per part — answers are taken in question order, so a duplicate
 * loses to the first claim. "NONE" (the part has no such pin) is respected:
 * the member stays unconnected rather than guessed.
 *
 * @returns {{ applied: number, rejected: Array<{id: string, answer: unknown, reason: string}> }}
 */
export function applyAnswers(mapping, answers) {
  const rejected = []
  let applied = 0
  const usedByRef = {}
  for (const [ref, pins] of Object.entries(mapping.assignments)) usedByRef[ref] = new Set(Object.keys(pins))

  for (const q of mapping.questions) {
    const answer = answers?.[q.id]
    const row = mapping.members.find((m) => m.question === q.id)
    if (answer == null) {
      rejected.push({ id: q.id, answer, reason: "no answer" })
      continue
    }
    if (String(answer).toUpperCase() === "NONE") {
      row.source = "model-none"
      continue
    }
    const pin = String(answer).trim()
    if (!q.candidates.some((c) => c.pin === pin)) {
      rejected.push({ id: q.id, answer, reason: "not one of the candidates" })
      continue
    }
    const used = (usedByRef[q.ref_id] ??= new Set())
    if (used.has(pin)) {
      rejected.push({ id: q.id, answer, reason: `${pin} is already used on ${q.ref_id}` })
      continue
    }
    used.add(pin)
    ;(mapping.assignments[q.ref_id] ??= {})[pin] = q.net
    row.pins = [pin]
    row.source = "model"
    applied++
  }
  return { applied, rejected }
}

/** Counts for logs and the eval report. */
export function mappingStats(mapping) {
  const by = {}
  for (const m of mapping.members) by[m.source] = (by[m.source] ?? 0) + 1
  const connected = mapping.members.filter((m) => m.pins.length).length
  return { members: mapping.members.length, connected, bySource: by }
}

// ---------------------------------------------------------------------------
// Capability report: what a part can do, from its real pins
// ---------------------------------------------------------------------------

const has = (labels, re) => labels.some((l) => tokensOf(l).some((t) => re.test(t)))

/**
 * Interfaces a part's pin labels show it supports. Used to explain an open
 * connection ("asked for SPI; this part has segment pins") and to give the
 * architecture agent a constrained list to choose from when it revises.
 * Unnamed pins prove nothing either way, so they are reported as such rather
 * than guessed at.
 */
export function capabilitiesOf(resolution) {
  const chip = resolution?.chip
  if (!chip) return ["unknown (synthesised footprint, no pin names)"]
  const labels = Object.entries(chip.pinLabels)
    .filter(([key, l]) => !(l.length === 1 && l[0] === key))
    .flatMap(([, l]) => l)
  const caps = []
  if (has(labels, /^SDA\d*$/) && has(labels, /^SCL\d*$/)) caps.push("I2C")
  if (has(labels, /^(MOSI|SDI|DIN|SI|COPI)\d*$/) && has(labels, /^(SCK|SCLK|DCLK|SPC)\d*$/)) caps.push("SPI")
  if (has(labels, /^U?\d*TXD?\d*$/) && has(labels, /^U?\d*RXD?\d*$/)) caps.push("UART")
  if (has(labels, /^(DP|D\+|USB\d*DP)$/) && has(labels, /^(DM|D-|USB\d*DM)$/)) caps.push("USB")
  if (has(labels, /^CANH$/) && has(labels, /^CANL$/)) caps.push("CAN")
  if (has(labels, /^DQ\d*$/)) caps.push("OneWire")
  if (has(labels, /^(BCLK|BCK)$/) && has(labels, /^(WS|LRCLK|LRCK)$/)) caps.push("I2S")
  if (has(labels, /^(ADC\d*|AIN\d*)$/)) caps.push("ADC")
  if (has(labels, /PWM/)) caps.push("PWM")
  if (has(labels, GPIO_LABEL)) caps.push("GPIO")
  // A..G (+DP) per digit: a raw segment display, driven pin-by-pin.
  if (["A", "B", "C", "D", "E", "F", "G"].every((s) => has(labels, new RegExp(`^${s}\\d*$`)))) {
    // Segment names (D1, D2...) also look like GPIO pins; say what they are once.
    if (caps.at(-1) === "GPIO") caps.pop()
    caps.push("GPIO (segment display — one IO per segment, or a driver IC)")
  }
  if (chip.placeholderRatio > 0.5) caps.push("GPIO (most pins unnamed — likely a microcontroller)")
  return caps.length ? caps : ["no signal interface recognisable from its pin names"]
}

/**
 * Signal connections the board had to leave open, with what the part
 * supports instead. Power/ground misses are left out: a display or connector
 * with no supply pin is normal, not a design error.
 */
export function findMismatches(mapping, resolutions) {
  const byRef = new Map(resolutions.filter((r) => r.ok).map((r) => [r.component.ref_id, r]))
  const out = []
  for (const m of mapping.members) {
    if (m.pins.length || m.role === "SUPPLY" || m.role === "GROUND") continue
    if (m.source !== "model-none" && m.source !== "none") continue
    const r = byRef.get(m.ref_id)
    if (!r) continue
    out.push({
      ref_id: m.ref_id,
      part_number: r.component.part_number,
      part_class: r.component.part_class ?? null,
      net: m.net,
      interface: m.interface,
      role: m.role,
      supports: capabilitiesOf(r),
      reason: m.source === "model-none" ? "the part has no pin for this signal" : m.why ?? "no pin could be assigned",
    })
  }
  return out
}
