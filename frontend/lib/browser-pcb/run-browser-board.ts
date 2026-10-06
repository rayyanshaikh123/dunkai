import type { CircuitWebWorker } from '@tscircuit/eval/worker'
import { compileBrowserIr } from './passive-ir'
import { renderBrowserPreviews } from './render-browser-previews'

export type BrowserBoardResult = {
  pcbSvg: string
  schematicSvg: string
  circuitJson: Array<{ type: string }>
}

let activeWorker: CircuitWebWorker | null = null
let activeAbort: AbortController | null = null

export function cancelBrowserBoard() {
  activeAbort?.abort()
  void activeWorker?.kill().catch(() => {})
}

/** No user/model-authored TSX is accepted. Only the validated IR compiler emits code. */
export async function runBrowserBoard(
  ir: unknown,
  onProgress: (stage: string, label: string) => void,
): Promise<BrowserBoardResult> {
  if (activeAbort) throw new Error('A browser board run is already active')
  const compiled = compileBrowserIr(ir)
  const controller = new AbortController()
  activeAbort = controller
  let worker: CircuitWebWorker | null = null
  const timeout = setTimeout(() => {
    controller.abort()
    void worker?.kill().catch(() => {})
  }, 5 * 60_000)
  const check = () => {
    if (controller.signal.aborted) throw new Error('Board generation cancelled')
  }
  try {
    onProgress('load', 'Loading the PCB engine in this browser…')
    const { createCircuitWebWorker } = await import('@tscircuit/eval/worker')
    check()
    worker = await createCircuitWebWorker({
      webWorkerBlobUrl: '/vendor/tscircuit-eval-worker.js',
      disableCdnLoading: true,
      enableFetchProxy: false,
    })
    activeWorker = worker
    check()
    onProgress('pcb', `Routing ${compiled.componentCount} components and ${compiled.netCount} nets…`)
    await worker.executeWithFsMap({ fsMap: { 'index.tsx': compiled.code }, mainComponentPath: 'index.tsx' })
    await worker.renderUntilSettled()
    check()
    const circuitJson = await worker.getCircuitJson()
    check()
    // Release the heavy evaluator before creating the preview worker. Keep
    // the number of concurrently active compute workers bounded.
    await worker.kill()
    activeWorker = null
    worker = null
    check()
    onProgress('preview', 'Preparing PCB and schematic previews…')
    const previews = await renderBrowserPreviews(circuitJson, compiled.componentCount, controller.signal)
    return { ...previews, circuitJson }
  } finally {
    clearTimeout(timeout)
    if (worker) await worker.kill().catch(() => {})
    if (activeWorker === worker) activeWorker = null
    if (activeAbort === controller) activeAbort = null
  }
}
