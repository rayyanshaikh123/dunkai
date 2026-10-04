import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildOutputs } from '../stages/e-outputs.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const worker = path.join(root, 'src', 'stages', 'e-worker.mjs')

/** Evaluate generated TSX in a separate Linux mount/PID/network namespace. */
export async function buildOutputsIsolated(workdir, opts = {}) {
  if (process.env.BOARD_SANDBOX_REQUIRED !== 'true') return buildOutputs(workdir, opts)
  const sandbox = [
    '--die-with-parent', '--unshare-all', '--new-session',
    '--ro-bind', '/usr', '/usr', '--ro-bind-try', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
    '--dir', '/srv', '--ro-bind', root, root,
    '--dir', '/data', '--dir', '/data/boards', '--dir', workdir, '--bind', workdir, workdir,
    '--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev',
    '--chdir', root, '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', '--setenv', 'HOME', '/tmp',
    '/usr/local/bin/node', '--max-old-space-size=1024', worker, workdir,
  ]
  const child = spawnSync('bwrap', sandbox, {
    cwd: root,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    encoding: 'utf8', timeout: 300_000, maxBuffer: 2 * 1024 * 1024,
  })
  if (child.error || child.status !== 0) {
    throw new Error(`Isolated board evaluation failed: ${child.error?.message || child.stderr?.slice(-500) || child.status}`)
  }
  let summary
  for (const line of child.stdout.trim().split('\n')) {
    const event = JSON.parse(line)
    if (event.ev === 'sandbox_result') summary = event
    else if (event.ev === 'stage') process.stdout.write(JSON.stringify(event) + '\n')
    else throw new Error('Unexpected output from isolated board evaluator')
  }
  if (!summary) throw new Error('Isolated board evaluator returned no result')
  const circuitJson = JSON.parse(await readFile(path.join(workdir, 'dist', 'circuit.json'), 'utf8'))
  return { circuitJson, outDir: summary.outDir, stats: summary.stats }
}
