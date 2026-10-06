import { readLocal, writeLocal, deleteLocal } from './local-storage'
import type { BrowserPipelineInput, BrowserPipelineResult } from './protocol'

export type BrowserCheckpoint = {
  version: 1
  id: string
  input: BrowserPipelineInput
  calls: Record<'design' | 'firmware', { requestId: string; prompt?: string; content?: string }>
  result?: BrowserPipelineResult
}
export const readCheckpoint = (key: string) => readLocal<BrowserCheckpoint>(`run:${key}`)
export const saveCheckpoint = (key: string, checkpoint: BrowserCheckpoint) => writeLocal(`run:${key}`, checkpoint, 7 * 24 * 60 * 60_000)
export const clearCheckpoint = (key: string) => deleteLocal(`run:${key}`)
