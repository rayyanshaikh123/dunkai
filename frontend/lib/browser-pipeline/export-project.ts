import type { AiOutput } from '@/lib/store'

export async function exportBrowserProject(output: AiOutput, signal: AbortSignal) {
  const files: Record<string, string> = {}
  const names = {pcbSvg:'pcb.svg',schematicSvg:'schematic.svg',circuitJson:'circuit.json'} as const
  for (const [key, filename] of Object.entries(names)) {
    const url = output.board?.urls[key as keyof typeof names]
    if (!url) continue
    const target = new URL(url, window.location.origin)
    if (target.origin !== window.location.origin || !target.pathname.startsWith('/api/v1/chats/')) throw new Error('Board export must use private project files')
    const response = await fetch(target, {credentials:'same-origin', signal})
    if (!response.ok) throw new Error('Could not retrieve the saved board files. Sign in again or retry.')
    const text = await response.text()
    if (text.length > 700000) throw new Error('Board export is too large')
    files[filename] = text
  }
  if (signal.aborted) throw new Error('Export cancelled')
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const worker = new Worker(new URL('./export-project.worker.ts', import.meta.url), {type:'module',name:'dunkai-project-export'})
    let done = false
    const finish = (error?:Error, data?:ArrayBuffer) => {
      if(done)return
      done=true;clearTimeout(timeout);signal.removeEventListener('abort',cancel);worker.terminate()
      if(error)reject(error);else if(data)resolve(data)
    }
    const cancel=()=>finish(new Error('Export cancelled'))
    const timeout=setTimeout(()=>finish(new Error('Export timed out')),30000)
    signal.addEventListener('abort',cancel,{once:true})
    worker.onerror=()=>finish(new Error('Could not start the project export worker'))
    worker.onmessage=(event)=>event.data.error?finish(new Error(event.data.error)):finish(undefined,event.data.data)
    worker.postMessage({output,files})
    if(signal.aborted)cancel()
  })
  const url=URL.createObjectURL(new Blob([bytes],{type:'application/zip'}))
  const link=document.createElement('a');link.href=url;link.download='dunkai-project-review.zip';link.click()
  setTimeout(()=>URL.revokeObjectURL(url),1000)
}
