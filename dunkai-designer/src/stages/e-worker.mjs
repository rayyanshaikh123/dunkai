import { buildOutputs } from './e-outputs.mjs'
import { Console } from 'node:console'
import { writeFile, rename } from 'node:fs/promises'
import path from 'node:path'

// Compiler diagnostics belong on stderr; stdout is the NDJSON event protocol.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr })

const workdir = process.argv[2]
if (!workdir) throw new Error('Stage E needs a workdir')
const result = await buildOutputs(workdir, {})
const summary = { ev: 'sandbox_result', outDir: result.outDir, stats: result.stats }
// Pipes can lose Node's completion output in the hosted Linux sandbox. Commit
// the result atomically after all outputs are finished; the parent removes any
// previous manifest before each run and verifies it against circuit.json.
const manifest = path.join(workdir, '.sandbox-result.json')
const temporary = `${manifest}.${process.pid}.tmp`
await writeFile(temporary, JSON.stringify(summary), { mode: 0o600 })
await rename(temporary, manifest)
process.stdout.write(JSON.stringify(summary) + '\n')
