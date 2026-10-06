import { aiApi } from '@/lib/api'

export function reviseBrowserCode(files: Array<{ filename: string; code: string; description?: string }>, request: string, target: string, signal: AbortSignal): Promise<{reply: string; updated_files: Array<{filename: string; code: string; description: string; language: string; category: string}>}> {
  if (signal.aborted) return Promise.reject(new Error('Code revision cancelled'))
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./code-revision.worker.ts', import.meta.url), { type: 'module', name: 'dunkai-code-review' })
    const controller = new AbortController()
    let done = false, requested = false
    const finish = (error?: Error, result?: Parameters<typeof resolve>[0]) => {
      if (done) return
      done = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', cancel)
      controller.abort(); worker.terminate()
      if (error) reject(error)
      else if (result) resolve(result)
    }
    const cancel = () => finish(new Error('Code revision cancelled'))
    const timeout = setTimeout(() => finish(new Error('Code revision timed out')), 90_000)
    signal.addEventListener('abort', cancel, { once: true })
    worker.onerror = () => finish(new Error('Could not start the code revision worker'))
    worker.onmessage = async (event) => {
      if (done) return
      const message = event.data
      try {
        if (message.type === 'error') finish(new Error(message.message))
        else if (message.type === 'complete') finish(undefined, message.result)
        else if (message.type === 'inference') {
          if (requested || typeof message.prompt !== 'string' || message.prompt.length > 6000) throw new Error('Unsupported code model request')
          requested = true
          const answer = await aiApi.browserInference([{ role: 'user', content: message.prompt }], crypto.randomUUID(), controller.signal, 'revision')
          if (!done) worker.postMessage({ type: 'answer', content: answer.content })
        }
      } catch (error) { finish(error instanceof Error ? error : new Error('Code revision failed')) }
    }
    worker.postMessage({ type: 'start', files: files.map((item) => ({ ...item, description: item.description || '' })), request, target })
    if (signal.aborted) cancel()
  })
}
