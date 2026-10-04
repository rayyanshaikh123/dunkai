import { test } from "node:test"
import assert from "node:assert/strict"
import { parseImportedChip } from "../src/lib/footprint.mjs"
import { mapPins, applyAnswers } from "../src/lib/pinmap.mjs"
import { emitBoard } from "../src/lib/emit-board.mjs"
import { packParts } from "../src/lib/placement.mjs"
import { findUndeclaredNetRefs } from "../src/lib/nets.mjs"
import { pinQuestionPrompt } from "../src/providers/prompts.mjs"

// Minimal imports in the exact shape `tsci import` writes (see build/*/imports).
const importSource = (name, labels, attrs = {}) => `
import type { ChipProps } from "@tscircuit/props"

const pinLabels = {
${Object.entries(labels).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join(",\n")}
} as const

const pinAttributes = {
${Object.entries(attrs).map(([k, v]) => `  ${k}: {${Object.entries(v).map(([a, b]) => `${a}: ${b}`).join(", ")}}`).join(",\n")}
} as const

export const ${name} = (props: ChipProps<typeof pinLabels>) => {
  return (
    <chip
      pinLabels={pinLabels}
      manufacturerPartNumber="${name}"
      footprint="soic8_p1.27mm"
      {...props}
    />
  )
}
`

// HDC1080-like sensor: power from attributes, I2C by label, NC pins flagged.
const SENSOR = parseImportedChip(
  importSource(
    "SENSOR",
    { pin1: ["SDA"], pin2: ["GND"], pin3: ["NC1"], pin4: ["NC2"], pin5: ["VDD"], pin6: ["SCL"], pin7: ["EP"] },
    { pin2: { requiresGround: true }, pin3: { doNotConnect: true }, pin4: { doNotConnect: true }, pin5: { requiresPower: true } }
  )
)

// 8051-like MCU: mostly unnamed pins, plus dedicated ones that must never carry a signal.
const mcuLabels = {}
for (let i = 1; i <= 40; i++) mcuLabels[`pin${i}`] = [`pin${i}`]
Object.assign(mcuLabels, { pin9: ["RST"], pin18: ["XTAL2"], pin19: ["XTAL1"], pin20: ["GND"], pin30: ["ALE"], pin40: ["VCC"] })
const MCU = parseImportedChip(importSource("MCU", mcuLabels, { pin20: { requiresGround: true }, pin40: { requiresPower: true } }))

// A module that flags its grounds but NOT its supply (as HLK-B40 does).
const MODULE = parseImportedChip(
  importSource("MODULE", { pin1: ["GND1"], pin2: ["VDDIO"], pin3: ["UART0_TXD"], pin4: ["UART0_RXD"], pin5: ["GND2"] }, {
    pin1: { requiresGround: true },
    pin5: { requiresGround: true },
  })
)

const resolution = (ref, chip, part_number = chip.exportName) => ({
  ok: true,
  tier: 1,
  component: { ref_id: ref, part_number, package: "TEST" },
  chip,
  footprinter: chip.footprint,
})

const design = (nets) => ({
  design_name: "t",
  schema_version: "2.0",
  components: [],
  nets,
  constraints: { layer_count: 2, board_outline: { shape: "rectangle", width_mm: 50, height_mm: 40 } },
})

test("parseImportedChip reads pinAttributes", () => {
  assert.deepEqual(SENSOR.pinAttributes.pin5, { requiresPower: true })
  assert.deepEqual(SENSOR.pinAttributes.pin3, { doNotConnect: true })
})

test("power and ground come from attributes; I2C from labels", () => {
  const d = design([
    { name: "VCC", interface: "Power", net_class: "power", members: [{ ref_id: "U2", role: "SUPPLY" }] },
    { name: "GND", interface: "Power", net_class: "ground", members: [{ ref_id: "U2", role: "GROUND" }] },
    { name: "I2C_SCL", interface: "I2C", net_class: "signal", members: [{ ref_id: "U2", role: "CLOCK" }] },
    { name: "I2C_SDA", interface: "I2C", net_class: "signal", members: [{ ref_id: "U2", role: "DATA" }] },
  ])
  const m = mapPins(d, [resolution("U2", SENSOR)])
  assert.deepEqual(m.assignments.U2, { pin5: "VCC", pin2: "GND", pin6: "I2C_SCL", pin1: "I2C_SDA" })
  assert.equal(m.questions.length, 0)
  // The bare thermal pad is never guessed onto a rail.
  assert.equal(m.assignments.U2.pin7, undefined)
})

test("ground attributes do not hide a labelled supply (per-rail evidence)", () => {
  const d = design([
    { name: "VCC", interface: "Power", net_class: "power", members: [{ ref_id: "U3", role: "SUPPLY" }] },
    { name: "GND", interface: "Power", net_class: "ground", members: [{ ref_id: "U3", role: "GROUND" }] },
  ])
  const m = mapPins(d, [resolution("U3", MODULE)])
  assert.deepEqual(m.assignments.U3, { pin2: "VCC", pin1: "GND", pin5: "GND" })
})

test("UART tokens inside a compound label match (UART0_TXD)", () => {
  const d = design([{ name: "TX", interface: "UART", net_class: "signal", members: [{ ref_id: "U3", role: "TX" }] }])
  assert.deepEqual(mapPins(d, [resolution("U3", MODULE)]).assignments.U3, { pin3: "TX" })
})

test("unnamed MCU pins become questions that exclude dedicated pins", () => {
  const d = design([
    { name: "VCC", interface: "Power", net_class: "power", members: [{ ref_id: "U1", role: "SUPPLY" }] },
    { name: "UART_TX", interface: "UART", net_class: "signal", members: [{ ref_id: "U1", role: "TX" }] },
  ])
  const m = mapPins(d, [resolution("U1", MCU)])
  assert.deepEqual(m.assignments.U1, { pin40: "VCC" })
  assert.equal(m.questions.length, 1)
  const offered = m.questions[0].candidates.map((c) => c.pin)
  for (const dedicated of ["pin9", "pin18", "pin19", "pin20", "pin30", "pin40"]) {
    assert.ok(!offered.includes(dedicated), `${dedicated} must not be offered`)
  }
})

test("answers are validated: not-a-candidate, duplicates and NONE", () => {
  const d = design([
    { name: "A", interface: "GPIO", net_class: "signal", members: [{ ref_id: "U1", role: "GPIO" }] },
    { name: "B", interface: "GPIO", net_class: "signal", members: [{ ref_id: "U1", role: "GPIO" }] },
    { name: "C", interface: "GPIO", net_class: "signal", members: [{ ref_id: "U1", role: "GPIO" }] },
    { name: "D", interface: "SPI", net_class: "signal", members: [{ ref_id: "U1", role: "MOSI" }] },
  ])
  const m = mapPins(d, [resolution("U1", MCU)])
  // Questions are ordered by net rank (specific roles before generic IO), so
  // look them up by net rather than by position.
  const idFor = (net) => m.questions.find((q) => q.net === net).id
  const [qa, qb, qc, qd] = ["A", "B", "C", "D"].map(idFor)
  const { applied, rejected } = applyAnswers(m, { [qa]: "pin1", [qb]: "pin1", [qc]: "pin9", [qd]: "NONE" })
  assert.equal(applied, 1)
  assert.deepEqual(m.assignments.U1, { pin1: "A" })
  assert.deepEqual(rejected.map((r) => r.id).sort(), [qb, qc].sort())
  assert.equal(m.members.find((r) => r.question === qd).source, "model-none")
})

test("schema 1.0: a claimed pin name is used only when the part really has it", () => {
  const d = {
    ...design([
      {
        name: "I2C_SCL",
        interface: "I2C",
        net_class: "signal",
        members: [
          { ref_id: "U2", role: "SIGNAL", asserted_pin: "SCL" },
          { ref_id: "U1", role: "SIGNAL", asserted_pin: "SCL" },
        ],
      },
    ]),
    schema_version: "1.0",
  }
  const m = mapPins(d, [resolution("U2", SENSOR), resolution("U1", MCU)])
  assert.deepEqual(m.assignments.U2, { pin6: "I2C_SCL" }) // verified against the label
  assert.equal(m.questions.length, 1) // the MCU has no SCL label: asked, not trusted
  assert.equal(m.questions[0].role, "CLOCK")
})

test("emitted board: declared nets only, no single-pin nets, real pins only", () => {
  const d = design([
    { name: "I2C_SDA", interface: "I2C", net_class: "signal", members: [{ ref_id: "U2", role: "DATA" }, { ref_id: "U3", role: "DATA" }] },
    { name: "LONELY", interface: "I2C", net_class: "signal", members: [{ ref_id: "U2", role: "CLOCK" }] },
  ])
  const resolutions = [resolution("U2", SENSOR), resolution("U3", { ...SENSOR, exportName: "SENSOR" })]
  const m = mapPins(d, resolutions)
  const { boardTsx, nets } = emitBoard(d, resolutions, m)
  assert.deepEqual(nets, ["I2C_SDA"])
  assert.ok(!boardTsx.includes("LONELY"), "a net with one pin connects nothing and is not emitted")
  assert.deepEqual(findUndeclaredNetRefs(boardTsx).missing, [])
  assert.match(boardTsx, /<board [^>]*layoutMode="grid"/) // no placement yet: measuring build
})

test("emitted board rejects distinct net names that normalize to one copper net", () => {
  const d = design([
    { name: "A-B", members: [] },
    { name: "A_B", members: [] },
  ])
  assert.throws(() => emitBoard(d, [], { assignments: {} }), /net names "A-B" and "A_B" both become "A_B"/)
})

test("emitted board with a placement uses coordinates, not grid layout", () => {
  const d = design([])
  const m = mapPins(d, [resolution("U2", SENSOR)])
  const { boardTsx } = emitBoard(d, [resolution("U2", SENSOR)], m, { placement: { U2: { x: 1.5, y: -2 } } })
  assert.match(boardTsx, /pcbX=\{1\.5\}/)
  assert.doesNotMatch(boardTsx, /layoutMode/)
})

test("packParts: no overlaps, inside the board, never smaller than requested", () => {
  const sizes = { U1: { w: 50, h: 17 }, U2: { w: 13, h: 11 }, U3: { w: 7.5, h: 9.5 }, U4: { w: 2.6, h: 4 }, U5: { w: 22, h: 17 } }
  const assignments = { U1: { pin1: "I2C" }, U4: { pin1: "I2C" } }
  const { placement, widthMm, heightMm } = packParts(sizes, assignments, { widthMm: 60, heightMm: 40 })
  assert.ok(widthMm >= 60 && heightMm >= 40)
  const rects = Object.entries(placement).map(([ref, p]) => ({
    ref,
    l: p.x - sizes[ref].w / 2,
    r: p.x + sizes[ref].w / 2,
    b: p.y - sizes[ref].h / 2,
    t: p.y + sizes[ref].h / 2,
  }))
  for (const a of rects) {
    assert.ok(a.l >= -widthMm / 2 && a.r <= widthMm / 2 && a.b >= -heightMm / 2 && a.t <= heightMm / 2, `${a.ref} inside`)
    for (const b of rects) {
      if (a.ref >= b.ref) continue
      const overlap = a.l < b.r && b.l < a.r && a.b < b.t && b.b < a.t
      assert.ok(!overlap, `${a.ref} and ${b.ref} overlap`)
    }
  }
})

test("pin question prompt groups by part and lists only candidates", () => {
  const d = design([{ name: "UART_TX", interface: "UART", net_class: "signal", members: [{ ref_id: "U1", role: "TX" }] }])
  const m = mapPins(d, [resolution("U1", MCU, "STC89C52RC")])
  const prompt = pinQuestionPrompt(m.questions)
  assert.match(prompt, /## U1 — STC89C52RC/)
  assert.match(prompt, /q1: net UART_TX — UART TX/)
  assert.doesNotMatch(prompt, /pin9=RST/)
  assert.match(prompt, /"answers"/)
})

// ---------------------------------------------------------------------------
// Support parts, standard footprints, capability reports
// ---------------------------------------------------------------------------

import { supportParts, PASSIVES } from "../src/lib/support-parts.mjs"
import { standardFootprintCandidates } from "../src/lib/package-footprints.mjs"
import { capabilitiesOf, findMismatches } from "../src/lib/pinmap.mjs"

const powered = (nets) =>
  design([
    { name: "VCC", interface: "Power", net_class: "power", members: [{ ref_id: "U2", role: "SUPPLY" }, { ref_id: "U3", role: "SUPPLY" }] },
    { name: "GND", interface: "Power", net_class: "ground", members: [{ ref_id: "U2", role: "GROUND" }, { ref_id: "U3", role: "GROUND" }] },
    ...nets,
  ])

test("support parts: decoupling per supply pin, one bulk cap per rail, I2C pull-ups once per bus", () => {
  const d = powered([
    { name: "SDA", interface: "I2C", net_class: "signal", members: [{ ref_id: "U2", role: "DATA" }, { ref_id: "U3", role: "DATA" }] },
    { name: "SCL", interface: "I2C", net_class: "signal", members: [{ ref_id: "U2", role: "CLOCK" }, { ref_id: "U3", role: "CLOCK" }] },
  ])
  // Two I2C sensors: a bus needs two parts on it before pull-ups make sense.
  const resolutions = [resolution("U2", SENSOR), resolution("U3", { ...SENSOR, exportName: "SENSOR" })]
  const m = mapPins(d, resolutions)
  const parts = supportParts(d, resolutions, m)
  const decoupling = parts.filter((p) => p.value === PASSIVES.decoupling.value)
  assert.equal(decoupling.length, 2) // one supply pin on each part
  assert.ok(decoupling.every((p) => p.connections.pin1 === "VCC" && p.connections.pin2 === "GND"))
  assert.equal(parts.filter((p) => p.value === PASSIVES.bulk.value).length, 1)
  const pullUps = parts.filter((p) => p.value === PASSIVES.i2cPullUp.value)
  assert.deepEqual(pullUps.map((p) => p.connections.pin1).sort(), ["SCL", "SDA"])
  assert.ok(pullUps.every((p) => p.connections.pin2 === "VCC"))
})

test("support parts: an active-HIGH RST is never pulled up; an NRST is", () => {
  const d = design([
    { name: "VCC", interface: "Power", net_class: "power", members: [{ ref_id: "U1", role: "SUPPLY" }, { ref_id: "U4", role: "SUPPLY" }] },
    { name: "GND", interface: "Power", net_class: "ground", members: [{ ref_id: "U1", role: "GROUND" }, { ref_id: "U4", role: "GROUND" }] },
  ])
  const ARM = parseImportedChip(
    importSource("ARM", { pin1: ["VDD"], pin2: ["VSS"], pin3: ["NRST"] }, { pin1: { requiresPower: true }, pin2: { requiresGround: true } })
  )
  const resolutions = [resolution("U1", MCU), resolution("U4", ARM)] // MCU has an 8051-style RST on pin9
  const m = mapPins(d, resolutions)
  const parts = supportParts(d, resolutions, m)
  const resets = parts.filter((p) => p.value === PASSIVES.resetPullUp.value)
  assert.equal(resets.length, 1)
  assert.equal(resets[0].near, "U4")
  assert.equal(m.assignments.U4.pin3, "U4_NRST")
  assert.equal(m.assignments.U1.pin9, undefined)
})

test("emitted board declares a support part's own net and every passive carries a stock number", () => {
  const d = design([
    { name: "VCC", interface: "Power", net_class: "power", members: [{ ref_id: "U4", role: "SUPPLY" }] },
    { name: "GND", interface: "Power", net_class: "ground", members: [{ ref_id: "U4", role: "GROUND" }] },
  ])
  const ARM = parseImportedChip(
    importSource("ARM", { pin1: ["VDD"], pin2: ["VSS"], pin3: ["NRST"] }, { pin1: { requiresPower: true }, pin2: { requiresGround: true } })
  )
  const resolutions = [resolution("U4", ARM)]
  const m = mapPins(d, resolutions)
  const support = supportParts(d, resolutions, m)
  const { boardTsx } = emitBoard(d, resolutions, m, {}, support)
  assert.match(boardTsx, /<net name="U4_NRST" \/>/)
  assert.deepEqual(findUndeclaredNetRefs(boardTsx).missing, [])
  assert.equal((boardTsx.match(/<capacitor/g) ?? []).length, 2) // decoupling + bulk
  assert.equal((boardTsx.match(/supplierPartNumbers=\{\{ jlcpcb: \["C\d+"\] \}\}/g) ?? []).length, support.length)
})

test("packParts puts support parts directly under the chip they serve", () => {
  const sizes = { U1: { w: 10, h: 10 }, U2: { w: 8, h: 6 }, C101: { w: 1, h: 0.5 }, C102: { w: 1, h: 0.5 } }
  const { placement } = packParts(sizes, {}, { widthMm: 40, heightMm: 30 }, { C101: "U1", C102: "U1" })
  for (const c of ["C101", "C102"]) {
    assert.ok(placement[c].y < placement.U1.y, `${c} below U1`)
    assert.ok(Math.abs(placement[c].x - placement.U1.x) <= 5, `${c} under U1`)
  }
})

test("standard footprints: DSBGA-6 is a 2x3 array, not bga6's default 3x3", () => {
  assert.equal(standardFootprintCandidates("DSBGA-6")[0], "bga6_grid2x3_p0.5mm")
  assert.deepEqual(standardFootprintCandidates("SOT-23-5"), ["sot23_5"])
  assert.deepEqual(standardFootprintCandidates("TSSOP-20"), ["tssop20"])
  assert.deepEqual(standardFootprintCandidates("LQFP-32(7x7)"), ["lqfp32_p0.8mm"])
  assert.deepEqual(standardFootprintCandidates("SC-70-5"), []) // unsupported: falls through to the provider
})

test("capabilities come from real pins; open connections report them", () => {
  const DISPLAY = parseImportedChip(
    importSource("DISPLAY", { pin1: ["A1"], pin2: ["B1"], pin3: ["C1"], pin4: ["D1"], pin5: ["E1"], pin6: ["F1"], pin7: ["G1"], pin8: ["DP1"] })
  )
  assert.deepEqual(capabilitiesOf(resolution("U7", DISPLAY)), ["GPIO (segment display — one IO per segment, or a driver IC)"])
  assert.deepEqual(capabilitiesOf(resolution("U2", SENSOR)), ["I2C"])

  const d = design([{ name: "SPI_CLK", interface: "SPI", net_class: "signal", members: [{ ref_id: "U7", role: "CLOCK" }] }])
  const resolutions = [resolution("U7", DISPLAY)]
  const m = mapPins(d, resolutions)
  applyAnswers(m, { [m.questions[0].id]: "NONE" })
  const open = findMismatches(m, resolutions)
  assert.equal(open.length, 1)
  assert.equal(open[0].interface, "SPI")
  assert.match(open[0].supports[0], /segment display/)
})
