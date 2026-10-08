export class SerialTimeoutError extends Error {}

/** Buffers everything a serial port sends so a protocol can read exact byte counts with a timeout. */
export class SerialReader {
  private buffer: number[] = []
  private notify: (() => void) | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private pumping: Promise<void>

  constructor(port: SerialPort) {
    if (!port.readable) throw new Error('Serial port is not open')
    this.reader = port.readable.getReader()
    this.pumping = this.pump()
  }

  private async pump() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read()
        if (done) break
        if (value) {
          for (const b of value) this.buffer.push(b)
          this.notify?.()
        }
      }
    } catch {
      // Port closed or device unplugged; pending reads time out.
    }
  }

  async read(count: number, timeoutMs: number): Promise<Uint8Array> {
    const deadline = Date.now() + timeoutMs
    while (this.buffer.length < count) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new SerialTimeoutError(`Timed out waiting for ${count} byte(s) from the board`)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, remaining)
        this.notify = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      this.notify = null
    }
    return Uint8Array.from(this.buffer.splice(0, count))
  }

  drain() {
    this.buffer = []
  }

  async close() {
    await this.reader.cancel().catch(() => {})
    await this.pumping
    this.reader.releaseLock()
  }
}

export async function writeBytes(port: SerialPort, bytes: Uint8Array) {
  if (!port.writable) throw new Error('Serial port is not open')
  const writer = port.writable.getWriter()
  try {
    await writer.write(bytes)
  } finally {
    writer.releaseLock()
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
