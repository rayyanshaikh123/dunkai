import { EasyEdaJsonSchema, convertEasyEdaJsonToCircuitJson } from 'easyeda/browser'
import { validateResolvedPart, type ResolvedPart } from './catalogue-types.ts'
import { readLocal, writeLocal } from '../browser-pipeline/local-storage.ts'

const ROOT = 'https://jlcsearch.tscircuit.com'
const key = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, '')
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
async function fetchJson(path: string): Promise<unknown> {
  let failure: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`${ROOT}${path}`, { signal: AbortSignal.timeout(12_000), credentials: 'omit' })
      if (!response.ok) throw new Error(`Catalogue returned HTTP ${response.status}`)
      const text = await response.text()
      if (text.length > 2_000_000) throw new Error('Catalogue response is too large')
      return JSON.parse(text)
    } catch (error) { failure = error }
  }
  throw new Error(`Component catalogue unavailable: ${failure instanceof Error ? failure.message : 'network error'}`)
}

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

export async function resolveCataloguePart(mpn: string, pkg: string, lcsc?: string): Promise<ResolvedPart> {
  const cacheKey = `part:${key(mpn)}:${key(pkg)}:${lcsc || ''}`
  const cached = await readLocal<ResolvedPart>(cacheKey).catch(() => null)
  if (cached) return validateResolvedPart(cached)
  let identifier = lcsc
  if (!identifier) {
    const response = await fetchJson(`/api/search?${new URLSearchParams({ q: mpn, limit: '100' })}`)
    const rows = record(response) && Array.isArray(response.components) ? response.components.filter(record) : []
    const candidates = rows.filter((row) => typeof row.mfr === 'string' && key(row.mfr) === key(mpn) &&
      typeof row.package === 'string' && (!pkg || key(row.package).startsWith(key(pkg))))
    if (!candidates.length) throw new Error(`${mpn}: no exact manufacturer/package match in the catalogue`)
    candidates.sort((a, b) => Number(b.stock || 0) - Number(a.stock || 0))
    identifier = `C${candidates[0].lcsc}`
  }
  if (!/^C[1-9][0-9]{0,9}$/.test(identifier)) throw new Error('Invalid catalogue part identifier')
  const response = await fetchJson(`/api/easyeda_components/${identifier}`)
  const details = record(response) && record(response.easyeda_component_details) ? response.easyeda_component_details : null
  if (!details?.easyeda_json) throw new Error(`${mpn}: symbol and footprint are unavailable`)
  const resolved = resolveEasyEda(details.easyeda_json, mpn, pkg, identifier)
  await writeLocal(cacheKey, resolved, 30 * 24 * 60 * 60_000).catch(() => {})
  return resolved
}
