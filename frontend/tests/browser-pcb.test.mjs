import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { compilePassiveIr } from '../lib/browser-pcb/passive-ir.ts'
import { resolveEasyEda } from '../lib/browser-pcb/catalogue.ts'

const rawAtmega = JSON.parse(readFileSync(new URL('./fixtures/atmega328p-easyeda.json', import.meta.url))).easyeda_component_details.easyeda_json

const fixture = () => ({
  components: [
    { ref_id: 'R1', part_class: 'resistor', value: '1k', package: '0402' },
    { ref_id: 'R2', part_class: 'resistor', value: '1k', package: '0402' },
  ],
  nets: [{ name: 'SIGNAL', connections: ['R1.2', 'R2.1'] }],
  constraints: { board_outline: { width_mm: 30, height_mm: 20 } },
})

test('compiles a two-pin net without model-written code', () => {
  const result = compilePassiveIr(fixture())
  assert.equal(result.componentCount, 2)
  assert.equal(result.netCount, 1)
  assert.match(result.code, /\.R1 > \.pin2/)
  assert.match(result.code, /\.R2 > \.pin1/)
})

test('rejects unsupported parts instead of guessing pin mappings', () => {
  const input = fixture()
  input.components[0].part_class = 'processing'
  assert.throws(() => compilePassiveIr(input), /catalogue data are missing/)
})

test('rejects reused pins and unknown references', () => {
  const input = fixture()
  input.nets.push({ name: 'OTHER', connections: ['R1.2', 'R2.2'] })
  assert.throws(() => compilePassiveIr(input), /connected more than once/)
  input.nets[1].connections = ['R3.1', 'R2.2']
  assert.throws(() => compilePassiveIr(input), /unknown or invalid physical pin/)
})

test('maps the vetted NE555P physical pinout without model-supplied labels', () => {
  const input = fixture()
  input.components[0] = { ref_id: 'U1', part_class: 'timer', part_number: 'NE555P', package: 'DIP8' }
  input.nets = [{ name: 'VCC', connections: ['U1.VCC', 'R2.1'] }]
  const result = compilePassiveIr(input)
  assert.match(result.code, /manufacturerPartNumber="NE555P"/)
  assert.match(result.code, /"pin8":"VCC"/)
  assert.match(result.code, /\.U1 > \.pin8/)
})

test('rejects unknown timer variants and invalid passive pins', () => {
  const input = fixture()
  input.components[0] = { ref_id: 'U1', part_class: 'timer', part_number: 'NE555D', package: 'DIP8' }
  assert.throws(() => compilePassiveIr(input), /not in the verified browser catalogue/)
  input.components[0].part_number = 'NE555P'
  input.nets[0].connections = ['U1.8', 'R2.3']
  assert.throws(() => compilePassiveIr(input), /invalid physical pin/)
  input.nets[0].connections = ['U1.VCCA', 'R2.1']
  assert.throws(() => compilePassiveIr(input), /invalid physical pin/)
})

test('rejects source injection in references and values', () => {
  const input = fixture()
  input.components[0].ref_id = 'R1" onClick="x'
  assert.throws(() => compilePassiveIr(input), /simple reference/)
  input.components[0].ref_id = 'R1'
  input.components[0].value = '1k" /><script>'
  assert.throws(() => compilePassiveIr(input), /invalid/)
})

test('resolves a real 32-pin catalogue symbol and schema 2.0 GPIO role', () => {
  const resolved = resolveEasyEda(rawAtmega, 'ATMEGA328P-AU', 'TQFP-32', 'C14877')
  assert.equal(Object.keys(resolved.pinLabels).length, 32)
  assert.equal(resolved.pads.length, 32)
  assert.ok(resolved.pinLabels.pin27.includes('SDA'))
  const input = fixture()
  input.schema_version = '2.0'
  input.components[0] = { ref_id: 'U1', part_class: 'processing', part_number: 'ATMEGA328P-AU', package: 'TQFP-32', resolved }
  input.constraints.board_outline = {width_mm:60,height_mm:40}
  input.nets = [{name:'IO',interface:'GPIO',members:[{ref_id:'U1',role:'GPIO'},{ref_id:'R2',role:'SIGNAL',pin:'1'}]}]
  const compiled = compilePassiveIr(input)
  assert.match(compiled.code, /<smtpad/)
  assert.match(compiled.code, /ATMEGA328P-AU/)
  assert.equal(compiled.assignments.U1.pin1, 'IO')
})

test('rejects wrong catalogue identities, mismatched pads, and unsupported schema 2.0 roles', () => {
  assert.throws(() => resolveEasyEda(rawAtmega, 'ATMEGA328P-PU', 'TQFP-32', 'C14877'), /identity/)
  const resolved = resolveEasyEda(rawAtmega, 'ATMEGA328P-AU', 'TQFP-32', 'C14877')
  const input = fixture()
  input.components[0] = {ref_id:'U1',part_class:'processing',part_number:resolved.partNumber,package:'TQFP-32',resolved}
  input.constraints.board_outline = {width_mm:60,height_mm:40}
  input.nets = [{name:'IO',interface:'Imaginary',members:[{ref_id:'U1',role:'CLOCK'},{ref_id:'R2',role:'SIGNAL',pin:'1'}]}]
  assert.throws(() => compilePassiveIr(input), /no available catalogue pin/)
  resolved.pads.pop()
  assert.throws(() => compilePassiveIr(input), /symbol pins do not match/)
})
