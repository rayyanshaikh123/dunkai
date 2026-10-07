import type { CircuitWebWorker } from '@tscircuit/eval/worker'
import { wrap, releaseProxy, type Remote } from 'comlink'
import { compileBrowserIr } from './passive-ir'
import { renderBrowserPreviews } from './render-browser-previews'

export type BrowserBoardResult = {
  pcbSvg: string
  schematicSvg: string
  circuitJson: Array<{ type: string }>
}

type Evaluator = Pick<CircuitWebWorker, 'executeWithFsMap' | 'renderUntilSettled' | 'getCircuitJson'> & { setDisableCdnLoading: (value: boolean) => Promise<void> }
let activeWorker: Worker | null = null
let activeAbort: AbortController | null = null

export function cancelBrowserBoard() {
  activeAbort?.abort()
  activeWorker?.terminate()
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
  let worker: Worker | null = null
  let evaluator: Remote<Evaluator> | null = null
  const timeout = setTimeout(() => {
    controller.abort(new Error('Board generation timed out'))
    worker?.terminate()
  }, 5 * 60_000)
  const check = () => {
    if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('Board generation cancelled')
  }
  // Terminating a Comlink worker does not reject outstanding RPC promises.
  // Race every call against abort so cancellation always releases this run.
  const abortable = <T>(operation: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error('Board generation cancelled')) }
    const cleanup = () => controller.signal.removeEventListener('abort', abort)
    controller.signal.addEventListener('abort', abort, { once: true })
    operation.then((value) => { cleanup(); resolve(value) }, (error) => { cleanup(); reject(error) })
    if (controller.signal.aborted) abort()
  })
  try {
    onProgress('load', 'Loading the PCB engine in this browser…')
    check()
    worker = new Worker('/vendor/tscircuit-eval-worker.js', { type: 'module', name: 'dunkai-pcb-evaluator' })
    activeWorker = worker
    worker.onerror = () => controller.abort(new Error('The PCB evaluator worker could not run'))
    worker.onmessageerror = () => controller.abort(new Error('The PCB evaluator returned unreadable data'))
    evaluator = wrap<Evaluator>(worker)
    await abortable(evaluator.setDisableCdnLoading(true))
    check()
    onProgress('pcb', `Routing ${compiled.componentCount} components and ${compiled.netCount} nets…`)
    await abortable(evaluator.executeWithFsMap({ fsMap: { 'index.tsx': compiled.code }, mainComponentPath: 'index.tsx' }))
    await abortable(evaluator.renderUntilSettled())
    check()
    const circuitJson = await abortable(evaluator.getCircuitJson())
    check()
    // Release the heavy evaluator before creating the preview worker. Keep
    // the number of concurrently active compute workers bounded.
    evaluator[releaseProxy]()
    evaluator = null
    worker.terminate()
    activeWorker = null
    worker = null
    check()
    onProgress('preview', 'Preparing PCB and schematic previews…')
    const previews = await renderBrowserPreviews(circuitJson, compiled.componentCount, controller.signal)
    return { ...previews, circuitJson }
  } finally {
    clearTimeout(timeout)
    if (evaluator) evaluator[releaseProxy]()
    worker?.terminate()
    if (activeWorker === worker) activeWorker = null
    if (activeAbort === controller) activeAbort = null
  }
}
