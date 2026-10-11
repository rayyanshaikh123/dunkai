/** Check the compiler's circuit, including freeform generation and repairs.
 * A BOM entry and a pin-map promise cannot certify a missing final connector.
 */
export function validateRequiredConnections(design, circuit) {
  if (!design.required_devices?.length) return
  const components = new Map(circuit.filter((e) => e.type === "source_component").map((e) => [e.name, e]))
  const ports = circuit.filter((e) => e.type === "source_port")
  const pcbPorts = new Map(circuit.filter((e) => e.type === "pcb_port").map((e) => [e.source_port_id, e]))
  const nets = new Map(circuit.filter((e) => e.type === "source_net").map((e) => [e.name, e]))
  const parent = new Map()
  const root = (id) => {
    if (!parent.has(id)) parent.set(id, id)
    const p = parent.get(id)
    if (p !== id) parent.set(id, root(p))
    return parent.get(id)
  }
  for (const trace of circuit.filter((e) => e.type === "source_trace")) {
    const ids = [...(trace.connected_source_port_ids ?? []).map((id) => `p:${id}`),
      ...(trace.connected_source_net_ids ?? []).map((id) => `n:${id}`)]
    for (const id of ids.slice(1)) parent.set(root(id), root(ids[0]))
  }
  const fail = (label, detail) => { throw new Error(`Required device ${label}: ${detail}; the compiled board cannot omit this connection`) }
  const checkPin = (label, ref, pin, expected) => {
    const component = components.get(ref)
    if (!component) fail(label, `PCB component ${ref} is missing`)
    const port = ports.find((p) => p.source_component_id === component.source_component_id &&
      (p.pin_number === pin || p.name === `pin${pin}` || p.port_hints?.includes(`pin${pin}`)))
    const net = nets.get(String(expected?.name ?? "").replace(/[^A-Za-z0-9_]/g, "_"))
    if (!port || !net || root(`p:${port.source_port_id}`) !== root(`n:${net.source_net_id}`)) {
      fail(label, `${ref}.pin${pin} is not connected to ${expected?.name ?? "its required net"}`)
    }
    const pcbPort = pcbPorts.get(port.source_port_id)
    if (!pcbPort) fail(label, `${ref}.pin${pin} has no physical PCB port`)
    if (circuit.some((e) => e.type === "pcb_port_not_connected_error" &&
      (e.pcb_port_id === pcbPort.pcb_port_id || e.pcb_port_ids?.includes(pcbPort.pcb_port_id)))) {
      fail(label, `${ref}.pin${pin} is not connected by a PCB trace`)
    }
    const neighbours = new Set(expected.members.map((m) => components.get(m.ref_id)?.source_component_id).filter((id) => id && id !== component.source_component_id))
    if (!ports.some((p) => neighbours.has(p.source_component_id) && root(`p:${p.source_port_id}`) === root(`p:${port.source_port_id}`))) {
      fail(label, `${ref}.pin${pin} has no required counterpart on the board`)
    }
    return root(`p:${port.source_port_id}`)
  }
  const signalOwners = new Map()
  for (const device of design.required_devices) {
    const external = design.external_components.find((c) => c.node_id === device.node_id && c.external_key === device.key)
    for (const ref of external?.pcb_references ?? []) {
      const component = design.components.find((c) => c.ref_id === ref)
      const findNet = (role) => design.nets.find((n) => n.members.some((m) => m.ref_id === ref && m.role === role))
      if (["student-sensor-3p", "student-digital-3p"].includes(component?.board_profile)) {
        checkPin(device.label, ref, 1, findNet("GROUND"))
        checkPin(device.label, ref, 2, findNet("SUPPLY"))
        const signalNet = design.nets.find((n) => n.net_class === "signal" && n.members.some((m) => m.ref_id === ref))
        const signal = checkPin(device.label, ref, 3, signalNet)
        const other = signalOwners.get(signal)
        if (other && other !== device.node_id) fail(device.label, "independent analog sensor outputs have been shorted together")
        signalOwners.set(signal, device.node_id)
      } else if (component?.board_profile === "student-power-2p") {
        checkPin(device.label, ref, 1, findNet("SUPPLY"))
        checkPin(device.label, ref, 2, findNet("GROUND"))
      } else if (component?.board_profile === "student-i2c-4p") {
        checkPin(device.label, ref, 1, findNet("GROUND"))
        checkPin(device.label, ref, 2, findNet("SUPPLY"))
        checkPin(device.label, ref, 3, findNet("CLOCK"))
        checkPin(device.label, ref, 4, findNet("DATA"))
      } else if (!components.has(ref)) fail(device.label, `PCB interface ${ref} is missing`)
    }
  }
  for (const component of design.components.filter((c) => c.board_profile === "tlv75533-dbv")) {
    const ref = component.ref_id
    const forFunction = (fn) => design.nets.find((n) => n.members.some((m) => m.ref_id === ref && m.pin_function === fn))
    const input = checkPin("logic power supply", ref, 1, forFunction("IN"))
    checkPin("logic power supply", ref, 3, forFunction("EN"))
    const output = checkPin("logic power supply", ref, 5, forFunction("OUT"))
    if (input === output) fail("logic power supply", "regulator input and output are shorted together")
  }
}
