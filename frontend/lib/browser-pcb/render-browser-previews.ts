import type { BrowserBoardResult } from './run-browser-board'

export function renderBrowserPreviews(
  circuitJson: BrowserBoardResult['circuitJson'],
  componentCount: number,
  signal: AbortSignal,
): Promise<Pick<BrowserBoardResult, 'pcbSvg' | 'schematicSvg'>> {
  if (signal.aborted) return Promise.reject(new Error('Board generation cancelled'))
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./preview.worker.ts', import.meta.url), { type: 'module', name: 'dunkai-previews' })
    let settled = false
    const finish = (error?: Error, result?: Pick<BrowserBoardResult, 'pcbSvg' | 'schematicSvg'>) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', cancel)
      worker.terminate()
      if (error) reject(error)
      else if (result) resolve(result)
    }
    const cancel = () => finish(new Error('Board generation cancelled'))
    signal.addEventListener('abort', cancel, { once: true })
    worker.onerror = () => finish(new Error('The browser preview worker could not run'))
    worker.onmessageerror = () => finish(new Error('The browser preview worker returned unreadable data'))
    worker.onmessage = (event: MessageEvent<{ pcbSvg: string; schematicSvg: string } | { error: string }>) => {
      if ('error' in event.data) finish(new Error(event.data.error))
      else finish(undefined, event.data)
    }
    try { worker.postMessage({ circuitJson, componentCount }) } catch { finish(new Error('Could not transfer the board to its preview worker')) }
    if (signal.aborted) cancel()
  })
}
