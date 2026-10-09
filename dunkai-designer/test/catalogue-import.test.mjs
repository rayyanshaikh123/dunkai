import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { attempt } from '../src/stages/b-resolve.mjs'

test('parallel imports retain each part identity when CLI stdout is lost, including repeated imports', async () => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'dunkai-catalogue-test-'))
  const directories = []
  const importRunner = async (query, cwd) => {
    directories.push(cwd)
    await mkdir(path.join(cwd, 'imports'), { recursive: true })
    const source = `const pinLabels = {\n  pin1: ["VDD"],\n  pin2: ["GND"],\n  pin3: ["SDA"],\n  pin4: ["SCL"],\n  pin5: ["A0"],\n  pin6: ["A1"]\n} as const\nexport const ${query} = () => <chip manufacturerPartNumber="${query}" footprint="sot23_6" pinLabels={pinLabels} />`
    await writeFile(path.join(cwd, 'imports', query + '.tsx'), source)
    return { output: '', code: 0 }
  }
  try {
    const components = ['ALPHA123', 'BRAVO123'].map((part_number, i) => ({ ref_id: 'U' + i, part_number, package: 'SOT-23-6', part_class: 'sensor' }))
    const results = await Promise.all(components.map(c => attempt(c.part_number, c, work, 1, { importRunner })))
    assert.ok(results.every(r => r.ok), JSON.stringify(results.map(r => r.reason)))
    assert.deepEqual(results.map(r => r.chip.manufacturerPartNumber), ['ALPHA123', 'BRAVO123'])
    assert.notEqual(directories[0], directories[1])
    for (const c of components) assert.match(await readFile(path.join(work, 'imports', c.part_number + '.tsx'), 'utf8'), new RegExp(c.part_number))
    assert.equal((await attempt('ALPHA123', components[0], work, 1, { importRunner })).ok, true)
    assert.notEqual(directories[0], directories[2])
  } finally { await rm(work, { recursive: true, force: true }) }
})
