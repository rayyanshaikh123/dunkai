/**
 * Footprint / symbol inspection used by Stage B's acceptance gates.
 *
 * Three independent numbers describe the same part, and a resolution is only
 * trustworthy when they agree:
 *
 *   1. what dunkai's IR CLAIMS      — the `package` string, e.g. "DFN-8-EP(2x3)"
 *   2. what the SYMBOL provides     — `pinLabels` count in the imported .tsx
 *   3. what the FOOTPRINT provides  — pad count encoded in the footprinter name
 *
 * Checking only one of the three is how a part gets accepted with the wrong land
 * pattern: the import succeeds, the IoU looks fine against whatever land pattern
 * the vendor happened to return, and the mismatch only shows up as an unroutable
 * board much later. Comparing all three catches it at resolution time.
 */

/**
 * Families whose trailing integer IS the pin count: SOIC-16, QFN-32, DIP-40.
 */
const PIN_COUNT_FAMILIES =
  /\b(SOIC|SOP|ESOP|HSOP|PSOP|SSOP|TSSOP|VSSOP|MSOP|QSOP|QFN|VQFN|PQFN|UQFN|LQFP|TQFP|HQFP|QFP|DFN|UDFN|WDFN|USON|WSON|SON|DIP|PDIP|SIP|BGA|DSBGA|WLCSP|CSP|LGA|PLCC|MLF)\b/i

/**
 * Families whose FIRST integer is a JEDEC type code, not a pin count.
 *
 * "TO-92" is a three-lead package; "SOT-23" has three leads; "SC-70" has three.
 * Reading the trailing integer here produces nonsense, and it is not harmless —
 * the pad-count gate rejected a correctly synthesised `to92` footprint with
 * "compiles to 3 pads but package TO-92 implies 92".
 *
 * A pin count is only readable when a SECOND number follows the type code, as
 * in "SOT-23-6" or "SC-70-5". With one number the count is unknown, and the
 * gate is skipped rather than fabricated.
 */
const TYPE_CODE_FAMILIES = /\b(TO|SOT|SC|SOD|TOLL|DPAK|D2PAK|SMA|SMB|SMC)\b/i

/** True when the package declares an exposed / thermal pad, which is an extra pad. */
const hasExposedPad = (text) => /\b(EP|ET|PAD|THERMAL)\b/i.test(text) || /-EP\b/i.test(text)

/**
 * Pin count implied by an IR package string, or null when it cannot be read.
 * The exposed pad is reported separately — callers decide whether to count it,
 * because the symbol usually carries it as one extra pin while some footprints
 * fold it in differently.
 *
 * @returns {{pins: number, exposedPad: boolean}|null}
 */
export function expectedPinCount(packageString) {
  const raw = String(packageString ?? "").trim()
  if (!raw || raw.toUpperCase() === "CUSTOM") return null

  // Drop parenthesised body dimensions: "LQFP-32(7x7)" -> "LQFP-32"
  const stripped = raw.replace(/\([^)]*\)/g, " ")

  const isTypeCode = TYPE_CODE_FAMILIES.test(stripped)
  if (!isTypeCode && !PIN_COUNT_FAMILIES.test(stripped)) return null

  // Reject dimension-like tails ("24x16mm") before reading a count.
  const withoutDims = stripped.replace(/\b\d+(\.\d+)?\s*[xX*]\s*\d+(\.\d+)?\s*(mm)?\b/g, " ")
  const numbers = withoutDims.match(/\d+/g)
  if (!numbers || numbers.length === 0) return null

  // A type-code family needs a SECOND number to carry a pin count: "SOT-23-6"
  // is six pins, but bare "SOT-23" and "TO-92" are three-lead packages whose
  // number says nothing about lead count.
  if (isTypeCode && numbers.length < 2) return null

  // Otherwise the pin count is the LAST integer: SOT-23-6 -> 6, X2-QFN-12 -> 12,
  // SC-70-5 -> 5, SOIC-16 -> 16. Earlier integers are family/body codes.
  const pins = Number(numbers[numbers.length - 1])
  if (!Number.isFinite(pins) || pins < 2 || pins > 512) return null

  return { pins, exposedPad: hasExposedPad(stripped) }
}

/**
 * Pad count encoded in a footprinter string, e.g.
 *   "dfn8_thermalpad1.75mmx1.63mm_p0.5mm_..."  -> 8 pads + thermal pad
 *   "qfn32_pillpads_p0.8mm_..."                -> 32
 *   "lga12_grid2x4_p0.4mm_..."                 -> 12
 *
 * @returns {{pads: number, thermalPad: boolean}|null}
 */
export function footprinterPadCount(footprinterString) {
  const raw = String(footprinterString ?? "").trim()
  if (!raw) return null
  // SOT-23 is a package family code, not a 23-pad package. The suffix in
  // sot23_6 carries the pad count; unknown JEDEC families must stay unknown.
  const jedec = raw.match(/^(sot|sc|to)\d+(?:_(\d+))?(?:_|$)/i)
  if (jedec) {
    const pads = Number(jedec[2])
    return pads >= 2 && pads <= 512 ? { pads, thermalPad: /thermalpad|_ep\b|thermal/i.test(raw) } : null
  }
  // Leading token carries family + count: "dfn8", "soic16", "qfn32", "lga12".
  const head = raw.split("_")[0]
  const m = head.match(/^([a-z]+)(\d+)$/i)
  if (!m) return null
  const pads = Number(m[2])
  if (!Number.isFinite(pads) || pads < 2 || pads > 512) return null
  return { pads, thermalPad: /thermalpad|_ep\b|thermal/i.test(raw) }
}

/**
 * Read the facts out of a .tsx that `tsci import` wrote.
 *
 * @returns {{
 *   pinLabels: Record<string,string[]>, pinCount: number,
 *   placeholderPins: string[], placeholderRatio: number,
 *   footprint: string|null, manufacturerPartNumber: string|null,
 *   lcsc: string|null, hasCadModel: boolean, exportName: string|null,
 *   hasInlineFootprint: boolean
 * }}
 */
export function parseImportedChip(source) {
  const text = String(source ?? "")

  const pinLabels = {}
  const block = text.match(/const\s+pinLabels\s*=\s*\{([\s\S]*?)\n\}\s*as const/)
  if (block) {
    const entryRe = /["']?(pin\d+)["']?\s*:\s*\[([^\]]*)\]/g
    let m
    while ((m = entryRe.exec(block[1])) !== null) {
      const labels = m[2]
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean)
      pinLabels[m[1]] = labels
    }
  }

  // The placeholder signature, verified against a real import: when the vendor
  // symbol carries no usable names, tsci emits `pin7: ["pin7"]` — the label is
  // literally the key. A part in that state cannot be wired by signal name; the
  // generator must not emit connections={{ SDA: ... }} against it.
  const placeholderPins = Object.entries(pinLabels)
    .filter(([key, labels]) => labels.length === 1 && labels[0] === key)
    .map(([key]) => key)

  const pinCount = Object.keys(pinLabels).length

  // `pinAttributes` says which pads need power or ground and which must stay
  // unconnected — vendor ground truth that lib/pinmap.mjs maps power from
  // without having to recognise a label.
  const pinAttributes = {}
  const attrBlock = text.match(/const\s+pinAttributes\s*=\s*\{([\s\S]*?)\n\}\s*as const/)
  if (attrBlock) {
    const attrRe = /["']?(pin\d+)["']?\s*:\s*\{([^}]*)\}/g
    let a
    while ((a = attrRe.exec(attrBlock[1])) !== null) {
      const flags = {}
      for (const [, name, value] of a[2].matchAll(/(\w+)\s*:\s*(true|false)/g)) flags[name] = value === "true"
      pinAttributes[a[1]] = flags
    }
  }

  const footprintMatch = text.match(/footprint\s*=\s*["']([^"']+)["']/)
  const mpnMatch = text.match(/manufacturerPartNumber\s*=\s*["']([^"']+)["']/)
  const lcscMatch = text.match(/["']jlcpcb["']\s*:\s*\[\s*["']([^"']+)["']/)
  const exportMatch = text.match(/export\s+const\s+([A-Za-z0-9_$]+)\s*=/)

  return {
    pinLabels,
    pinAttributes,
    pinCount,
    placeholderPins,
    placeholderRatio: pinCount ? placeholderPins.length / pinCount : 1,
    footprint: footprintMatch ? footprintMatch[1] : null,
    manufacturerPartNumber: mpnMatch ? mpnMatch[1] : null,
    lcsc: lcscMatch ? lcscMatch[1] : null,
    hasCadModel: /cadModel\s*=/.test(text),
    exportName: exportMatch ? exportMatch[1] : null,
    // `footprint={<footprint>...}` rather than a footprinter string.
    hasInlineFootprint: /footprint\s*=\s*\{\s*</.test(text),
  }
}

/** Parse `Using footprinter "<name>" (99.50% copper IoU).` out of tsci's output. */
export function parseImportOutput(output) {
  const text = String(output ?? "")
  const imported = text.match(/Imported\s+(.+?\.tsx)/)
  const footprinter = text.match(/Using footprinter\s+"([^"]+)"\s*\(([\d.]+)%\s*copper IoU\)/i)
  const lcsc = text.match(/Importing\s+"(C?\d+)"/)
  return {
    // tsci exits 0 even when it finds nothing, so "did a file appear" is the
    // only reliable success signal — never the exit code.
    noResults: /No results found/i.test(text),
    importedPath: imported ? imported[1].trim() : null,
    footprinter: footprinter ? footprinter[1] : null,
    iou: footprinter ? Number(footprinter[2]) : null,
    lcsc: lcsc ? lcsc[1] : null,
  }
}

/**
 * Compile a footprinter string and report what it actually produces.
 *
 * Tier 5 synthesises this string, and an invalid one is NOT caught anywhere
 * downstream in a useful way: the evaluator accepts the component and then
 * reports `source_invalid_component_property_error`, the part lands with no
 * pads, placement fails, and the autorouter skips the whole board. One bad
 * string cost 80 error elements and every trace on a real run:
 *
 *     Invalid footprint prop on chip "U6": "sot3_p1.27mm_w4.2mm_pw0.6mm_pl1.2mm"
 *     [ { "received": 3, "code": "invalid_literal", "expected": 6 } ]
 *
 * ("sot" is a 6-pad family; the 3-pad TO-92 builder is "sot23_3".) Compiling the
 * string here turns that into a rejected tier-5 result, which can be retried.
 *
 * @returns {{valid: boolean, pads: number|null, error: string|null}}
 */
export function validateFootprintString(footprintString, requireModule) {
  const text = String(footprintString ?? "").trim()
  if (!text) return { valid: false, pads: null, error: "empty footprint string" }
  try {
    const { fp } = requireModule("@tscircuit/footprinter/dist/index.js")
    const elements = fp.string(text).circuitJson()
    const pads = elements.filter(
      (e) => e.type === "pcb_smtpad" || e.type === "pcb_plated_hole"
    ).length
    if (pads === 0) return { valid: false, pads: 0, error: "footprint produced no pads" }
    return { valid: true, pads, error: null }
  } catch (err) {
    // Collapse rather than take the first line: footprinter surfaces a zod
    // error whose first line is just "[", which tells a retry nothing. The
    // useful part ("received": 3, "expected": 6) is several lines down.
    const message = String(err?.message ?? err)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300)
    return { valid: false, pads: null, error: message || "footprinter rejected the string" }
  }
}

/** Every footprinter family name, for steering the provider to a real one. */
export function footprintFamilies(requireModule) {
  try {
    const { getFootprintNames } = requireModule("@tscircuit/footprinter/dist/index.js")
    return getFootprintNames()
  } catch {
    return []
  }
}

/** Normalise an MPN for comparison: "MCP9808T-E/MC" -> "MCP9808TEMC". */
const mpnKey = (text) => String(text ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "")

/**
 * Does the part that came back plausibly correspond to the one asked for?
 *
 * Tolerant on purpose: the catalogue routinely returns a shorter or longer form
 * of the same ordering code ("PC817B-MS" imports as "PC817B"), so an exact match
 * would reject good resolutions. A shared prefix of at least four characters is
 * enough to distinguish those from a genuinely different device.
 */
export function mpnMatches(requested, resolved) {
  const a = mpnKey(requested)
  const b = mpnKey(resolved)
  if (!a || !b) return true // nothing to compare; other gates still apply
  if (a === b) return true
  const shorter = a.length <= b.length ? a : b
  const longer = a.length <= b.length ? b : a
  return shorter.length >= 4 && longer.startsWith(shorter)
}

/**
 * Apply the acceptance gates to one resolution attempt.
 *
 * @returns {{passed: boolean, failures: string[], notes: string[]}}
 */
export function applyGates(chip, importInfo, declaredPackage, opts = {}) {
  const iouThreshold = opts.iouThreshold ?? 98
  const placeholderThreshold = opts.placeholderThreshold ?? 0.5

  const failures = []
  const notes = []

  // --- part-identity gate ---------------------------------------------------
  //
  // A keyword search returns the catalogue's BEST GUESS, not a match. Searching
  // "ESP-M1" (a WiFi module, declared package "SMD,15x12.3mm") returned
  // LM139DR — a quad comparator — and it sailed through every other gate: the
  // package string carries no readable pin count so the pad-count gate was
  // skipped, and IoU was 99.4% because it measures copper overlap against
  // whatever land pattern the returned part has, not against the part asked for.
  //
  // Without this check the board gets a completely wrong device with a
  // beautifully matched footprint. Failing here drops the attempt to the next
  // tier, where candidates are scored against the requested MPN explicitly.
  if (opts.declaredMpn && chip?.manufacturerPartNumber) {
    if (!mpnMatches(opts.declaredMpn, chip.manufacturerPartNumber)) {
      failures.push(
        `resolved part "${chip.manufacturerPartNumber}" is not "${opts.declaredMpn}"`
      )
    } else {
      notes.push(`part identity: ${chip.manufacturerPartNumber}`)
    }
  }

  // --- IoU gate -------------------------------------------------------------
  if (importInfo.iou != null) {
    if (importInfo.iou < iouThreshold) {
      failures.push(`copper IoU ${importInfo.iou}% is below ${iouThreshold}%`)
    } else {
      notes.push(`copper IoU ${importInfo.iou}%`)
    }
  } else if (chip.hasInlineFootprint) {
    notes.push("exact vendor footprint kept (no footprinter match reported)")
  } else {
    notes.push("no IoU reported")
  }

  // --- pad-count gate -------------------------------------------------------
  const expected = expectedPinCount(declaredPackage)
  const padInfo = footprinterPadCount(chip.footprint)

  if (expected && chip.pinCount) {
    // Symbol may carry the exposed pad as one extra pin.
    const ok = chip.pinCount === expected.pins || chip.pinCount === expected.pins + 1
    if (!ok) {
      failures.push(
        `symbol has ${chip.pinCount} pins but package "${declaredPackage}" implies ${expected.pins}` +
          (expected.exposedPad ? " (+1 exposed pad)" : "")
      )
    } else {
      notes.push(`pin count ${chip.pinCount} matches "${declaredPackage}"`)
    }
  } else if (!expected) {
    notes.push(`package "${declaredPackage}" carries no readable pin count — pad-count gate skipped`)
  }

  if (expected && padInfo) {
    const ok = padInfo.pads === expected.pins || padInfo.pads === expected.pins + 1
    if (!ok) {
      failures.push(
        `footprint "${chip.footprint}" has ${padInfo.pads} pads but package implies ${expected.pins}`
      )
    }
  }

  // --- placeholder-pin gate -------------------------------------------------
  // Not fatal on its own: the part is real and its footprint may be perfect.
  // What it costs is the ability to wire by NAME, so it is recorded and carried
  // forward for the brief rather than rejected outright.
  if (chip.pinCount && chip.placeholderRatio > placeholderThreshold) {
    notes.push(
      `PLACEHOLDER PINS: ${chip.placeholderPins.length}/${chip.pinCount} pins are unnamed ` +
        `(${Math.round(chip.placeholderRatio * 100)}%) — cannot be wired by signal name`
    )
  }

  return { passed: failures.length === 0, failures, notes }
}
