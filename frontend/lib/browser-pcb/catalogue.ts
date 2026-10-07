import { EasyEdaJsonSchema, convertEasyEdaJsonToCircuitJson } from 'easyeda/browser'
import { validateResolvedPart, type ResolvedPart } from './catalogue-types.ts'
import { readLocal, writeLocal } from '../browser-pipeline/local-storage.ts'
import { fetchCatalogueJson, lookupCatalogueOffer, type CatalogueOffer } from './catalogue-offers.ts'

const key = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, '')
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** Converts catalogue geometry into data. No imported TSX or model source is executed. */
export function resolveEasyEda(raw: unknown, expectedMpn: string, expectedPackage: string, expectedLcsc: string): ResolvedPart {
  const parsed = EasyEdaJsonSchema.parse(raw)
  const mpn = parsed.dataStr.head.c_para['Manufacturer Part'] || parsed.title
  if (key(mpn) !== key(expectedMpn) || parsed.lcsc.number !== expectedLcsc) throw new Error('Catalogue identity does not match the selected component')
  const actualPackage = parsed.dataStr.head.c_para.package || parsed.packageDetail.title
  const requested = key(expectedPackage)
  if (requested && requested !== 'CUSTOM' && !key(actualPackage).startsWith(requested)) throw new Error(`${mpn}: catalogue package differs from ${expectedPackage}`)
  const soup = convertEasyEdaJsonToCircuitJson(parsed, { useModelCdn: false })
  const pinLabels: Record<string, string[]> = {}
  for (const element of soup) {
    if (element.type !== 'source_port' || !element.pin_number) continue
    const pin = `pin${element.pin_number}`
    const original = parsed.dataStr.shape.find((shape) => shape.type === 'PIN' && String(shape.pinNumber) === String(element.pin_number))
    const labels = original?.type === 'PIN' ? original.label.replace(/[()#]/g, '/').split(/[\/\s,]+/).filter(Boolean) : []
    pinLabels[pin] = [...new Set([...(element.port_hints || []), ...labels])].slice(0, 16)
    if (!pinLabels[pin].length) pinLabels[pin] = [pin]
  }
  const pads: ResolvedPart['pads'] = []
  for (const item of soup) {
    const element = item as unknown as Record<string, unknown>
    if (element.type !== 'pcb_smtpad' && element.type !== 'pcb_plated_hole') continue
    const hints = element.port_hints
    const pin = Array.isArray(hints) ? hints.find((hint) => typeof hint === 'string' && /^pin\d+$/.test(hint)) : null
    if (!pin) throw new Error(`${mpn}: a copper pad has no numbered pin`)
    const x = Number(element.x), y = Number(element.y)
    if (element.type === 'pcb_smtpad') {
      const shape = element.shape
      if (shape !== 'rect' && shape !== 'circle' && shape !== 'pill') throw new Error(`${mpn}: footprint has an unsupported pad shape`)
      const diameter = Number(element.radius) * 2
      pads.push({ kind: 'smt', pin, x, y, shape, width: Number(element.width ?? diameter), height: Number(element.height ?? diameter), ...(element.radius == null ? {} : { radius: Number(element.radius) }) })
    } else {
      if (element.shape !== 'circle') throw new Error(`${mpn}: footprint has an unsupported plated slot`)
      pads.push({ kind: 'hole', pin, x, y, holeDiameter: Number(element.hole_diameter), outerDiameter: Number(element.outer_diameter) })
    }
  }
  const bounds = soup.find((item) => item.type === 'pcb_component')
  if (!bounds || bounds.type !== 'pcb_component') throw new Error('Catalogue has no footprint bounds')
  return validateResolvedPart({ partNumber: mpn, package: actualPackage, lcsc: expectedLcsc,
    manufacturer: parsed.dataStr.head.c_para.Manufacturer || '', source: 'easyeda', fetchedAt: new Date().toISOString(),
    pinLabels, pads, width: bounds.width, height: bounds.height })
}

export async function resolveCataloguePart(mpn: string, pkg: string, lcsc?: string, listing?: CatalogueOffer): Promise<ResolvedPart> {
  // C14877 is a supplier identifier, not a manufacturer number. Resolve its
  // verified listing before checking symbol identity.
  if (/^C[1-9][0-9]{0,9}$/i.test(mpn)) {
    listing ||= await lookupCatalogueOffer(mpn, pkg, lcsc)
    mpn = listing.partNumber; lcsc = listing.lcsc
  }
  const cacheKey = `part:v2:${key(mpn)}:${lcsc || listing?.lcsc || ''}`
  const cached = await readLocal<ResolvedPart>(cacheKey).catch(() => null)
  if (cached) {
    const validated=validateResolvedPart(cached)
    if(key(validated.partNumber)!==key(mpn)||lcsc&&validated.lcsc!==lcsc)throw new Error('Cached catalogue identity does not match the selected component')
    if(pkg&&key(pkg)!=='CUSTOM'&&!key(validated.package).startsWith(key(pkg)))throw new Error(`${mpn}: catalogue package differs from ${pkg}`)
    return validated
  }
  const identifier = lcsc || (listing || await lookupCatalogueOffer(mpn, pkg)).lcsc
  if (!/^C[1-9][0-9]{0,9}$/.test(identifier)) throw new Error('Invalid catalogue part identifier')
  const response = await fetchCatalogueJson(`/api/easyeda_components/${identifier}`)
  const details = record(response) && record(response.easyeda_component_details) ? response.easyeda_component_details : null
  if (!details?.easyeda_json) throw new Error(`${mpn}: symbol and footprint are unavailable`)
  const resolved = resolveEasyEda(details.easyeda_json, mpn, pkg, identifier)
  await writeLocal(cacheKey, resolved, 30 * 24 * 60 * 60_000).catch(() => {})
  return resolved
}
