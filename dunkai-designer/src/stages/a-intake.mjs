/**
 * Stage A — intake.
 *
 * Accepts either pcb_ir schema the dunkai supervisor can emit and normalises
 * both onto one internal shape, so no later stage has to branch on version.
 *
 *   schema 1.0   nets[].connections: ["U1.SDA", "U7.SDA"]
 *   schema 2.0   nets[].members:     [{ref_id:"U1", role:"DATA"}, ...]
 *
 * The difference is not cosmetic and the normaliser must not flatten it away.
 * Under 1.0 the pin name in "U1.SDA" is an ASSERTION dunkai made from a fixed
 * interface->name table without ever consulting the part; the backing dataset
 * carries no pinout data at all, so those names are frequently fabricated (see
 * dunkai's supervisor/nodes.py and pcb-agent DECISIONS.md D-076). Under 2.0
 * dunkai deliberately stopped claiming them and emits a ROLE instead.
 *
 * So a 1.0 pin name is carried through as `asserted_pin` — never as `role` —
 * and `provenance.pin_names_asserted` is set. Stage B treats an asserted pin as
 * a hint to be verified against the real part's pin set, not as fact. Silently
 * promoting it to a role would reintroduce exactly the bug 2.0 exists to kill.
 */

import { readFile } from "node:fs/promises"
import { stage, note } from "../lib/events.mjs"

/** Net-name / net_class fallbacks for 1.0, which carries no `interface`. */
const INTERFACE_FROM_NAME = [
  [/^(gnd|ground|vss)\b/i, "Power"],
  [/^(vcc|vdd|vbus|vbat|power|v\d|\d+v\d*)/i, "Power"],
  [/i2c|^s[cd][al]\b/i, "I2C"],
  [/spi|mosi|miso|sclk|^cs\b/i, "SPI"],
  [/uart|^[tr]x\b|txd|rxd/i, "UART"],
  [/usb|^d[pm]\b/i, "USB"],
  [/can\b/i, "CAN"],
  [/pwm/i, "PWM"],
  [/adc|analog|aout/i, "Analog"],
]

const inferInterface = (net) => {
  const cls = String(net.net_class || "").toLowerCase()
  if (cls === "power" || cls === "ground") return "Power"
  for (const [re, iface] of INTERFACE_FROM_NAME) {
    if (re.test(String(net.name || ""))) return iface
  }
  return "GPIO"
}

/** A 1.0 role is unknown — the pin string is a claim about the pad, not a role. */
const roleFromNetClass = (net) => {
  const cls = String(net.net_class || "").toLowerCase()
  if (cls === "ground") return "GROUND"
  if (cls === "power") return "SUPPLY"
  return "SIGNAL"
}

const normaliseComponent = (raw, index) => {
  const ref_id = String(raw.ref_id ?? raw.reference ?? raw.designator ?? "").trim()
  if (!ref_id) throw new Error(`component #${index} has no ref_id`)
  const part_number = String(raw.part_number ?? raw.mfr_part ?? raw.mpn ?? "").trim()
  if (!part_number) throw new Error(`component ${ref_id} has no part_number`)

  const quantity = Number.isFinite(Number(raw.quantity)) ? Math.max(1, Number(raw.quantity)) : 1
  const pkg = String(raw.package ?? raw.footprint ?? "").trim()

  const component = {
    ref_id,
    part_number,
    package: pkg || "CUSTOM",
    part_class: String(raw.part_class ?? raw.category ?? "ic").toLowerCase().trim(),
    quantity,
  }
  // Optional and only when genuinely present — a known-good catalogue number
  // lets Stage B skip straight to tier 1 instead of re-deriving it from the MPN.
  const lcsc = String(raw.lcsc ?? raw.lcsc_part ?? raw.jlcpcb_part ?? "").trim()
  if (lcsc && lcsc.toLowerCase() !== "nan") component.lcsc = lcsc
  if (raw.board_profile) component.board_profile = String(raw.board_profile)
  if (raw.required) component.required = true
  if (raw.device_reference) component.device_reference = String(raw.device_reference)
  return component
}

const normaliseNetV2 = (raw, index) => {
  const name = String(raw.name ?? `NET_${index + 1}`).trim()
  const members = (raw.members ?? [])
    .map((m) => ({
      ref_id: String(m.ref_id ?? "").trim(),
      role: String(m.role ?? "SIGNAL").trim().toUpperCase(),
      ...(m.pin_function ? { pin_function: String(m.pin_function).trim().toUpperCase() } : {}),
    }))
    .filter((m) => m.ref_id)
  return {
    name,
    net_class: String(raw.net_class ?? "signal").toLowerCase(),
    interface: String(raw.interface ?? inferInterface(raw)),
    members,
    ...(Number.isFinite(raw.voltage_v) ? { voltage_v: raw.voltage_v } : {}),
  }
}

const normaliseNetV1 = (raw, index) => {
  const name = String(raw.name ?? `NET_${index + 1}`).trim()
  const role = roleFromNetClass(raw)
  const members = (raw.connections ?? [])
    .map((conn) => {
      const text = String(conn ?? "").trim()
      if (!text) return null
      const dot = text.indexOf(".")
      const ref_id = dot === -1 ? text : text.slice(0, dot)
      const pin = dot === -1 ? "" : text.slice(dot + 1)
      const member = { ref_id: ref_id.trim(), role }
      // The claim, quarantined under its own key. Never `role`.
      if (pin) member.asserted_pin = pin.trim()
      return member.ref_id ? member : null
    })
    .filter(Boolean)
  return {
    name,
    net_class: String(raw.net_class ?? "signal").toLowerCase(),
    interface: inferInterface(raw),
    members,
  }
}

const DEFAULT_CONSTRAINTS = {
  layer_count: 2,
  board_outline: { shape: "rectangle", width_mm: 100, height_mm: 60 },
}

const normaliseConstraints = (raw) => {
  const c = raw ?? {}
  const outline = c.board_outline ?? {}
  const layer_count = Number(c.layer_count)
  const width = Number(outline.width_mm)
  const height = Number(outline.height_mm)
  return {
    layer_count: Number.isFinite(layer_count) && layer_count > 0
      ? layer_count
      : DEFAULT_CONSTRAINTS.layer_count,
    board_outline: {
      shape: String(outline.shape ?? "rectangle"),
      width_mm: Number.isFinite(width) && width > 0 ? width : DEFAULT_CONSTRAINTS.board_outline.width_mm,
      height_mm: Number.isFinite(height) && height > 0 ? height : DEFAULT_CONSTRAINTS.board_outline.height_mm,
    },
  }
}

/**
 * @param {object|string} input  pcb_ir object, or a path to a JSON file holding one
 * @returns {Promise<object>} normalised design
 */
export async function intake(input) {
  stage("A", "running")

  const pcbIr = typeof input === "string"
    ? JSON.parse(await readFile(input, "utf-8"))
    : input

  if (!pcbIr || typeof pcbIr !== "object") {
    throw new Error("pcb_ir is not an object")
  }

  const rawVersion = String(pcbIr.schema_version ?? "").trim()
  // Unversioned payloads are read as 1.0: `connections` was the original shape,
  // and guessing 2.0 would silently drop every pin claim on the floor.
  const isV2 = rawVersion.startsWith("2.")
  const schema_version = rawVersion || "1.0"

  const rawComponents = Array.isArray(pcbIr.components) ? pcbIr.components : []
  if (rawComponents.length === 0) throw new Error("pcb_ir carries no components")

  const components = rawComponents.map(normaliseComponent)

  const seen = new Set()
  for (const c of components) {
    if (seen.has(c.ref_id)) throw new Error(`duplicate ref_id in pcb_ir: ${c.ref_id}`)
    seen.add(c.ref_id)
  }

  const rawNets = Array.isArray(pcbIr.nets) ? pcbIr.nets : []
  const nets = rawNets.map((n, i) => (isV2 ? normaliseNetV2(n, i) : normaliseNetV1(n, i)))

  // Orphan check. eda.py only printed a warning and carried on; here it is a
  // recorded, structured finding, because a net member with no component is a
  // net that cannot be routed and the generator must be told, not left to guess.
  const warnings = []
  for (const net of nets) {
    for (const member of net.members) {
      if (!seen.has(member.ref_id)) {
        warnings.push(`net '${net.name}' references unknown ref_id '${member.ref_id}'`)
      }
    }
  }
  for (const net of nets) {
    net.members = net.members.filter((m) => seen.has(m.ref_id))
  }

  const emptyNets = nets.filter((n) => n.members.length === 0).map((n) => n.name)
  if (emptyNets.length) {
    warnings.push(`net(s) with no resolvable members, dropped: ${emptyNets.join(", ")}`)
  }

  const design = {
    design_name: String(pcbIr.design_name ?? "dunkai_design").trim() || "dunkai_design",
    schema_version,
    components,
    nets: nets.filter((n) => n.members.length > 0),
    constraints: normaliseConstraints(pcbIr.constraints),
    wireless_links: Array.isArray(pcbIr.wireless_links) ? pcbIr.wireless_links : [],
    external_components: Array.isArray(pcbIr.external_components) ? pcbIr.external_components : [],
    required_devices: Array.isArray(pcbIr.required_devices) ? pcbIr.required_devices : [],
    assembly_notes: Array.isArray(pcbIr.assembly_notes) ? pcbIr.assembly_notes : [],
    provenance: {
      source_schema: schema_version,
      // The single flag every later stage keys off when deciding how much to
      // trust a pin name it was handed.
      pin_names_asserted: !isV2,
      warnings,
    },
  }

  // A connector alone does not satisfy a requirement for the actual device.
  for (const device of design.required_devices) {
    const external = design.external_components.find((c) => c.node_id === device.node_id && c.external_key === device.key)
    if (!external?.mfr_part || !external.device_profile || external.status === "SELECTION_REQUIRED" || !external.pcb_references?.length) {
      throw new Error(`Required device ${device.label} is missing its system BOM part or PCB connection path`)
    }
    if (external.via_reference && !design.external_components.some((c) => c.reference === external.via_reference && c.device_profile === "solar_manager")) {
      throw new Error(`Required device ${device.label} is missing its external charger`)
    }
    for (const ref of external.pcb_references) {
      if (!seen.has(ref)) throw new Error(`Required device ${device.label} references a missing PCB port ${ref}`)
    }
  }

  for (const w of warnings) note(`  intake warning: ${w}`)

  stage(
    "A",
    "done",
    `schema ${schema_version} · ${design.components.length} components · ` +
      `${design.nets.length} nets · ${design.wireless_links.length} wireless link(s)` +
      (warnings.length ? ` · ${warnings.length} warning(s)` : "")
  )
  return design
}
