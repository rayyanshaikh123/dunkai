import { z } from 'zod'
import { compileBrowserIr } from '../browser-pcb/passive-ir'
import { resolveCataloguePart } from '../browser-pcb/catalogue'
import type { ResolvedPart } from '../browser-pcb/catalogue-types'
import type { BrowserPipelineInput, BrowserPipelineResult } from './protocol'

const short = z.string().trim().min(1).max(240)
const ref = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/)
const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((value) => value === null || value === '' ? undefined : value, schema.optional())
const partSchema = z.object({ ref_id: ref, part_class: z.string().trim().min(1).max(40).toLowerCase(), part_number: optional(z.string().trim().min(1).max(120)), value: optional(z.string().trim().min(1).max(20)), package: z.string().trim().min(1).max(120), lcsc: optional(z.string().regex(/^C[1-9][0-9]{0,9}$/)) })
const netSchema = z.unknown().superRefine((raw, context) => {
  if (!raw || typeof raw !== 'object') return
  const net = raw as { connections?: unknown[]; members?: unknown[] }
  if (Array.isArray(net.connections) && net.connections.length && Array.isArray(net.members) && net.members.length) context.addIssue({code:'custom',message:'Use explicit connections or role members, not both'})
}).pipe(z.union([
  z.object({ name: ref, connections: z.array(z.string().min(3).max(100)).min(2).max(64) }),
  z.object({ name: ref, interface: short, net_class: optional(z.string().max(32)), members: z.array(z.object({ ref_id: ref, role: short, pin: optional(z.string().max(80)) })).min(2).max(32) }),
]))
const planSchema = z.object({
  project_name: short, summary: z.string().trim().min(1).max(1000), requirements: z.array(short).min(1).max(20),
  nodes: z.array(z.object({ id: ref, label: short, category: short })).min(1).max(32),
  edges: z.array(z.object({ source: ref, target: ref, interface: short })).max(64),
  parts: z.array(partSchema).max(32), nets: z.array(netSchema).max(256), unsupported_reasons: z.array(short).max(20),
})
const firmwareSchema = z.object({ files: z.array(z.object({ filename: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\.(ino|cpp|c|h|hpp|py|json|md)$/), code: z.string().max(12000), description: z.string().max(240) })).min(1).max(5) })
const INSTRUCTION = `Prepare a reviewable hardware design. Return JSON only:
{project_name,summary,requirements:string[],nodes:[{id,label,category}],edges:[{source,target,interface}],parts:[{ref_id,part_class,part_number?,value?,package,lcsc?}],nets:[{name,interface,net_class,members:[{ref_id,role}]}],unsupported_reasons:string[]}.
Select exact manufacturer part numbers, not generic categories. Physical parts and pins will be resolved independently against the catalogue; do not invent price, stock, pinout, or an LCSC code. Include all needed power, ground, interfaces and support parts. Passives use resistor/capacitor, value and 0402/0603/0805/1206 package; their nets may instead use connections:["R1.1","C1.2"]. For TI NE555P use timer and DIP8, and connections with verified labels GND/TRIG/OUT/RESET/CONT/THRES/DISCH/VCC. ATMEGA328P-AU in TQFP-32 has catalogue id C14877. Every architecture edge must name existing nodes. Use schema 2.0 members for ICs: Power SUPPLY/GROUND; I2C CLOCK/DATA; SPI CLOCK/MOSI/MISO/CHIP_SELECT; UART TX/RX; GPIO GPIO/INPUT/OUTPUT; ADC ANALOG_IN; PWM PWM. A member may provide pin only when it names an actual manufacturer-labelled pin, never an invented physical pad. Do not drop requested functions to make a board appear complete. List engineering constraints or unavailable capabilities in unsupported_reasons. Limit 32 components and 256 nets. This output needs engineering review.`

export async function runPipelineStages(
  { request, history, existing }: BrowserPipelineInput,
  infer: (prompt: string, stage: 'design' | 'firmware') => Promise<string>,
  onProgress: (stage: string) => void,
): Promise<BrowserPipelineResult> {
  onProgress('requirements')
  if (!request.trim() || request.length > 2500) throw new Error('Design request must contain 1–2,500 characters')
  const context = history.slice(-5).map((message) => `${message.role}: ${message.content.slice(0, 400)}`).join('\n')
  const prior = existing ? JSON.stringify({ requirements: existing.requirements, architecture: existing.architecture, components: (existing.pcb_ir as {components?: unknown[]})?.components?.map((part) => { const { resolved: _resolved, ...rest } = part as Record<string,unknown>; return rest }), nets: existing.pcb_ir?.nets }).slice(0, 1400) : ''
  const netInstruction = ' Each net has connections and members arrays; populate exactly one and leave the other empty. Explicit connections use interface:null; role members use the actual interface. Only unavailable requested functions belong in unsupported_reasons.'
  const prompt = `${INSTRUCTION}${netInstruction}\nPrevious context:\n${context}\nCurrent design:\n${prior}\nRequest:\n${request.slice(0, 2500)}`
  if (prompt.length > 6000) throw new Error('Design request is too long; shorten the request')
  let raw: unknown
  try { raw = JSON.parse(await infer(prompt, 'design')) } catch (error) { if (error instanceof SyntaxError) throw new Error('Groq returned invalid design JSON'); throw error }
  const parsed = planSchema.safeParse(raw)
  if (!parsed.success) throw new Error(`The model returned an incomplete design: ${parsed.error.issues.slice(0,5).map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}. Start a corrected request.`)
  const plan = parsed.data
  onProgress('architecture')
  const nodes = new Set(plan.nodes.map((node) => node.id))
  if (nodes.size !== plan.nodes.length || plan.edges.some((edge) => !nodes.has(edge.source) || !nodes.has(edge.target))) throw new Error('Architecture references are inconsistent')
  if (new Set(plan.parts.map((part) => part.ref_id)).size !== plan.parts.length) throw new Error('Duplicate component references')
  onProgress('component')
  const errors = [...plan.unsupported_reasons]
  const resolvedByRef = new Map<string, ResolvedPart>()
  const components: Array<Record<string, unknown>> = []
  // Two simultaneous catalogue conversions bound CPU/memory and upstream load.
  for (let offset = 0; offset < plan.parts.length; offset += 2) {
    const batch = await Promise.all(plan.parts.slice(offset, offset + 2).map(async (part) => {
      if (['resistor', 'capacitor'].includes(part.part_class) || part.part_class === 'timer' && part.part_number === 'NE555P' && part.package === 'DIP8') return { ...part }
      try {
        if (!part.part_number) throw new Error('Exact manufacturer part number is missing')
        const resolved = await resolveCataloguePart(part.part_number, part.package, part.lcsc)
        resolvedByRef.set(part.ref_id, resolved)
        return { ...part, part_number: resolved.partNumber, lcsc: resolved.lcsc, resolved }
      } catch (error) { errors.push(`${part.ref_id}: ${error instanceof Error ? error.message : 'component lookup failed'}`); return { ...part } }
    }))
    components.push(...batch)
  }
  const bom = { rows: plan.parts.map((part) => {
    const resolved = resolvedByRef.get(part.ref_id)
    return { reference: part.ref_id, category: part.part_class, component: part.value ? `${part.value} ${part.part_class}` : part.part_number || part.part_class,
      mfr_part: resolved?.partNumber || part.part_number, manufacturer: resolved?.manufacturer, package: resolved?.package || part.package, lcsc: resolved?.lcsc,
      build_quantity: 1, status: resolved ? 'catalogue_resolved_preview' : ['resistor','capacitor','timer'].includes(part.part_class) ? 'unverified' : 'unresolved' }
  }), summary: { total_line_items: plan.parts.length, unfilled_references: plan.parts.filter((part) => !resolvedByRef.has(part.ref_id) && part.part_class !== 'timer').map((part) => part.ref_id) } }
  onProgress('pcb')
  const size = Math.min(160, 40 + Math.ceil(Math.sqrt(plan.parts.length)) * 12)
  const pcbIr: Record<string, unknown> | null = components.length ? { schema_version: '2.0-browser', design_name: plan.project_name, components, nets: plan.nets,
    constraints: { layer_count: 2, board_outline: { shape: 'rectangle', width_mm: size, height_mm: size } } } : null
  let assignments: Record<string, Record<string, string>> = {}
  let structural = false
  if (pcbIr) {
    try { assignments = compileBrowserIr(pcbIr).assignments; structural = true } catch (error) { errors.push(error instanceof Error ? error.message : 'PCB pin resolution failed') }
  } else errors.push('No physical components were selected')
  onProgress('validation')
  const validation = { schema_version: '2.0-browser', well_formed: structural && !errors.length, scope: 'Catalogue-backed structural preview; independent electrical and fabrication review required', issue_count: errors.length,
    issues: errors.map((message) => ({ severity: 'error', code: 'design_review_required', message })), checks_run: ['component_references_resolve', 'pinout_availability', 'footprint_availability', 'net_connectivity'] }
  const processor = plan.parts.find((part) => /ATMEGA|ESP32|RP2040/i.test(part.part_number || ''))
  let codeGeneration: Record<string, unknown> = { project_name: plan.project_name, processing_unit: 'Not required', files: [], total_files: 0, languages_used: [] }
  if (processor && resolvedByRef.has(processor.ref_id) && structural) {
    onProgress('code_generation')
    const target = /ATMEGA328P/i.test(processor.part_number || '') ? 'arduino-uno' : /ESP32|RP2040/i.test(processor.part_number || '') ? 'micropython' : 'source-only'
    const pins = resolvedByRef.get(processor.ref_id)!.pinLabels
    const physical = Object.entries(assignments[processor.ref_id] || {}).map(([pin, net]) => ({ pin, labels: pins[pin], net }))
    const firmwarePrompt = `Return JSON {files:[{filename,code,description}]} for a complete reviewable firmware starter for ${processor.part_number}. Target ${target}. Requirements: ${JSON.stringify(plan.requirements)}. Physical mapping from catalogue: ${JSON.stringify(physical)}. Summary: ${plan.summary}. Do not invent connections. For Arduino Uno map ATmega port names to Arduino digital/analog numbers correctly, define functions before callers, use built-in core and bundled Wire/SPI libraries only, and produce main.ino plus README.md with configuration and limitations. For MicroPython produce main.py using machine.Pin/I2C/SPI/UART, only actual GPIO numbers from the physical mapping, plus README.md identifying required preinstalled MicroPython and drivers. Never actuate heaters, pumps, motors or relays at boot; use safe defaults. Do not claim tested hardware. Include all files needed by the selected approach, use no external downloads or shell commands. Limit response to 2048 output tokens.`
    try {
      if (firmwarePrompt.length > 6000) throw new Error('Firmware pin context is too large')
      const generated = firmwareSchema.parse(JSON.parse(await infer(firmwarePrompt, 'firmware')))
      const filenames = new Set(generated.files.map((file) => file.filename))
      if (filenames.size !== generated.files.length) throw new Error('Duplicate firmware filenames')
      codeGeneration = { project_name: plan.project_name, processing_unit: processor.part_number, target, files: generated.files.map((file) => ({ ...file, language: file.filename.endsWith('.py') ? 'python' : file.filename.endsWith('.md') ? 'text' : 'cpp', category: 'firmware' })), total_files: generated.files.length, languages_used: target === 'micropython' ? ['python'] : ['cpp'] }
    } catch (error) { errors.push(`Firmware: ${error instanceof Error ? error.message : 'generation failed'}`); codeGeneration = { ...codeGeneration, processing_unit: processor.part_number, target, error: 'Firmware generation needs a retry' } }
  }
  onProgress('documentation')
  const note = errors.length ? errors.join('; ') : 'Structural handoff passed local checks. Review electrical behavior and manufacturing details before ordering.'
  return {
    requirements: { project_name: plan.project_name, functional_requirements: plan.requirements },
    architecture: { architecture_graph: { nodes: plan.nodes.map((node) => ({id:node.id,data:{label:node.label,category:node.category}})), edges:plan.edges.map((edge,index)=>({id:`edge_${index+1}`,source:edge.source,target:edge.target,data:{interface:edge.interface}})) } },
    bom, eda_data: { components: [...resolvedByRef].map(([ref_id, part]) => ({ref_id, part_number:part.partNumber, footprint:part.package,pins_json:part.pinLabels,source:part.source})) }, pcb_ir: pcbIr,
    handoff_validation: { ...validation, issue_count: errors.length, issues: errors.map((message) => ({severity:'error',code:'design_review_required',message})) },
    code_generation: codeGeneration, documentation: { design_summary: plan.summary, engineering_docs: note },
    messages: [{content: errors.length ? `Design results are ready with review items: ${note}` : 'Design, component data, PCB handoff and applicable firmware are ready for review.'}], errors,
  }
}
