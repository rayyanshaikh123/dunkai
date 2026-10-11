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
  "student-digital-3p": {
    part: "1x3 2.54mm through-hole header", package: "HDR-3-P2.54",
    exportName: "DunkaiDigitalHeader3", footprint: "pinrow3_p2.54mm_id1mm_od1.8mm",
    labels: { pin1: ["GND"], pin2: ["VCC"], pin3: ["SIG", "GPIO", "PWM", "DATA"] },
    attributes: { pin1: { requiresGround: true }, pin2: { requiresPower: true } },
  },
  "student-i2c-4p": {
    part: "1x4 2.54mm through-hole header", package: "HDR-4-P2.54",
    exportName: "DunkaiI2CHeader4", footprint: "pinrow4_p2.54mm_id1mm_od1.8mm",
    labels: { pin1: ["GND"], pin2: ["VCC"], pin3: ["SCL"], pin4: ["SDA"] },
    attributes: { pin1: { requiresGround: true }, pin2: { requiresPower: true } },
  },
  "student-divider-10k": {
    part: "10k 1% 0603 resistor", package: "0603", exportName: "DunkaiDivider10k", footprint: "0603",
    kind: "resistor", value: "10k", labels: { pin1: ["A"], pin2: ["B"] }, attributes: {},
  },
  "ads1115-dgs": {
    part: "ADS1115IDGSR", package: "VSSOP-10", exportName: "DunkaiADS1115DGS", footprint: "msop10",
    labels: { pin1: ["ADDR"], pin2: ["ALERT_RDY"], pin3: ["GND"], pin4: ["AIN0"], pin5: ["AIN1"],
      pin6: ["AIN2"], pin7: ["AIN3"], pin8: ["VDD"], pin9: ["SDA"], pin10: ["SCL"] },
    attributes: { pin3: { requiresGround: true }, pin8: { requiresPower: true } },
    source: "https://www.ti.com/lit/ds/symlink/ads1115.pdf (DGS pinout, page 3)",
  },
  "pico-w-40": {
    part: "SC0918", package: "MODULE-PICO-40", exportName: "DunkaiPicoW", footprint: "dip40_w17.78mm_p2.54mm",
    labels: { pin1: ["GP0"], pin2: ["GP1"], pin3: ["GND"], pin4: ["GP2"], pin5: ["GP3"], pin6: ["GP4"], pin7: ["GP5"], pin8: ["GND"],
      pin9: ["GP6"], pin10: ["GP7"], pin11: ["GP8"], pin12: ["GP9"], pin13: ["GND"], pin14: ["GP10"], pin15: ["GP11"], pin16: ["GP12"],
      pin17: ["GP13"], pin18: ["GND"], pin19: ["GP14"], pin20: ["GP15"], pin21: ["GP16"], pin22: ["GP17"], pin23: ["GND"], pin24: ["GP18"],
      pin25: ["GP19"], pin26: ["GP20"], pin27: ["GP21"], pin28: ["GND"], pin29: ["GP22"], pin30: ["RUN"], pin31: ["GP26", "ADC0"],
      pin32: ["GP27", "ADC1"], pin33: ["AGND"], pin34: ["GP28", "ADC2"], pin35: ["ADC_VREF"], pin36: ["3V3_OUT"], pin37: ["3V3_EN"],
      pin38: ["GND"], pin39: ["VSYS"], pin40: ["VBUS"] },
    attributes: Object.fromEntries([3, 8, 13, 18, 23, 28, 33, 38].map((p) => [`pin${p}`, { requiresGround: true }])),
    source: "https://datasheets.raspberrypi.com/picow/pico-w-datasheet.pdf (40-pin interface; use two 20-pin 2.54mm rows 17.78mm apart)",
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
    `export const ${p.exportName} = (props: any) => <${p.kind ?? "chip"} {...props} ${p.kind === "resistor" ? `resistance=${JSON.stringify(p.value)} ` : ""}pinLabels={pinLabels} pinAttributes={pinAttributes} footprint=${JSON.stringify(p.footprint)} manufacturerPartNumber=${JSON.stringify(p.part)} />\n`
  const file = path.join(workdir, "imports", `${p.exportName}.tsx`)
  await writeFile(file, source)
  return {
    ok: true, tier: "documented", file, footprinter: p.footprint, padCount: compiled.pads,
    chip: { pinLabels: p.labels, pinAttributes: p.attributes, pinCount: compiled.pads,
      exportName: p.exportName, footprint: p.footprint, placeholderRatio: 0 },
    gates: { passed: true, failures: [], notes: [p.source ?? "Explicit custom harness pin order; not a Gravity/JST mating footprint"] },
  }
}
