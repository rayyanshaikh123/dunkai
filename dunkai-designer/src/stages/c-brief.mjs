/**
 * Stage C — design brief synthesis.
 *
 * Deterministic assembly, not a model call. The brief is the contract Stage D
 * builds against, so it must be a faithful rendering of what Stage A read and
 * Stage B actually resolved. Asking a model to "write a brief" here would let
 * requirements drift between the handoff and the board while everything still
 * looked plausible — the one failure mode that is expensive to catch later.
 *
 * What the brief adds over the raw IR is the part of Stage B's findings the
 * generator must act on: which parts got substituted, which have no usable pin
 * names, and which carry a synthesised land pattern.
 */

import { stage } from "../lib/events.mjs"

const heading = (text) => `\n## ${text}\n`

function renderComponents(resolutions) {
  const lines = [
    "| Ref | Part | Package | Import | Footprint | Tier |",
    "|-----|------|---------|--------|-----------|------|",
  ]
  for (const r of resolutions) {
    const c = r.component
    const importName = r.chip?.exportName ?? (r.ok ? "(custom)" : "—")
    const fp = r.footprinter ?? "—"
    lines.push(
      `| ${c.ref_id} | ${c.part_number} | ${c.package} | ${importName} | \`${fp}\` | ${r.ok ? r.tier : "UNRESOLVED"} |`
    )
  }
  return lines.join("\n")
}

function renderNets(design) {
  const lines = []
  for (const net of design.nets) {
    const members = net.members
      .map((m) => {
        // Under schema 1.0 the pin name is a claim, so it is shown as a hint in
        // brackets rather than as an instruction. Stage D is told, in the rules
        // below, to verify it against the imported symbol before using it.
        const pin = m.asserted_pin ? ` [claimed pin: ${m.asserted_pin}]` : ""
        const fn = m.pin_function ? ` [verified symbol function: ${m.pin_function}]` : ""
        return `${m.ref_id}:${m.role}${pin}${fn}`
      })
      .join(", ")
    lines.push(`- **${net.name}** (${net.net_class}, ${net.interface}) — ${members}`)
  }
  return lines.join("\n") || "- (no nets declared)"
}

export function synthesiseBrief(design, resolution) {
  stage("C", "running")

  const { resolutions, unresolved, placeholders, substituted } = resolution
  const c = design.constraints

  const parts = []

  parts.push(`# ${design.design_name}`)
  parts.push(
    `\nA ${c.board_outline.width_mm} x ${c.board_outline.height_mm} mm, ` +
      `${c.layer_count}-layer board, generated from a dunkai pcb_ir handoff ` +
      `(schema ${design.schema_version}).`
  )

  parts.push(heading("Board"))
  parts.push(
    [
      `- Outline: ${c.board_outline.shape}, ${c.board_outline.width_mm} mm x ${c.board_outline.height_mm} mm`,
      `- Layers: ${c.layer_count}`,
      `- Autorouter: "auto"`,
    ].join("\n")
  )

  parts.push(heading("Components"))
  parts.push(renderComponents(resolutions))
  parts.push(
    "\nEvery resolved part above already exists in `./imports/` with its " +
      "manufacturer part number, supplier part number, pin labels and CAD model. " +
      "Import it, do not redeclare it."
  )

  parts.push(heading("Nets"))
  parts.push(renderNets(design))

  if (design.external_components?.length) {
    parts.push(heading("Required external devices and wiring"))
    parts.push(design.external_components.map((device) =>
      `- **${device.reference ?? device.node_id} ${device.subsystem ?? device.external_key ?? "Module"}**: ${device.manufacturer ?? ""} ${device.mfr_part}. ` +
      `PCB connection: ${(device.pcb_references ?? []).join(", ")}${device.via_reference ? ` via ${device.via_reference}` : ""}. ${device.assembly ?? ""}`
    ).join("\n"))
    parts.push("\nEvery listed external device remains a required system BOM part. Do not replace it with its connector or invent a chip footprint for its body. Header pin order defines a custom harness, not a plug-compatible JST/Gravity connector. Keep regulated 5V input and 3.3V logic rails separate.")
  }

  if (design.wireless_links.length) {
    parts.push(heading("Wireless links — NOT board nets"))
    parts.push(
      design.wireless_links
        .map((w) => `- ${w.interface}: ${(w.endpoints ?? []).join(" <-> ")} — ${w.note ?? "travels through the air"}`)
        .join("\n")
    )
    parts.push("\nDo not route copper for these. They are recorded for documentation only.")
  }

  // --- the parts of Stage B the generator has to act on ---------------------

  if (placeholders.length) {
    parts.push(heading("UNNAMED PINS — wire these by pin number"))
    parts.push(
      placeholders
        .map((r) => {
          const n = r.chip.placeholderPins.length
          const total = r.chip.pinCount
          const named = Object.entries(r.chip.pinLabels)
            .filter(([k, v]) => !(v.length === 1 && v[0] === k))
            .map(([k, v]) => `${k}=${v[0]}`)
            .join(", ")
          return (
            `- **${r.component.ref_id}** (${r.component.part_number}): ${n}/${total} pins carry no ` +
            `real name. Usable names: ${named || "none"}. ` +
            `Wire every other connection by pin NUMBER.`
          )
        })
        .join("\n")
    )
    parts.push(
      "\nThese symbols came back from the vendor without signal names. Wiring them " +
        "by an invented name produces a board that compiles and is wrong."
    )
  }

  if (substituted.length) {
    parts.push(heading("Substituted parts"))
    parts.push(
      substituted
        .map(
          (r) =>
            `- **${r.component.ref_id}**: requested \`${r.substituted.requested}\`, ` +
            `resolved to \`${r.substituted.got}\`. Use the resolved part.`
        )
        .join("\n")
    )
  }

  const customs = resolutions.filter((r) => r.ok && r.tier === 5)
  if (customs.length) {
    parts.push(heading("Synthesised land patterns"))
    parts.push(
      customs
        .map(
          (r) =>
            `- **${r.component.ref_id}** (${r.component.part_number}, ${r.component.package}): ` +
            `\`${r.footprinter}\` — ${r.custom?.rationale ?? "synthesised"}. ` +
            `Not catalogue-verified; declare it as the component's footprint string.`
        )
        .join("\n")
    )
  }

  if (unresolved.length) {
    parts.push(heading("UNRESOLVED — omit from the board"))
    parts.push(
      unresolved
        .map((r) => `- **${r.component.ref_id}** (${r.component.part_number}): ${r.reason}`)
        .join("\n")
    )
    parts.push(
      "\nThese have no usable footprint. Leave them out of the board entirely and " +
        "leave their nets unconnected rather than substituting a guess."
    )
  }

  if (design.provenance.pin_names_asserted) {
    parts.push(heading("Pin-name provenance"))
    parts.push(
      "This handoff is schema 1.0, where dunkai derived pin names from a fixed " +
        "interface table without consulting the selected part. Treat every " +
        "`[claimed pin: X]` above as a HINT: use it only when the imported symbol " +
        "actually has a pin by that name, and otherwise wire by role and pin number."
    )
  }

  if (design.provenance.warnings.length) {
    parts.push(heading("Intake warnings"))
    parts.push(design.provenance.warnings.map((w) => `- ${w}`).join("\n"))
  }

  const brief = parts.join("\n")

  stage(
    "C",
    "done",
    `${brief.length} chars · ${resolutions.length} parts · ${design.nets.length} nets` +
      (placeholders.length ? ` · ${placeholders.length} unnamed-pin part(s)` : "") +
      (unresolved.length ? ` · ${unresolved.length} omitted` : "")
  )
  return brief
}
