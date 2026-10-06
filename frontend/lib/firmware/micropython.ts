import { SerialReader, SerialTimeoutError, writeBytes } from './serial-reader.ts'

/** Save reviewed source through MicroPython's raw REPL. Files are written
 * without executing their content or automatically restarting the device. */
export async function saveMicroPythonFiles(port: SerialPort, files: Array<{ filename: string; code: string }>, progress: (message: string) => void, signal?: AbortSignal) {
  const sources = files.filter((file) => file.filename.endsWith('.py'))
  if (!sources.length || sources.length > 8 || sources.some((file) => !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}\.py$/.test(file.filename)) || sources.reduce((sum,file)=>sum+file.code.length,0)>100000) throw new Error('Invalid MicroPython source files')
  if (new Set(sources.map((file) => file.filename)).size !== sources.length) throw new Error('Duplicate MicroPython filenames')
  const check = () => { if (signal?.aborted) throw new Error('Upload cancelled') }
  check()
  await port.open({ baudRate: 115200 })
  const reader = new SerialReader(port)
  const encoder = new TextEncoder(), decoder = new TextDecoder()
  const until = async (suffix: string, timeout = 5000) => {
    const deadline = Date.now() + timeout
    let output = ''
    while (!output.endsWith(suffix)) {
      check()
      const remaining = deadline - Date.now()
      if (remaining <= 0 || output.length > 16000) throw new Error('MicroPython did not respond; check its firmware and serial connection')
      try { output += decoder.decode(await reader.read(1, Math.min(remaining, 1000))) }
      catch (error) { if (!(error instanceof SerialTimeoutError)) throw error }
    }
    return output.slice(0, -suffix.length)
  }
  const execute = async (command: string) => {
    check()
    await writeBytes(port, encoder.encode(command))
    await writeBytes(port, Uint8Array.of(4))
    if (decoder.decode(await reader.read(2, 5000)) !== 'OK') throw new Error('MicroPython rejected the file command')
    await until('\x04')
    const error = await until('\x04')
    await until('>')
    if (error.trim()) throw new Error(error.trim())
  }
  try {
    await writeBytes(port, Uint8Array.of(3, 3, 1))
    await until('raw REPL; CTRL-B to exit\r\n>')
    for (const file of sources) {
      progress(`Saving ${file.filename}…`)
      const temporary = `${file.filename}.dunk.tmp`
      await execute(`import ubinascii, os\n_dunk_f=open(${JSON.stringify(temporary)},'wb')`)
      const bytes = encoder.encode(file.code)
      for (let offset=0;offset<bytes.length;offset+=192) {
        const base64=btoa(String.fromCharCode(...bytes.slice(offset,offset+192)))
        await execute(`_dunk_f.write(ubinascii.a2b_base64('${base64}'))`)
      }
      await execute(`_dunk_f.close()\nos.rename(${JSON.stringify(temporary)},${JSON.stringify(file.filename)})`)
    }
    progress('Source files saved. Review the code before resetting the board to run it.')
  } finally {
    await writeBytes(port, Uint8Array.of(2)).catch(()=>{})
    await reader.close()
    await port.close().catch(()=>{})
  }
}
