import { convertCircuitJsonToPcbSvg, convertCircuitJsonToSchematicSvg } from 'circuit-to-svg'

type CircuitJson = Parameters<typeof convertCircuitJsonToPcbSvg>[0]
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ circuitJson: CircuitJson; componentCount: number }>) => void) | null
  postMessage: (message: { pcbSvg: string; schematicSvg: string } | { error: string }) => void
}

scope.onmessage = (event) => {
  try {
    const { circuitJson, componentCount } = event.data
    if (circuitJson.length > 5000 || JSON.stringify(circuitJson).length > 700_000) {
      throw new Error('The browser board is too large to save. Reduce the design size.')
    }
    if (circuitJson.filter((item) => item.type === 'pcb_board').length !== 1 ||
        circuitJson.filter((item) => item.type === 'pcb_component').length !== componentCount ||
        !circuitJson.some((item) => item.type === 'pcb_trace')) {
      throw new Error('The PCB engine returned an incomplete board. The preview was not saved.')
    }
    const errors = circuitJson.filter((item) => item.type.endsWith('_error'))
    if (errors.length) {
      const findings = errors.slice(0,5).map((item) => {
        const message = (item as unknown as {message?:unknown}).message
        return `${item.type}${typeof message === 'string' ? `: ${message.slice(0,300)}` : ''}`
      }).join('; ')
      throw new Error(`The board was not saved (${errors.length} design error${errors.length===1?'':'s'}): ${findings}`)
    }
    const pcbSvg = convertCircuitJsonToPcbSvg(circuitJson)
    const schematicSvg = convertCircuitJsonToSchematicSvg(circuitJson)
    if (pcbSvg.length > 500_000 || schematicSvg.length > 500_000) {
      throw new Error('The board previews are too large to save. Reduce the design size.')
    }
    scope.postMessage({ pcbSvg, schematicSvg })
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : 'Could not prepare board previews' })
  }
}
