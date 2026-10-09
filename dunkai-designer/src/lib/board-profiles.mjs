/** Fixed interface footprints and pinouts for documented external assemblies.
 * Headers use our stated custom harness order, not an inferred JST pinout.
 * A profile is accepted only for its exact BOM identity and package.
 */
import { writeFile } from "node:fs/promises"
import path from "node:path"
import { validateFootprintString } from "./footprint.mjs"

const PROFILES = {
  "student-sensor-3p": {
    part: "1x3 2.54mm through-hole header", package: "HDR-3-P2.54",
    exportName: "DunkaiSensorHeader3", footprint: "pinrow3_p2.54mm_id1mm_od1.8mm",
    labels: { pin1: ["GND"], pin2: ["VCC"], pin3: ["A0", "ANALOG_OUT"] },
    attributes: { pin1: { requiresGround: true }, pin2: { requiresPower: true } },
  },
  "student-power-2p": {
    part: "1x2 2.54mm through-hole header", package: "HDR-2-P2.54",
    exportName: "DunkaiPowerHeader2", footprint: "pinrow2_p2.54mm_id1mm_od1.8mm",
    labels: { pin1: ["VCC", "REGULATED_5V"], pin2: ["GND"] },
    attributes: { pin1: { requiresPower: true }, pin2: { requiresGround: true } },
  },
  "tlv75533-dbv": {
    part: "TLV75533PDBVR", package: "SOT-23-5", exportName: "DunkaiTLV75533DBV", footprint: "sot23_5",
    labels: { pin1: ["IN"], pin2: ["GND"], pin3: ["EN"], pin4: ["NC"], pin5: ["OUT"] },
    attributes: { pin1: { requiresPower: true }, pin2: { requiresGround: true }, pin4: { doNotConnect: true } },
    source: "https://www.ti.com/lit/ds/symlink/tlv755p.pdf (DBV pinout, page 3)",
  },
}

export async function resolveBoardProfile(component, workdir, requireModule) {
  if (!component.board_profile) return null
  const p = PROFILES[component.board_profile]
  if (!p || component.part_number !== p.part || component.package !== p.package) {
    throw new Error(`Invalid documented PCB profile for ${component.ref_id}: BOM identity/package does not match ${component.board_profile}`)
  }
  const compiled = validateFootprintString(p.footprint, requireModule)
  if (!compiled.valid || compiled.pads !== Object.keys(p.labels).length) {
    throw new Error(`Documented footprint failed compilation: ${p.footprint}`)
  }
  const source = `// Fixed board interface; ${p.source ?? "custom harness order defined by DunkAI"}\n` +
    `const pinLabels = ${JSON.stringify(p.labels, null, 2)} as const\n` +
    `const pinAttributes = ${JSON.stringify(p.attributes, null, 2)} as const\n` +
    `export const ${p.exportName} = (props: any) => <chip {...props} pinLabels={pinLabels} pinAttributes={pinAttributes} footprint=${JSON.stringify(p.footprint)} manufacturerPartNumber=${JSON.stringify(p.part)} />\n`
  const file = path.join(workdir, "imports", `${p.exportName}.tsx`)
  await writeFile(file, source)
  return {
    ok: true, tier: "documented", file, footprinter: p.footprint, padCount: compiled.pads,
    chip: { pinLabels: p.labels, pinAttributes: p.attributes, pinCount: compiled.pads,
      exportName: p.exportName, footprint: p.footprint, placeholderRatio: 0 },
    gates: { passed: true, failures: [], notes: [p.source ?? "Explicit custom harness pin order; not a Gravity/JST mating footprint"] },
  }
}
