/** Decode bounded ELF32 load segments into ATmega328P application flash.
 * Bootloader space is excluded by the target's flashLimit. */
export function elfToFlash(bytes: Uint8Array, flashLimit = 32256): Uint8Array {
  if (bytes.length < 52) throw new Error('Compiler returned a truncated ELF')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, false) !== 0x7f454c46 || bytes[4] !== 1 || bytes[5] !== 1 || view.getUint16(18, true) !== 83) throw new Error('Compiler returned an invalid AVR ELF32')
  const offset = view.getUint32(28, true), stride = view.getUint16(42, true), count = view.getUint16(44, true)
  if (stride < 32 || count > 64 || offset + stride * count > bytes.length) throw new Error('Invalid ELF segment table')
  const flash = new Uint8Array(flashLimit).fill(255)
  let end = 0
  for (let i = 0; i < count; i += 1) {
    const cursor = offset + stride * i
    if (view.getUint32(cursor, true) !== 1) continue
    const source = view.getUint32(cursor + 4, true), address = view.getUint32(cursor + 12, true), size = view.getUint32(cursor + 16, true)
    if (address >= 0x800000 || !size) continue
    if (source + size > bytes.length || address + size > flashLimit) throw new Error('Firmware exceeds application flash or contains an invalid segment')
    flash.set(bytes.subarray(source, source + size), address)
    end = Math.max(end, address + size)
  }
  if (!end) throw new Error('Firmware ELF has no application flash segments')
  return flash.slice(0, end)
}

export function flashToHex(bytes: Uint8Array): string {
  const lines: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const data = bytes.slice(offset, offset + 16)
    const record = [data.length, offset >> 8, offset & 255, 0, ...data]
    record.push((-record.reduce((sum, value) => sum + value, 0)) & 255)
    lines.push(':' + record.map((value) => value.toString(16).padStart(2, '0').toUpperCase()).join(''))
  }
  return lines.join('\n') + '\n:00000001FF\n'
}
