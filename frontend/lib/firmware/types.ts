export interface Stk500Flash {
  protocol: 'stk500v1'
  baudRates: number[]
  signature: number[]
  pageSize: number
}

export interface EspFlash {
  protocol: 'esptool'
  chip: string
}

export interface ManualFlash {
  protocol: 'manual'
  note: string
}

export interface FirmwareBoard {
  id: string
  label: string
  fqbn: string
  platform: string
  installed: boolean
  flash: Stk500Flash | EspFlash | ManualFlash
}

export interface FirmwareBoardsResponse {
  toolchain: { available: boolean; version: string | null; error?: string }
  boards: FirmwareBoard[]
  suggestedBoardId: string | null
}

export interface FirmwareImage {
  address: number
  size: number
  data: string
}

export interface FirmwareBuild {
  buildId: string
  cached: boolean
  board: Omit<FirmwareBoard, 'installed'>
  summary: string[]
  log: string
  skipped: string[]
  download: { filename: string; size: number; url?: string }
  images: FirmwareImage[]
}

export interface FlashProgress {
  phase: 'write' | 'verify'
  done: number
  total: number
}

export const decodeImage = (img: FirmwareImage) => Uint8Array.from(atob(img.data), (c) => c.charCodeAt(0))
