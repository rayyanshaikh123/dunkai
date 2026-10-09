import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildOutputs } from '../stages/e-outputs.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const worker = path.join(root, 'src', 'stages', 'e-worker.mjs')

/** Blank lines from compiler dependencies are not protocol events. */
export function parseEvaluatorOutput(stdout, onStage = () => {}) {
  let summary
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) }
    catch { throw new Error('Isolated board evaluator returned incomplete or invalid JSON') }
    if (event?.ev === 'sandbox_result') summary = event
    else if (event?.ev === 'stage') onStage(event)
    else throw new Error('Unexpected output from isolated board evaluator')
  }
  if (!summary) throw new Error('Isolated board evaluator returned no result')
  return summary
}

/** Evaluate generated TSX under a checked, fail-closed Linux sandbox. */
export async function buildOutputsIsolated(workdir, opts = {}) {
  if (process.env.BOARD_SANDBOX_REQUIRED !== 'true') return buildOutputs(workdir, opts)
  const sandbox = [
    '--die-with-parent', '--unshare-all', '--new-session',
    '--ro-bind', '/usr', '/usr', '--ro-bind-try', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
    // Gradio Spaces installs Node under the unprivileged app user's directory.
    // Bind only its executable when it is outside the already mounted /usr.
    ...(!process.execPath.startsWith('/usr/') ? ['--ro-bind', process.execPath, process.execPath] : []),
    '--dir', '/srv', '--ro-bind', root, root,
    '--dir', '/data', '--dir', '/data/boards', '--dir', workdir, '--bind', workdir, workdir,
    '--tmpfs', '/tmp', '--proc', '/proc', '--dev', '/dev',
    '--chdir', root, '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', '--setenv', 'HOME', '/tmp',
    process.execPath, '--max-old-space-size=1024', worker, workdir,
  ]
  const backend = process.env.BOARD_SANDBOX_BACKEND || 'bubblewrap'
  if (!['bubblewrap', 'landlock-seccomp'].includes(backend)) throw new Error('Unknown PCB sandbox backend')
  const command = backend === 'landlock-seccomp' ? process.env.BOARD_SANDBOX_PYTHON : 'bwrap'
  if (!command) throw new Error('PCB sandbox launcher is not configured')
  const arguments_ = backend === 'landlock-seccomp'
    ? [path.join(root, 'sandbox', 'launch.py'), 'run', process.execPath, root, workdir,
       worker, workdir]
    : sandbox
  const child = spawnSync(command, arguments_, {
    cwd: root,
    env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    encoding: 'utf8', timeout: 300_000, maxBuffer: 2 * 1024 * 1024,
  })
  if (child.error || child.status !== 0) {
    throw new Error(`Isolated board evaluation failed: ${child.error?.message || child.stderr?.slice(-500) || child.status}`)
  }
  let summary
  try { summary = parseEvaluatorOutput(child.stdout, event => process.stdout.write(JSON.stringify(event) + '\n')) }
  catch (error) {
    throw new Error(`${error.message} (exit ${child.status}, stdout ${child.stdout.length} bytes). ${child.stderr?.slice(-1000) || 'No compiler diagnostics.'}`)
  }
  if (summary.outDir !== path.join(workdir, 'dist')) throw new Error('Isolated board evaluator returned an invalid output directory')
  let circuitJson
  try { circuitJson = JSON.parse(await readFile(path.join(workdir, 'dist', 'circuit.json'), 'utf8')) }
  catch { throw new Error('Isolated board evaluator did not produce a complete circuit.json file') }
  if (!Array.isArray(circuitJson) || !circuitJson.length) throw new Error('Isolated board evaluator produced an empty circuit')
  return { circuitJson, outDir: summary.outDir, stats: summary.stats }
}
