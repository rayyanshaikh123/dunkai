import { buildOutputs } from './e-outputs.mjs'
import { Console } from 'node:console'

// Compiler diagnostics belong on stderr; stdout is the NDJSON event protocol.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr })

const workdir = process.argv[2]
if (!workdir) throw new Error('Stage E needs a workdir')
const result = await buildOutputs(workdir, {})
process.stdout.write(JSON.stringify({ ev: 'sandbox_result', outDir: result.outDir, stats: result.stats }) + '\n')
