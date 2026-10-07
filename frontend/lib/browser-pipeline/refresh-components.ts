import type { AiOutput } from '../store'

export function refreshComponents(ir: Record<string,unknown>, signal: AbortSignal): Promise<Partial<AiOutput>> {
  if (signal.aborted) return Promise.reject(new Error('Component refresh cancelled'))
  return new Promise((resolve,reject) => {
    const worker = new Worker(new URL('./component-refresh.worker.ts',import.meta.url),{type:'module',name:'dunkai-component-refresh'})
    let settled = false
    const finish = (error?:Error,data?:Partial<AiOutput>) => {
      if (settled) return
      settled=true;clearTimeout(timeout);signal.removeEventListener('abort',cancel);worker.terminate()
      if (error) reject(error);else resolve(data!)
    }
    const cancel = () => finish(new Error('Component refresh cancelled'))
    const timeout=setTimeout(()=>finish(new Error('Component refresh timed out')),180000)
    signal.addEventListener('abort',cancel,{once:true})
    worker.onerror=()=>finish(new Error('The component worker could not run'))
    worker.onmessageerror=()=>finish(new Error('The component worker returned unreadable data'))
    worker.onmessage=(event:MessageEvent<{error?:string;data?:Partial<AiOutput>}>)=>{
      if(event.data.error) finish(new Error(event.data.error));else if(event.data.data)finish(undefined,event.data.data)
      else finish(new Error('The component worker returned no component data'))
    }
    try{worker.postMessage({ir})}catch{finish(new Error('Could not send the design to the component worker'))}
    if(signal.aborted)cancel()
  })
}
