import type { AiOutput } from '@/lib/store'

export type BrowserPipelineInput = {
  request: string
  history: Array<{ role: 'user' | 'assistant'; content: string }>
  existing?: Pick<AiOutput, 'requirements' | 'architecture' | 'bom' | 'pcb_ir'> | null
}

export type BrowserPipelineResult = Partial<AiOutput> & {
  messages: Array<{ content: string }>
  errors: string[]
}

export type PipelineWorkerInput =
  | { type: 'start'; input: BrowserPipelineInput }
  | { type: 'inference-result'; content: string }
  | { type: 'inference-error'; message: string }

export type PipelineWorkerOutput =
  | { type: 'progress'; stage: string }
  | { type: 'inference'; prompt: string; stage: 'design' | 'firmware' }
  | { type: 'complete'; result: BrowserPipelineResult }
  | { type: 'error'; message: string }
