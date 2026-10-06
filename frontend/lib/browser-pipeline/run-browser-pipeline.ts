import { aiApi, ApiError } from '@/lib/api'
import type { AiOutput } from '@/lib/store'
import type { BrowserPipelineInput, BrowserPipelineResult, PipelineWorkerInput, PipelineWorkerOutput } from './protocol'
import { readCheckpoint, saveCheckpoint, type BrowserCheckpoint } from './checkpoint'

/** The page relays authenticated inference and progress. Agent parsing,
 * validation and artifact assembly run in a dedicated client worker. */
export async function runBrowserPipeline(
  request: string,
  history: BrowserPipelineInput['history'],
  onProgress: (stage: string) => void,
  signal?: AbortSignal,
  existing?: AiOutput | null,
  recovery?: { key: string; resume?: boolean },
): Promise<BrowserPipelineResult> {
  if (signal?.aborted) return Promise.reject(new Error('Run cancelled'))
  if (typeof Worker === 'undefined') return Promise.reject(new Error('This browser does not support local agent workers'))

  const checkpoint: BrowserCheckpoint = recovery?.resume
    ? await readCheckpoint(recovery.key) || (() => { throw new Error('This device has no saved run to resume') })()
    : { version: 1, id: crypto.randomUUID(), input: {
      request, history: history.slice(-5), existing: existing ? { requirements: existing.requirements, architecture: existing.architecture, bom: existing.bom, pcb_ir: existing.pcb_ir } : null,
    }, calls: { design: { requestId: crypto.randomUUID() }, firmware: { requestId: crypto.randomUUID() } } }
  if (recovery) await saveCheckpoint(recovery.key, checkpoint)
  if (signal?.aborted) throw new Error('Run cancelled')
  if (checkpoint.result) {
    for (const stage of ['requirements', 'architecture', 'component', 'pcb', 'validation', 'documentation']) onProgress(stage)
    return checkpoint.result
  }

  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pipeline.worker.ts', import.meta.url), { type: 'module', name: 'dunkai-agents' })
    const controller = new AbortController()
    let settled = false
    const inferenceRequested = new Set<string>()
    const finish = (error?: Error, result?: BrowserPipelineResult) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', cancel)
      controller.abort()
      worker.terminate()
      if (error) reject(error)
      else if (result) resolve(result)
      else reject(new Error('The browser agent returned no output'))
    }
    const cancel = () => finish(new Error('Run cancelled'))
    const timeout = setTimeout(() => finish(new Error('Browser agent run timed out')), 300_000)
    signal?.addEventListener('abort', cancel, { once: true })
    const post = (message: PipelineWorkerInput) => worker.postMessage(message)

    worker.onerror = () => finish(new Error('The browser agent worker could not run'))
    worker.onmessageerror = () => finish(new Error('The browser agent returned unreadable data'))
    worker.onmessage = async (event: MessageEvent<PipelineWorkerOutput>) => {
      if (settled) return
      const message = event.data
      try {
        if (message.type === 'progress') onProgress(message.stage)
        else if (message.type === 'complete') {
          if (!message.result.errors.length) checkpoint.result = message.result
          if (recovery) await saveCheckpoint(recovery.key, checkpoint)
          if (!settled) finish(undefined, message.result)
        }
        else if (message.type === 'error') finish(new Error(message.message))
        else if (message.type === 'inference') {
          // At most one design call and one applicable firmware call; the worker cannot choose a key,
          // model, destination, or arbitrary HTTP request.
          if (!['design', 'firmware'].includes(message.stage) || inferenceRequested.has(message.stage) || typeof message.prompt !== 'string' || message.prompt.length > 6000) {
            throw new Error('The browser agent requested unsupported model usage')
          }
          inferenceRequested.add(message.stage)
          const saved = checkpoint.calls[message.stage]
          if (saved.prompt && saved.prompt !== message.prompt) throw new Error('Saved model context changed. Start a new run after reviewing the design.')
          saved.prompt = message.prompt
          if (recovery) await saveCheckpoint(recovery.key, checkpoint)
          if (settled) return
          if (saved.content) { post({ type: 'inference-result', content: saved.content }); return }
          try {
            const answer = await aiApi.browserInference([{ role: 'user', content: message.prompt }], saved.requestId, controller.signal, message.stage)
            saved.content = answer.content
            if (recovery) await saveCheckpoint(recovery.key, checkpoint)
            if (!settled) post({ type: 'inference-result', content: answer.content })
          } catch (error) {
            if (!settled) {
              // Explicit server rejections end this request record. Retain the
              // completed design answer but give only this failed stage a new
              // ID on the next confirmed resume. Network interruption and a
              // pending duplicate keep the ID so server replay remains safe.
              if (error instanceof ApiError && ([400,402,429,502,503].includes(error.statusCode) || error.statusCode === 409 && /failed|already used/i.test(error.message))) {
                saved.requestId = crypto.randomUUID()
                if (recovery) await saveCheckpoint(recovery.key, checkpoint)
              }
              post({ type: 'inference-error', message: error instanceof Error ? error.message : 'Model request failed' })
            }
          }
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error('Browser agent communication failed'))
      }
    }
    try {
      post({ type: 'start', input: checkpoint.input })
    } catch {
      finish(new Error('Could not transfer this design to the browser worker'))
    }
    if (signal?.aborted) cancel()
  })
}
