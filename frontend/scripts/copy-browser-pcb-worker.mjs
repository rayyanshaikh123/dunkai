import { copyFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Serve the pinned evaluator from our own origin. The runtime must never load
// executable worker code from a mutable third-party CDN.
const source = fileURLToPath(import.meta.resolve('@tscircuit/eval/worker-entrypoint'))
const destination = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'vendor', 'tscircuit-eval-worker.js')
mkdirSync(dirname(destination), { recursive: true })
copyFileSync(source, destination)
console.log('Prepared browser PCB worker')
