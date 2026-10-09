import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildOutputs } from "../src/stages/e-outputs.mjs"
import { intake } from "../src/stages/a-intake.mjs"
import { resolveComponents } from "../src/stages/b-resolve.mjs"
import { generateStructured } from "../src/stages/d-generate.mjs"
import { mapPins } from "../src/lib/pinmap.mjs"

const member = (ref_id, role, pin_function) => ({ ref_id, role, ...(pin_function ? { pin_function } : {}) })
const net = (name, iface, net_class, members) => ({ name, interface: iface, net_class, members })
const header = (ref_id, profile, count) => ({ ref_id, part_number: `1x${count} 2.54mm through-hole header`, package: `HDR-${count}-P2.54`, board_profile: profile })
const fixture = () => ({
  schema_version: "2.0", design_name: "required_external_assembly",
  components: [header("J1", "student-sensor-3p", 3), header("J2", "student-sensor-3p", 3), header("J3", "student-power-2p", 2),
    { ref_id: "U1", part_number: "TLV75533PDBVR", package: "SOT-23-5", board_profile: "tlv75533-dbv" }],
  nets: [
    net("GND", "Power", "ground", ["J1", "J2", "J3", "U1"].map((r) => member(r, "GROUND"))),
    net("LOGIC_3V3", "Power", "power", [member("J1", "SUPPLY"), member("J2", "SUPPLY"), member("U1", "SUPPLY", "OUT")]),
    net("REGULATED_5V_IN", "Power", "power", [member("J3", "SUPPLY"), member("U1", "SUPPLY", "IN"), member("U1", "SUPPLY", "EN")]),
    // A header-to-header harness fixture only, not a fabricated MCU pinout.
    net("HARNESS_FIXTURE", "Analog", "signal", [member("J1", "ANALOG_IN"), member("J2", "ANALOG_IN")]),
  ],
  constraints: { layer_count: 2, board_outline: { width_mm: 50, height_mm: 40 } },
  required_devices: [{ key: "tds", node_id: "tds", label: "TDS Sensor" }, { key: "ph", node_id: "ph", label: "pH Sensor" },
    { key: "battery", node_id: "battery", label: "Battery" }, { key: "solar", node_id: "solar", label: "Solar Panel" }],
  external_components: [
    { node_id: "tds", external_key: "tds", device_profile: "tds", mfr_part: "SEN0244", pcb_references: ["J1"] },
    { node_id: "ph", external_key: "ph", device_profile: "ph", mfr_part: "SEN0161-V2", pcb_references: ["J2"] },
    { node_id: "battery", external_key: "battery", device_profile: "battery", mfr_part: "353", pcb_references: ["J3"], via_reference: "EXT_MANAGER" },
    { node_id: "solar", external_key: "solar", device_profile: "solar", mfr_part: "FIT0601", pcb_references: ["J3"], via_reference: "EXT_MANAGER" },
    { reference: "EXT_MANAGER", device_profile: "solar_manager", mfr_part: "DFR0559", pcb_references: ["J3"] },
  ],
})

const withDirectory = async (run) => {
  const directory = await mkdtemp(path.join(tmpdir(), "dunkai-external-test-"))
  try { return await run(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

test("required physical devices survive intake, and cannot be replaced by a connector alone", async () => {
  const input = fixture()
  const design = await intake(input)
  assert.equal(design.required_devices.length, 4)
  assert.equal(design.external_components.length, 5)
  for (const required of input.required_devices) {
    await assert.rejects(intake({ ...input, external_components: input.external_components.filter((c) => c.node_id !== required.node_id) }), /Required device/)
  }
  await assert.rejects(intake({ ...input, components: input.components.filter((c) => c.ref_id !== "J1") }), /missing PCB port/)
  await assert.rejects(intake({ ...input, external_components: input.external_components.filter((c) => c.reference !== "EXT_MANAGER") }), /missing its external charger/)
})

test("documented headers and regulator map pins without LLM calls and keep IN/OUT separate", () => withDirectory(async (directory) => {
  const design = await intake(fixture())
  const provider = { name: "test", synthesiseFootprint: () => assert.fail("No model needed for documented parts"),
    answerPinQuestions: () => assert.fail("Documented pins cannot be guessed") }
  const resolution = await resolveComponents(design, directory, provider)
  assert.equal(resolution.unresolved.length, 0)
  const mapping = mapPins(design, resolution.resolutions)
  assert.equal(mapping.questions.length, 0)
  assert.deepEqual(mapping.assignments.U1, { pin2: "GND", pin5: "LOGIC_3V3", pin1: "REGULATED_5V_IN", pin3: "REGULATED_5V_IN" })
  assert.equal(mapping.assignments.J1.pin3, "HARNESS_FIXTURE")
  const structured = await generateStructured(design, "Test harness", resolution, provider, directory)
  assert.equal(structured.support.filter((p) => p.why.includes("local input/output capacitor")).length, 2)
  assert.match(structured.board, /DunkaiSensorHeader3/)
  const compiled = await buildOutputs(directory)
  assert.ok(compiled.stats.traces > 0, "real compiler must route the header/regulated-power test harness")
  assert.equal(compiled.circuitJson.filter((c) => c.type === "source_invalid_component_property_error").length, 0)
  assert.ok(compiled.circuitJson.some((c) => c.type === "source_component" && c.name === "J1"))
  assert.ok(compiled.circuitJson.some((c) => c.type === "source_component" && c.name === "U1"))
}))

test("a required sensor signal cannot disappear even if supply and ground are connected", () => withDirectory(async (directory) => {
  const input = fixture()
  input.nets = input.nets.filter((n) => n.interface !== "Analog")
  const design = await intake(input)
  const provider = { name: "test" }
  const resolution = await resolveComponents(design, directory, provider)
  await assert.rejects(generateStructured(design, "Missing analog signal", resolution, provider, directory), /Required device TDS Sensor has an incomplete PCB connection/)
}))

test("a profile cannot certify an unrelated part or cross-connect the regulator rails", () => withDirectory(async (directory) => {
  const input = fixture()
  input.components[3].part_number = "SOME_OTHER_REGULATOR"
  const design = await intake(input)
  await assert.rejects(resolveComponents(design, directory, { name: "test" }), /BOM identity\/package does not match/)
  input.components[3].part_number = "TLV75533PDBVR"
  const valid = await intake(input)
  const resolution = await resolveComponents(valid, directory, { name: "test" })
  valid.nets.push(net("SHORT", "Power", "power", [member("U1", "SUPPLY", "OUT")]))
  assert.throws(() => mapPins(valid, resolution.resolutions), /cannot be assigned to two different rails/)
}))
