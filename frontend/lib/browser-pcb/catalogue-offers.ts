import { readLocal, writeLocal } from '../browser-pipeline/local-storage.ts'

export const CATALOGUE_ROOT = 'https://jlcsearch.tscircuit.com'
export const catalogueKey = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]/g, '')
export const cleanPartNumber = (text: string) => text.normalize('NFKC').replace(/[‐‑‒–—−]/g, '-').trim()
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
export type CatalogueOffer = {
  partNumber: string; package: string; lcsc: string; description: string
  unitPriceUsd: number | null; stock: number | null; fetchedAt: string; sourceUrl: string
}
export async function fetchCatalogueJson(path: string): Promise<unknown> {
  let failure: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(`${CATALOGUE_ROOT}${path}`, { signal: AbortSignal.timeout(12_000), credentials: 'omit' })
      if (!response.ok) throw new Error(`Catalogue returned HTTP ${response.status}`)
      const text = await response.text()
      if (text.length > 2_000_000) throw new Error('Catalogue response is too large')
      return JSON.parse(text)
    } catch (error) { failure = error }
  }
  throw new Error(`Component catalogue unavailable: ${failure instanceof Error ? failure.message : 'network error'}`)
}
const numeric = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const offer = (row: Record<string, unknown>, path: string): CatalogueOffer => {
  const id = String(row.lcsc).replace(/^C/i, '')
  if (!/^[1-9][0-9]{0,9}$/.test(id) || typeof row.mfr !== 'string' || !row.mfr || typeof row.package !== 'string' || !row.package) throw new Error('Catalogue listing has no valid identity')
  return { lcsc: `C${id}`, partNumber: row.mfr, package: row.package, description: String(row.description || '').slice(0,1000),
    unitPriceUsd: numeric(row.price1 ?? row.price), stock: numeric(row.stock), fetchedAt: new Date().toISOString(), sourceUrl: CATALOGUE_ROOT + path }
}
export async function lookupCatalogueOffer(mpn: string, pkg: string, lcsc?: string, fresh=false): Promise<CatalogueOffer> {
  mpn = cleanPartNumber(mpn)
  const asId = /^C[1-9][0-9]{0,9}$/i.test(mpn) ? mpn.toUpperCase() : !mpn&&lcsc ? lcsc : undefined
  if (asId && lcsc && asId !== lcsc) throw new Error('Manufacturer field and LCSC identifier disagree')
  const identifier = lcsc || asId
  if (identifier && !/^C[1-9][0-9]{0,9}$/.test(identifier)) throw new Error('Invalid catalogue part identifier')
  const cacheKey = `offer:${catalogueKey(mpn)}:${catalogueKey(pkg)}:${identifier || ''}`
  const cached = await readLocal<CatalogueOffer>(cacheKey).catch(() => null)
  if (cached&&!fresh) return cached
  const path = `/api/search?${new URLSearchParams({ q: identifier || mpn, limit: '100' })}`
  const response = await fetchCatalogueJson(path)
  const rows = record(response) && Array.isArray(response.components) ? response.components.filter(record) : []
  const candidates = rows.filter((row) =>
    (!identifier || `C${String(row.lcsc).replace(/^C/i, '')}` === identifier) &&
    (asId || typeof row.mfr === 'string' && catalogueKey(row.mfr) === catalogueKey(mpn)) &&
    typeof row.package === 'string' && (!pkg || pkg === 'CUSTOM' || catalogueKey(row.package).startsWith(catalogueKey(pkg))))
  candidates.sort((a,b) => Number(b.stock || 0) - Number(a.stock || 0))
  if (!candidates.length) throw new Error(`${mpn}: no exact manufacturer/package match. Supply the correct manufacturer number, package and LCSC ID; modules need a verified footprint or a separate connector design.`)
  const selected = offer(candidates[0], path)
  await writeLocal(cacheKey, selected, 24 * 60 * 60_000).catch(() => {})
  return selected
}

export function passiveValue(value: string, kind: 'resistor' | 'capacitor'): number | null {
  value = value.replace(/\s/g, '').replace(/[µμ]/g, 'u')
  if (kind === 'resistor') {
    const embedded = /^(\d+)([RrKkMm])(\d+)$/.exec(value)
    if (embedded) value = `${embedded[1]}.${embedded[3]}${embedded[2]}`
    const match = /^(\d+(?:\.\d+)?)([RrKkMm]?)(?:Ω|ohms?)?$/.exec(value)
    return match ? Number(match[1]) * ({ R:1,r:1,k:1e3,K:1e3,m:1e-3,M:1e6 }[match[2]] ?? 1) : null
  }
  const match = /^(\d+(?:\.\d+)?)([pnum]?)[Ff]?$/.exec(value)
  return match ? Number(match[1]) * ({ p:1e-12,n:1e-9,u:1e-6,m:1e-3 }[match[2]] ?? 1) : null
}
export async function lookupPassiveOffer(kind: 'resistor' | 'capacitor', value: string, pkg: string, selected?:{mpn?:string;lcsc?:string;fresh?:boolean}): Promise<CatalogueOffer> {
  const wanted = passiveValue(value, kind)
  if (wanted === null || !Number.isFinite(wanted) || wanted < 0) throw new Error('Passive value cannot be matched to a catalogue listing')
  const property = kind === 'resistor' ? 'resistance' : 'capacitance'
  const path = `/${kind}s/list.json?${new URLSearchParams({ package: pkg, [property]: String(wanted) })}`
  const cacheKey=`offer:${path}:${selected?.mpn || ''}:${selected?.lcsc || ''}`
  const cached = await readLocal<CatalogueOffer>(cacheKey).catch(() => null)
  if (cached&&!selected?.fresh) return cached
  const response = await fetchCatalogueJson(path)
  const rows = record(response) && Array.isArray(response[`${kind}s`]) ? (response[`${kind}s`] as unknown[]).filter(record) : []
  const field = kind === 'resistor' ? 'resistance' : 'capacitance_farads'
  const candidates = rows.filter((row) => typeof row[field] === 'number' && Math.abs(Number(row[field]) - wanted) <= Math.max(Math.abs(wanted) * 1e-9, 1e-18) &&
    typeof row.package === 'string' && catalogueKey(row.package) === catalogueKey(pkg) && row.is_surface_mount !== false &&
    row.is_potentiometer !== true && row.is_multi_resistor_chip !== true && Number(row.stock) > 0 &&
    (!selected?.mpn || typeof row.mfr==='string'&&catalogueKey(row.mfr)===catalogueKey(selected.mpn)) &&
    (!selected?.lcsc || `C${row.lcsc}`===selected.lcsc))
  candidates.sort((a,b) => Number(b.stock || 0) - Number(a.stock || 0))
  if (!candidates.length) throw new Error('No exact passive value/package price is available')
  const matched = offer(candidates[0], path)
  await writeLocal(cacheKey, matched, 24 * 60 * 60_000).catch(() => {})
  return matched
}
