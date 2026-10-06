import { test } from 'node:test'
import assert from 'node:assert/strict'
import { saveMicroPythonFiles } from '../lib/firmware/micropython.ts'

function device({ delay = 0, error = '', onCommand = () => {} } = {}) {
  let controller
  let command = ''
  const commands = [], encoder = new TextEncoder()
  const send = (text) => controller.enqueue(encoder.encode(text))
  let closed = false
  const port = {
    open: async () => {}, close: async () => { closed = true },
    readable: new ReadableStream({ start(value) { controller = value } }),
    writable: new WritableStream({ async write(bytes) {
      if (bytes.length === 3 && bytes[2] === 1) {
        await new Promise((resolve) => setTimeout(resolve, delay))
        send('raw REPL; CTRL-B to exit\r\n>')
      } else if (bytes.length === 1 && bytes[0] === 4) {
        commands.push(command); onCommand(command); command = ''
        send(`OK\x04${error}\x04>`)
      } else if (!(bytes.length === 1 && bytes[0] === 2)) command += new TextDecoder().decode(bytes)
    } }),
  }
  return { port, commands, get closed() { return closed } }
}

test('writes source as data, renames only after all chunks, and closes the serial port', async () => {
  const source = 'print("do not execute this during upload")\n# unicode: ₹\n' + '#'.repeat(500)
  const board = device()
  await saveMicroPythonFiles(board.port, [{ filename: 'main.py', code: source }], () => {})
  const chunks = board.commands.filter((text) => text.startsWith('_dunk_f.write')).map((text) => Buffer.from(text.match(/'([^']+)'/)[1], 'base64'))
  assert.equal(Buffer.concat(chunks).toString('utf8'), source)
  assert.match(board.commands.at(-1), /os.rename\("main.py.dunk.tmp","main.py"\)/)
  assert.ok(board.commands.every((text) => !text.includes('exec(') && !text.includes('import main')))
  assert.equal(board.closed, true)
})

test('propagates device errors and avoids replacing the destination on cancellation', async () => {
  const broken = device({ error: 'OSError: full' })
  await assert.rejects(saveMicroPythonFiles(broken.port, [{ filename: 'main.py', code: 'pass' }], () => {}), /full/)
  assert.equal(broken.closed, true)
  const abort = new AbortController()
  const board = device({ onCommand: () => abort.abort() })
  await assert.rejects(saveMicroPythonFiles(board.port, [{ filename: 'main.py', code: 'pass' }], () => {}, abort.signal), /cancelled/)
  assert.ok(board.commands.every((text) => !text.includes('os.rename')))
  assert.equal(board.closed, true)
})

test('rejects unsafe paths and duplicate filenames before opening a port', async () => {
  for (const files of [[{ filename: '../main.py', code: 'pass' }], [{ filename: 'main.py', code: 'pass' }, { filename: 'main.py', code: 'pass' }]]) {
    await assert.rejects(saveMicroPythonFiles({ open: () => { throw new Error('must not open') } }, files, () => {}), /Invalid|Duplicate/)
  }
})
