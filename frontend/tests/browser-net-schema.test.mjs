import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { netSchema } from '../lib/browser-pipeline/net-schema.ts'
import { compileBrowserIr } from '../lib/browser-pcb/passive-ir.ts'
import { resolveEasyEda } from '../lib/browser-pcb/catalogue.ts'

const memberNet = (role, overrides = {}) => ({
  name: 'SIGNAL', interface: null, net_class: null, connections: [],
  members: [{ ref_id: 'U1', role, pin: null }, { ref_id: 'U2', role, pin: null }], ...overrides,
})

test('normalizes the reported null-interface I2C, PWM and GPIO wire formats', () => {
  for (const [input, expectedInterface, expectedRole] of [
    ['I2C CLOCK', 'I2C', 'CLOCK'], ['I2C DATA', 'I2C', 'DATA'], ['PWM', 'PWM', 'PWM'], ['GPIO', 'GPIO', 'GPIO'],
  ]) {
    const parsed = netSchema.parse(memberNet(input))
    assert.equal(parsed.interface, expectedInterface)
    assert.equal('connections' in parsed, false)
    assert.equal(parsed.members.length, 2)
    assert.ok(parsed.members.every((member) => member.role === expectedRole && member.pin === undefined))
    assert.deepEqual(parsed.members.map((member) => member.ref_id), ['U1', 'U2'])
  }
})

test('keeps canonical explicit connections and role nets unchanged', () => {
  const explicit = netSchema.parse({ name: 'SIGNAL', interface: null, net_class: null, connections: ['R1.2', 'R2.1'], members: [] })
  assert.deepEqual(explicit, { name: 'SIGNAL', connections: ['R1.2', 'R2.1'] })
  const role = netSchema.parse(memberNet('CLOCK', { interface: 'I2C' }))
  assert.equal(role.interface, 'I2C')
  assert.ok(role.members.every((member) => member.role === 'CLOCK'))
})

test('normalizes known interface spelling while preserving explicit physical pins', () => {
  const parsed = netSchema.parse(memberNet('i2c:clock', { interface: 'i2c', members: [
    { ref_id: 'U1', role: 'i2c:clock', pin: 'SCL' }, { ref_id: 'J1', role: 'SIGNAL', pin: '2' },
  ] }))
  assert.equal(parsed.interface, 'I2C')
  assert.equal(parsed.members[0].role, 'CLOCK')
  assert.equal(parsed.members[0].pin, 'SCL')
  assert.equal(parsed.members[1].pin, '2')
})

test('reports the populated representation and rejects missing or conflicting connectivity', () => {
  const invalid = [
    { input: memberNet('GPIO', { members: [memberNet('GPIO').members[0]] }), path: 'members' },
    { input: memberNet('GPIO', { members: [], connections: ['R1.1'] }), path: 'connections' },
    { input: memberNet('GPIO', { members: [] }), path: 'connections' },
    { input: memberNet('CLOCK'), path: 'interface' },
    { input: memberNet('I2C CLOCK', { interface: 'SPI' }), path: 'interface' },
    { input: memberNet('GPIO', { members: [memberNet('GPIO').members[0], { ref_id: 'U2', role: 'PWM', pin: null }] }), path: 'interface' },
  ]
  for (const { input, path } of invalid) {
    const parsed = netSchema.safeParse(input)
    assert.equal(parsed.success, false)
    assert.equal(parsed.error.issues[0].path[0], path)
  }
  assert.equal(netSchema.safeParse(memberNet('GPIO', { connections: ['R1.1', 'R2.2'] })).success, false)
  assert.equal(netSchema.safeParse(memberNet('GPIO', { connections: 'R1.1' })).success, false)
  assert.equal(netSchema.safeParse(memberNet('I2C CLOCK', { members: [
    { ref_id: 'U1', role: 'I2C CLOCK', pin: null }, { ref_id: 'U2', role: 'SPI CLOCK', pin: null },
  ] })).success, false)
})

test('normalized roles still resolve against real catalogue pins and reject invented pins', () => {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/atmega328p-easyeda.json', import.meta.url))).easyeda_component_details.easyeda_json
  const resolved = resolveEasyEda(raw, 'ATMEGA328P-AU', 'TQFP-32', 'C14877')
  const input = { components: [
    { ref_id: 'U1', part_class: 'processing', part_number: 'ATMEGA328P-AU', package: 'TQFP-32', resolved },
    { ref_id: 'R1', part_class: 'resistor', value: '1k', package: '0603' },
  ], constraints: { board_outline: { width_mm: 60, height_mm: 40 } }, nets: [netSchema.parse(memberNet('GPIO', { members: [
    { ref_id: 'U1', role: 'GPIO', pin: null }, { ref_id: 'R1', role: 'SIGNAL', pin: '1' },
  ] }))] }
  const compiled = compileBrowserIr(input)
  assert.equal(compiled.assignments.U1.pin1, 'SIGNAL')
  assert.equal(compiled.assignments.R1.pin1, 'SIGNAL')
  input.nets[0].members[0].pin = 'NOT_A_REAL_PIN'
  assert.throws(() => compileBrowserIr(input), /unknown or invalid physical pin/)
})
