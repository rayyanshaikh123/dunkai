import { runPipelineStages } from './pipeline-stages'
import type { PipelineWorkerInput, PipelineWorkerOutput } from './protocol'

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<PipelineWorkerInput>) => void) | null
  postMessage: (message: PipelineWorkerOutput) => void
}
let started = false
let pendingInference: { resolve: (content: string) => void; reject: (error: Error) => void } | null = null

scope.onmessage = (event) => {
  const message = event.data
  if (message.type === 'inference-result') {
    pendingInference?.resolve(message.content)
    pendingInference = null
    return
  }
  if (message.type === 'inference-error') {
    pendingInference?.reject(new Error(message.message))
    pendingInference = null
    return
  }
  if (message.type !== 'start' || started) return
  started = true
  void runPipelineStages(message.input, (prompt, stage) => new Promise<string>((resolve, reject) => {
    pendingInference = { resolve, reject }
    scope.postMessage({ type: 'inference', prompt, stage })
  }), (stage) => scope.postMessage({ type: 'progress', stage })).then(
    (result) => scope.postMessage({ type: 'complete', result }),
    (error: unknown) => scope.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Browser agent failed' }),
  )
}
