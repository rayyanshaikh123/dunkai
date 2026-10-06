import { z } from 'zod'

const pin = z.string().regex(/^pin[1-9][0-9]{0,2}$/)
const coordinate = z.number().finite().min(-100).max(100)
const dimension = z.number().finite().positive().max(100)
const common = { pin, x: coordinate, y: coordinate }
export const resolvedPartSchema = z.object({
  partNumber: z.string().min(1).max(120),
  package: z.string().min(1).max(120),
  lcsc: z.string().regex(/^C[1-9][0-9]{0,9}$/),
  manufacturer: z.string().max(120),
  source: z.literal('easyeda'),
  fetchedAt: z.string().datetime(),
  pinLabels: z.record(pin, z.array(z.string().min(1).max(120)).min(1).max(16)),
  pads: z.array(z.union([
    z.object({ ...common, kind: z.literal('smt'), shape: z.enum(['rect', 'circle', 'pill']), width: dimension, height: dimension, radius: z.number().finite().nonnegative().max(50).optional() }),
    z.object({ ...common, kind: z.literal('hole'), holeDiameter: dimension, outerDiameter: dimension }),
  ])).min(1).max(256),
  width: dimension,
  height: dimension,
})
export type ResolvedPart = z.infer<typeof resolvedPartSchema>

export function validateResolvedPart(raw: unknown): ResolvedPart {
  const part = resolvedPartSchema.parse(raw)
  const pins = Object.keys(part.pinLabels)
  if (!pins.length || pins.length > 256) throw new Error('Catalogue pin count is invalid')
  const padPins = new Set(part.pads.map((pad) => pad.pin))
  if (pins.some((key) => !padPins.has(key)) || [...padPins].some((key) => !part.pinLabels[key])) {
    throw new Error('Catalogue symbol pins do not match the footprint pads')
  }
  if (part.pads.some((pad) => pad.kind === 'hole' && pad.holeDiameter >= pad.outerDiameter)) {
    throw new Error('Catalogue hole is larger than its copper pad')
  }
  return part
}
