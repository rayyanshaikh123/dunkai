import type { AiOutput } from '@/lib/store'

export type BrowserPipelineInput = {
  request: string
  history: Array<{ role: 'user' | 'assistant'; content: string; options?: string[] }>
  existing?: Pick<AiOutput, 'requirements' | 'architecture' | 'bom' | 'pcb_ir'> | null
  interview?: {turn:number}
}

export type BrowserPipelineResult = Partial<AiOutput> & {
  messages: Array<{ content: string }>
  errors: string[]
  interview_status?: 'question' | 'complete'
  interview_question?: string
  interview_options?: string[]
}

export type PipelineWorkerInput =
  | { type: 'start'; input: BrowserPipelineInput }
  | { type: 'inference-result'; content: string }
  | { type: 'inference-error'; message: string }

export type PipelineWorkerOutput =
  | { type: 'progress'; stage: string }
  | { type: 'inference'; prompt: string; stage: 'design' | 'firmware' | 'interview' }
  | { type: 'complete'; result: BrowserPipelineResult }
  | { type: 'error'; message: string }
