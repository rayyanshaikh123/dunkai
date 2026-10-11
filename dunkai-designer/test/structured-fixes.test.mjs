import { test } from "node:test"
import assert from "node:assert/strict"
import { applyStructuredFixes } from "../src/lib/structured-fixes.mjs"

const output = ({ routeErrors, errors, traces }) => ({
  circuitJson: [
    { type: "source_component", source_component_id: "source-j1", name: "J1" },
    { type: "pcb_component", source_component_id: "source-j1", pcb_component_id: "pcb-j1", width: 4, height: 4, center: { x: 0, y: 0 } },
    { type: "pcb_courtyard_rect", pcb_component_id: "pcb-j1", center: { x: 0, y: 0 }, width: 4, height: 4 },
    ...Array.from({ length: routeErrors }, () => ({ type: "pcb_port_not_connected_error", message: "open required header pin" })),
  ],
  stats: { errors, traces, errorTypes: routeErrors ? ["pcb_port_not_connected_error"] : [] },
})

test("structured PCB generation retries wider placement until required ports route", async () => {
  const structured = {
    size: { widthMm: 20, heightMm: 20 },
    mapping: { assignments: { J1: { pin1: "GND" } } },
    support: [],
    emit: async () => {},
  }
  let builds = 0
  const result = await applyStructuredFixes(structured, output({ routeErrors: 1, errors: 1, traces: 2 }), async () => {
    builds += 1
    if (builds < 3) return output({ routeErrors: 1, errors: 1, traces: 3 })
    return output({ routeErrors: 0, errors: 0, traces: 4 })
  })

  assert.equal(builds, 3, "tries code placement and two wider retry layouts")
  assert.equal(result.circuitJson.some((e) => e.type === "pcb_port_not_connected_error"), false)
})
