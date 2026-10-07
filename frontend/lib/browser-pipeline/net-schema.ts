import { z } from 'zod'

const short = z.string().trim().min(1).max(240)
const ref = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/)
const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((value) => value === null || value === '' ? undefined : value, schema.optional())
const explicitNet = z.object({ name: ref, connections: z.array(z.string().min(3).max(100)).min(2).max(64) })
const memberNet = z.object({
  name: ref, interface: optional(short), net_class: optional(z.string().max(32)),
  members: z.array(z.object({ ref_id: ref, role: short, pin: optional(z.string().max(80)) })).min(2).max(32),
})
const interfaces = ['Power', 'I2C', 'SPI', 'UART', 'GPIO', 'ADC', 'PWM', 'USB', 'CAN', 'OneWire', 'I2S', 'SDIO']
const canonicalInterface = (value: string) => interfaces.find((name) => name.toUpperCase() === value.toUpperCase()) || value
const intrinsicInterfaces: Record<string, string> = { SUPPLY: 'Power', GROUND: 'Power', GPIO: 'GPIO', PWM: 'PWM', ANALOG_IN: 'ADC' }
const prefixedRole = /^(Power|I2C|SPI|UART|GPIO|ADC|PWM|USB|CAN|OneWire|I2S|SDIO)[\s:_]+(.+)$/i

/** Choose the populated representation before validation. Only recognized
 * interface/role spellings are normalized; catalogue pin resolution remains
 * mandatory, and missing or conflicting connectivity is never invented. */
export const netSchema = z.unknown().transform((raw, context) => {
  const fail = (message: string, path: (string | number)[] = []) => {
    context.addIssue({ code: 'custom', message, path })
    return z.NEVER
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('Net must be an object')
  const net = raw as Record<string, unknown>
  for (const field of ['connections', 'members']) {
    if (net[field] !== undefined && !Array.isArray(net[field])) return fail(`${field} must be an array`, [field])
  }
  const hasConnections = Array.isArray(net.connections) && net.connections.length > 0
  const hasMembers = Array.isArray(net.members) && net.members.length > 0
  if (hasConnections && hasMembers) return fail('Use explicit connections or role members, not both')
  if (!hasMembers) {
    const parsed = explicitNet.safeParse(raw)
    if (!parsed.success) {
      parsed.error.issues.forEach((issue) => context.addIssue(issue))
      return z.NEVER
    }
    return parsed.data
  }
  const parsed = memberNet.safeParse(raw)
  if (!parsed.success) {
    parsed.error.issues.forEach((issue) => context.addIssue(issue))
    return z.NEVER
  }
  const hints = new Set<string>()
  const members = parsed.data.members.map((member) => {
    const prefix = prefixedRole.exec(member.role)
    if (prefix) hints.add(canonicalInterface(prefix[1]))
    const role = (prefix ? prefix[2] : member.role).trim().toUpperCase()
    return { ...member, role }
  })
  const declared = parsed.data.interface && canonicalInterface(parsed.data.interface)
  if (hints.size > 1 || declared && [...hints].some((hint) => hint !== declared)) {
    return fail('Net members specify conflicting interfaces', ['interface'])
  }
  // Standalone GPIO/PWM/power roles are unambiguous. CLOCK/DATA/SIGNAL alone
  // are shared by multiple protocols and require a declared interface.
  if (!declared && !hints.size) {
    for (const member of members) {
      if (!member.pin && intrinsicInterfaces[member.role]) hints.add(intrinsicInterfaces[member.role])
    }
  }
  const resolved = declared || (hints.size === 1 ? [...hints][0] : undefined)
  if (!resolved) return fail('Role-based net needs an interface such as I2C, GPIO or PWM; it cannot be inferred unambiguously', ['interface'])
  return { ...parsed.data, interface: resolved, members }
})
