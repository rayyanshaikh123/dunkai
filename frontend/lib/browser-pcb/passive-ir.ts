import { validateResolvedPart, type ResolvedPart } from './catalogue-types.ts'

const REF = /^[A-Za-z][A-Za-z0-9_]{0,31}$/
const FOOTPRINTS = new Set(['0402', '0603', '0805', '1206'])
const NE555_PINS = { pin1: 'GND', pin2: 'TRIG', pin3: 'OUT', pin4: 'RESET', pin5: 'CONT', pin6: 'THRES', pin7: 'DISCH', pin8: 'VCC' }
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const q = (value: string) => JSON.stringify(value)
const tokens = (labels: string[]) => labels.flatMap((label) => [label.toUpperCase(), ...label.toUpperCase().split(/[\/_,()#\s]+/).filter(Boolean)])
const POWER = /^(VCC|VDD|VDDIO|VDDA|AVCC|AVDD|DVDD|VIN|VS|3V3|5V)\d*$/
const GROUND = /^(GND|VSS|AGND|DGND|PGND|VSSA)\d*$/
const GPIO = /^(GPIO\d+|IO\d+|P[A-K]\d+|D\d+|PIO\d+)$/
const roles: Record<string, RegExp> = {
  'I2C:CLOCK': /^(SCL\d*|I2C\d*SCL)$/,
  'I2C:DATA': /^(SDA\d*|I2C\d*SDA)$/,
  'SPI:CLOCK': /^(SCK\d*|SCLK\d*|SPC|SPI\d*SCK)$/,
  'SPI:MOSI': /^(MOSI\d*|COPI|SDI|DIN|SI)$/,
  'SPI:MISO': /^(MISO\d*|CIPO|SDO|DOUT|SO)$/,
  'SPI:CHIP_SELECT': /^(N?CS\d*|CS[BN]|N?SS\d*)$/,
  'UART:TX': /^(U?\d*TXD?\d*|UART\d*TXD?)$/,
  'UART:RX': /^(U?\d*RXD?\d*|UART\d*RXD?)$/,
  'USB:DP': /^(D\+|DP|USB\d*DP|UDP|DPLUS)$/,
  'USB:DM': /^(D-|DM|USB\d*DM|UDM|DMINUS|DN)$/,
  'USB:VBUS': /^(VBUS|VUSB)$/,
  'CAN:CAN_H': /^(CANH|CAN_H)$/,
  'CAN:CAN_L': /^(CANL|CAN_L)$/,
  'OneWire:DATA': /^(DQ|OW|ONEWIRE)$/,
  'I2S:BIT_CLOCK': /^(BCLK|BCK|SCK)$/,
  'I2S:WORD_CLOCK': /^(WS|LRCLK|LRCK)$/,
  'I2S:DATA': /^(SD|DIN|DOUT|SDIN|SDOUT)$/,
  'SDIO:CLOCK': /^(CLK|SDCLK)$/,
  'SDIO:CMD': /^(CMD|SDCMD)$/,
  'SDIO:DATA': /^(DAT0|DATA0|D0)$/,
}

type Part = { ref: string; kind: 'resistor' | 'capacitor' | 'chip'; value?: string; footprint?: string; mpn?: string; labels: Record<string, string[]>; resolved?: ResolvedPart; width: number; height: number }
export type CompiledBrowserBoard = { code: string; componentCount: number; netCount: number; assignments: Record<string, Record<string, string>> }

/** Source is emitted only from validated identities, numbered pads and bounded
 * geometry. Schema 2.0 roles resolve against actual catalogue labels. */
export function compileBrowserIr(raw: unknown): CompiledBrowserBoard {
  if (!record(raw)) throw new Error('PCB IR must be an object')
  const components = raw.components, nets = raw.nets
  if (!Array.isArray(components) || components.length < 2 || components.length > 32) throw new Error('Browser boards support 2–32 components')
  if (!Array.isArray(nets) || nets.length < 1 || nets.length > 256) throw new Error('Browser boards need 1–256 nets')
  const outline = record(raw.constraints) && record(raw.constraints.board_outline) ? raw.constraints.board_outline : null
  const width = outline?.width_mm, height = outline?.height_mm
  if (typeof width !== 'number' || !Number.isFinite(width) || width < 20 || width > 200 || typeof height !== 'number' || !Number.isFinite(height) || height < 20 || height > 200) throw new Error('Board width and height must each be 20–200 mm')
  const byRef = new Map<string, Part>()
  for (const input of components) {
    if (!record(input) || typeof input.ref_id !== 'string' || !REF.test(input.ref_id)) throw new Error('Every component needs a simple reference such as R1 or C2')
    const ref = input.ref_id
    if (byRef.has(ref)) throw new Error(`Duplicate component ${ref}`)
    if (input.part_class === 'resistor' || input.part_class === 'capacitor') {
      if (typeof input.value !== 'string' || !/^[0-9][0-9A-Za-z.µμΩ]{0,20}$/.test(input.value)) throw new Error(`${ref}: value is missing or invalid`)
      if (typeof input.package !== 'string' || !FOOTPRINTS.has(input.package)) throw new Error(`${ref}: unsupported passive footprint`)
      byRef.set(ref, { ref, kind: input.part_class, value: input.value, footprint: input.package, labels: { pin1: ['pin1'], pin2: ['pin2'] }, width: 3, height: 2 })
    } else if (input.part_class === 'timer' && !input.resolved) {
      if (input.part_number !== 'NE555P' || input.package !== 'DIP8') throw new Error(`${ref}: timer part and package are not in the verified browser catalogue`)
      byRef.set(ref, { ref, kind: 'chip', mpn: 'NE555P', footprint: 'dip8', labels: Object.fromEntries(Object.entries(NE555_PINS).map(([pin, label]) => [pin, [label]])), width: 12, height: 10 })
    } else {
      if (!input.resolved) throw new Error(`${ref}: symbol and footprint catalogue data are missing`)
      const part = validateResolvedPart(input.resolved)
      if (input.part_number !== part.partNumber) throw new Error(`${ref}: resolved identity differs from the requested manufacturer part`)
      byRef.set(ref, { ref, kind: 'chip', mpn: part.partNumber, labels: part.pinLabels, resolved: part, width: part.width, height: part.height })
    }
  }
  if ([...byRef.values()].reduce((count, part) => count + Object.keys(part.labels).length, 0) > 512) throw new Error('The design exceeds the 512-pin browser budget')
  const used = new Set<string>(), names = new Set<string>()
  const assignments: CompiledBrowserBoard['assignments'] = {}
  const parsedNets: Array<{ name: string; pins: string[] }> = []
  const exactPin = (part: Part, token: string): string => {
    const numbered = /^(?:PIN)?([1-9][0-9]{0,2})$/i.exec(token)
    const pin = numbered ? `pin${numbered[1]}` : Object.keys(part.labels).find((key) => tokens(part.labels[key]).includes(token.toUpperCase()))
    if (!pin || !part.labels[pin]) throw new Error(`unknown or invalid physical pin ${part.ref}.${token}`)
    return pin
  }
  const connect = (part: Part, pin: string, name: string, pins: string[]) => {
    const id = `${part.ref}.${pin}`
    if (used.has(id)) throw new Error(`${id} is connected more than once`)
    used.add(id)
    ;(assignments[part.ref] ||= {})[pin] = name
    pins.push(id)
  }
  const ordered = [...nets].sort((a, b) => Number(record(b) && b.interface === 'Power') - Number(record(a) && a.interface === 'Power'))
  for (const input of ordered) {
    if (!record(input) || typeof input.name !== 'string' || !REF.test(input.name)) throw new Error('Every net needs a simple unique name')
    if (names.has(input.name)) throw new Error(`Duplicate net ${input.name}`)
    names.add(input.name)
    const pins: string[] = []
    if (Array.isArray(input.connections)) {
      if (input.connections.length < 2 || input.connections.length > 64) throw new Error(`${input.name}: a net needs 2–64 connections`)
      for (const entry of input.connections) {
        if (typeof entry !== 'string') throw new Error('Connection must be a string')
        const dot = entry.indexOf('.')
        const part = byRef.get(entry.slice(0, dot))
        if (dot < 1 || !part) throw new Error(`${input.name}: unknown or invalid physical pin ${entry}`)
        connect(part, exactPin(part, entry.slice(dot + 1)), input.name, pins)
      }
    } else if (Array.isArray(input.members)) {
      if (input.members.length < 2 || input.members.length > 32 || typeof input.interface !== 'string') throw new Error(`${input.name}: invalid schema 2.0 net`)
      for (const member of input.members) {
        if (!record(member) || typeof member.ref_id !== 'string' || typeof member.role !== 'string') throw new Error('Invalid net member')
        const part = byRef.get(member.ref_id)
        if (!part) throw new Error(`${input.name}: unknown component ${member.ref_id}`)
        if (typeof member.pin === 'string') { connect(part, exactPin(part, member.pin), input.name, pins); continue }
        const role = member.role.toUpperCase()
        const matcher = role === 'SUPPLY' ? POWER : role === 'GROUND' ? GROUND : roles[`${input.interface}:${role}`] ||
          (role === 'ANALOG_IN' ? /^(ADC\d*|AIN\d*|A\d+)$/ : role === 'PWM' ? /^(PWM\d*|OC\d+[AB]?)$/ : ['GPIO', 'SIGNAL', 'INPUT', 'OUTPUT'].includes(role) && input.interface === 'GPIO' ? GPIO : null)
        const candidates = matcher ? Object.keys(part.labels).filter((pin) => !used.has(`${part.ref}.${pin}`) && tokens(part.labels[pin]).some((label) => matcher.test(label))).sort((a,b) => Number(a.slice(3)) - Number(b.slice(3))) : []
        if (!candidates.length) throw new Error(`${part.ref}: no available catalogue pin for ${input.interface} ${role}; choose an explicit verified pin`)
        const selected = role === 'SUPPLY' || role === 'GROUND' ? candidates : candidates.slice(0, 1)
        for (const pin of selected) connect(part, pin, input.name, pins)
      }
    } else throw new Error(`${input.name}: net has no connections or members`)
    if (pins.length < 2) throw new Error(`${input.name}: net has fewer than two physical pins`)
    parsedNets.push({ name: input.name, pins })
  }
  let x = 3, y = 3, rowHeight = 0
  const elements = [...byRef.values()].map((part) => {
    if (x + part.width + 3 > width) { x = 3; y += rowHeight + 3; rowHeight = 0 }
    if (y + part.height + 3 > height) throw new Error('Components do not fit this outline; increase board dimensions')
    const atX = Number((x + part.width / 2 - width / 2).toFixed(4))
    const atY = Number((height / 2 - y - part.height / 2).toFixed(4))
    x += part.width + 3; rowHeight = Math.max(rowHeight, part.height)
    const position = `pcbX={${atX}} pcbY={${atY}}`
    if (part.kind !== 'chip') return `<${part.kind} name=${q(part.ref)} ${part.kind === 'resistor' ? 'resistance' : 'capacitance'}=${q(part.value!)} footprint=${q(part.footprint!)} ${position} />`
    let footprint = `footprint=${q(part.footprint || '')}`
    if (part.resolved) {
      const pads = part.resolved.pads.map((pad) => pad.kind === 'smt'
        ? `<smtpad portHints={${JSON.stringify([pad.pin])}} pcbX={${pad.x}} pcbY={${pad.y}} width={${pad.width}} height={${pad.height}} shape=${q(pad.shape)} ${pad.radius == null ? '' : `radius={${pad.radius}}`} />`
        : `<platedhole portHints={${JSON.stringify([pad.pin])}} pcbX={${pad.x}} pcbY={${pad.y}} shape="circle" holeDiameter={${pad.holeDiameter}} outerDiameter={${pad.outerDiameter}} />`).join('')
      footprint = `footprint={<footprint>${pads}</footprint>}`
    }
    const labels = part.mpn === 'NE555P' && !part.resolved ? NE555_PINS : part.labels
    return `<chip name=${q(part.ref)} manufacturerPartNumber=${q(part.mpn!)} pinLabels={${JSON.stringify(labels)}} ${footprint} ${position} />`
  })
  const traces = parsedNets.flatMap((net) => net.pins.slice(1).map((pin) => `<trace from=${q(`.${net.pins[0].replace('.', ' > .')}`)} to=${q(`.${pin.replace('.', ' > .')}`)} />`))
  return { code: `export default () => <board width=${q(`${width}mm`)} height=${q(`${height}mm`)}>${elements.join('')}${traces.join('')}</board>`, componentCount: byRef.size, netCount: parsedNets.length, assignments }
}
export const compilePassiveIr = compileBrowserIr
