import { resolveDesignComponents } from './components'
import { compileBrowserIr } from '../browser-pcb/passive-ir'
import { netSchema } from './net-schema'

self.onmessage = async (event: MessageEvent<{ir:Record<string,unknown>}>) => {
  try {
    const {ir} = event.data
    if (JSON.stringify(ir).length > 150_000) throw new Error('Component design is too large')
    const result = await resolveDesignComponents(ir.components,true)
    const nets = netSchema.array().min(1).max(256).parse(ir.nets)
    const pcb_ir = {...ir,components:result.components,nets}
    const issues = [...result.errors]
    try { compileBrowserIr(pcb_ir) } catch (error) { issues.push(error instanceof Error ? error.message : 'PCB pin validation failed') }
    self.postMessage({data:{pcb_ir,bom:result.bom,eda_data:result.eda_data,handoff_validation:{
      schema_version:'2.0-browser',well_formed:!issues.length,scope:'Catalogue-backed structural preview; electrical and fabrication review required',
      issue_count:issues.length,issues:issues.map(message=>({severity:'error',code:'component_resolution',message})),
    }}})
  } catch (error) { self.postMessage({error:error instanceof Error ? error.message : 'Component refresh failed'}) }
}
