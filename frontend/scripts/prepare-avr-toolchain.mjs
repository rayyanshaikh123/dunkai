import { readFile, writeFile, mkdir, copyFile, cp } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'scripts/avr-toolchain-manifest.json'), 'utf8'))
const destination = join(root, 'public/vendor/avr')
await mkdir(destination, { recursive: true })
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
await Promise.all(Object.entries(manifest.assets).map(async ([name, asset]) => {
  const path = join(destination, asset.file)
  try {
    const bytes = await readFile(path)
    const original = name.endsWith('.wasm') ? gunzipSync(bytes) : bytes
    if (hash(original) === asset.sha256) return
  } catch {}
  const url = `https://raw.githubusercontent.com/${manifest.repository}/${manifest.commit}/toolchain/${name}`
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`Toolchain download failed: ${name} HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length !== asset.size || hash(bytes) !== asset.sha256) throw new Error(`Toolchain integrity check failed: ${name}`)
  await writeFile(path, name.endsWith('.wasm') ? gzipSync(bytes, { level: 9 }) : bytes)
}))
await copyFile(join(root, 'lib/firmware/vendor/avr-worker.js'), join(destination, 'worker.js'))
const libraries = JSON.parse(await readFile(join(root, 'lib/firmware/vendor/arduino-sources.json'), 'utf8'))
for (const [name, source] of Object.entries(libraries.files)) {
  if (hash(source) !== libraries.hashes[name]) throw new Error(`Arduino library integrity check failed: ${name}`)
}
await writeFile(join(destination, 'libraries.json'), JSON.stringify(libraries))
await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2))
await cp(join(root, 'lib/firmware/vendor/licenses'), join(destination, 'licenses'), { recursive: true })
console.log('Prepared pinned browser AVR compiler and linker')
