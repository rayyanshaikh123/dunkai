import type { FirmwareBoard, FirmwareBoardsResponse, FirmwareBuild } from './types'
import { elfToFlash, flashToHex } from './elf'

const BOARDS: FirmwareBoard[] = [
  { id: 'uno', label: 'Arduino Uno · ATmega328P · 16 MHz', fqbn: 'arduino:avr:uno', platform: 'avr', installed: true, flash: { protocol: 'stk500v1', baudRates: [115200], signature: [0x1e, 0x95, 0x0f], pageSize: 128 } },
  { id: 'nano', label: 'Arduino Nano · ATmega328P · 16 MHz', fqbn: 'arduino:avr:nano:cpu=atmega328', platform: 'avr', installed: true, flash: { protocol: 'stk500v1', baudRates: [57600, 115200], signature: [0x1e, 0x95, 0x0f], pageSize: 128 } },
]
export const browserFirmwareBoards = (processor: string): FirmwareBoardsResponse => ({
  toolchain: { available: true, version: 'LLVM AVR / pinned Sekiz toolchain' }, boards: BOARDS,
  suggestedBoardId: /ATMEGA328P/i.test(processor) ? 'uno' : null,
})
let compilerActive = false

export async function compileBrowserFirmware(
  boardId: string,
  files: Array<{ filename: string; code: string }>,
  progress: (message: string) => void,
  signal?: AbortSignal,
): Promise<FirmwareBuild> {
  const board = BOARDS.find((item) => item.id === boardId)
  if (!board) throw new Error('Local compilation supports ATmega328P Uno and Nano targets')
  const sources = files.filter((file) => /\.(ino|cpp|c|h|hpp)$/.test(file.filename))
  if (!sources.length || sources.length > 16 || sources.some((file) => !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(file.filename)) || sources.reduce((sum, file) => sum + file.code.length, 0) > 100_000) throw new Error('Invalid or oversized firmware sources')
  if (signal?.aborted) throw new Error('Compilation cancelled')
  if (compilerActive) throw new Error('A local firmware compilation is already running')
  if (new Set(sources.map((file) => file.filename)).size !== sources.length) throw new Error('Duplicate firmware filenames')
  if (!window.confirm('Compile firmware on this device? The compiler downloads about 28 MB once and uses this device’s CPU and memory.')) throw new Error('Compilation cancelled')
  compilerActive = true
  let elf: Uint8Array
  try { elf = await new Promise<Uint8Array>((resolve, reject) => {
    const worker = new Worker('/vendor/avr/worker.js', { name: 'dunkai-avr-compiler' })
    let finished = false
    const finish = (error?: Error, bytes?: Uint8Array) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', cancel)
      worker.terminate()
      if (error) reject(error)
      else if (bytes) resolve(bytes)
    }
    const cancel = () => finish(new Error('Compilation cancelled'))
    const timeout = setTimeout(() => finish(new Error('Local firmware compilation timed out')), 180_000)
    signal?.addEventListener('abort', cancel, { once: true })
    worker.onerror = () => finish(new Error('Could not start the local compiler worker'))
    worker.onmessage = (event) => {
      const message = event.data
      if (message.type === 'progress') progress(`Loading ${message.label}${message.total ? ` · ${Math.round(message.got / message.total * 100)}%` : ''}`)
      else if (message.type === 'stage') progress(message.stage)
      else if (message.type === 'ready') worker.postMessage({ cmd: 'compile', files: sources })
      else if (message.type === 'error') finish(new Error(message.log || 'Local compiler failed'))
      else if (message.type === 'done') finish(undefined, new Uint8Array(message.elf))
    }
    worker.postMessage({ cmd: 'init' })
    if (signal?.aborted) cancel()
  }) } finally { compilerActive = false }
  const flash = elfToFlash(elf, boardId === 'nano' ? 30720 : 32256)
  const hex = flashToHex(flash)
  const url = URL.createObjectURL(new Blob([hex], { type: 'text/plain' }))
  const { installed: _installed, ...target } = board
  return {
    buildId: crypto.randomUUID(), cached: false, board: target,
    summary: [`Compiled ${flash.length} bytes of application flash on this device.`], log: 'Built using the local LLVM AVR compiler. Review and test on hardware.',
    skipped: files.filter((file) => !sources.includes(file)).map((file) => file.filename),
    download: { filename: 'firmware.hex', size: hex.length, url }, images: [{ address: 0, size: flash.length, data: btoa(String.fromCharCode(...flash)) }],
  }
}
