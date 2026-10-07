import { z } from 'zod'
import { resolveCataloguePart } from '../browser-pcb/catalogue.ts'
import { lookupCatalogueOffer, lookupPassiveOffer, type CatalogueOffer } from '../browser-pcb/catalogue-offers.ts'
import type { ResolvedPart } from '../browser-pcb/catalogue-types.ts'

const optional = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((value) => value === null || value === '' ? undefined : value, schema.optional())
export const selectionSchema = z.object({
  ref_id: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,31}$/), part_class: z.string().trim().min(1).max(40).toLowerCase(),
  part_number: optional(z.string().trim().min(1).max(120)), value: optional(z.string().trim().min(1).max(20)),
  package: z.string().trim().min(1).max(120), lcsc: optional(z.string().regex(/^C[1-9][0-9]{0,9}$/)),
})
export async function resolveDesignComponents(raw: unknown, refreshOffers=false) {
  const parts = z.array(selectionSchema).min(1).max(32).parse(raw)
  if (new Set(parts.map((part) => part.ref_id)).size !== parts.length) throw new Error('Duplicate component references')
  const resolvedByRef = new Map<string, ResolvedPart>()
  const offers = new Map<string, CatalogueOffer>()
  const errors: string[] = [], priceIssues = new Map<string, string>()
  const components: Array<Record<string, unknown>> = []
  for (let offset = 0; offset < parts.length; offset += 2) {
    components.push(...await Promise.all(parts.slice(offset, offset + 2).map(async (part) => {
      const passive = part.part_class === 'resistor' || part.part_class === 'capacitor'
      const vetted = passive || part.part_class === 'timer' && part.part_number === 'NE555P' && part.package === 'DIP8'
      let offer: CatalogueOffer | undefined
      try {
        offer = passive
          ? await lookupPassiveOffer(part.part_class as 'resistor' | 'capacitor', part.value || '', part.package,{mpn:part.part_number,lcsc:part.lcsc,fresh:refreshOffers})
          : await lookupCatalogueOffer(part.part_number || '', part.package, part.lcsc,refreshOffers)
        offers.set(part.ref_id, offer)
      } catch (error) { priceIssues.set(part.ref_id, error instanceof Error ? error.message : 'Catalogue quote unavailable') }
      const selected = { ...part, ...(offer ? {part_number: offer.partNumber, lcsc: offer.lcsc} : {}) }
      if (vetted) {
        if(passive&&!offer&&(part.part_number||part.lcsc))errors.push(`${part.ref_id}: selected passive identity could not be verified against its value and package. ${priceIssues.get(part.ref_id) || ''}`)
        return selected
      }
      try {
        if (!part.part_number && !offer) throw new Error('Exact manufacturer part number is missing')
        const resolved = await resolveCataloguePart(offer?.partNumber || part.part_number!, part.package, offer?.lcsc || part.lcsc, offer)
        resolvedByRef.set(part.ref_id, resolved)
        return { ...selected, part_number: resolved.partNumber, package: resolved.package, lcsc: resolved.lcsc, resolved }
      } catch (error) { errors.push(`${part.ref_id}: ${error instanceof Error ? error.message : 'component lookup failed'}`); return selected }
    })))
  }
  const rows = parts.map((part) => {
    const resolved = resolvedByRef.get(part.ref_id), offer = offers.get(part.ref_id)
    const builtin = ['resistor','capacitor'].includes(part.part_class) || part.part_class === 'timer' && part.part_number === 'NE555P' && part.package === 'DIP8'
    const reason = errors.find((message) => message.startsWith(`${part.ref_id}:`))
    return { reference: part.ref_id, category: part.part_class, component: part.value ? `${part.value} ${part.part_class}` : resolved?.partNumber || offer?.partNumber || part.part_number || part.part_class,
      mfr_part: resolved?.partNumber || offer?.partNumber || part.part_number, manufacturer: resolved?.manufacturer, package: resolved?.package || part.package,
      lcsc: resolved?.lcsc || offer?.lcsc || part.lcsc, build_quantity: 1, unit_price_usd: offer?.unitPriceUsd ?? null, extended_price_usd: offer?.unitPriceUsd ?? null,
      stock: offer?.stock ?? null, supplier: offer ? 'JLCPCB catalogue' : undefined, source_url: offer?.sourceUrl, price_checked_at: offer?.fetchedAt,
      price_basis: offer ? 'Catalogue small-quantity unit price; MOQ, assembly, shipping and taxes excluded' : undefined,
      price_status: offer?.unitPriceUsd != null ? 'quoted' : 'unavailable', price_reason: priceIssues.get(part.ref_id),
      status: reason ? 'unresolved' : resolved ? 'catalogue_resolved_preview' : builtin ? 'unverified' : 'unresolved', status_reason: reason }
  })
  const priced = rows.filter((row) => row.unit_price_usd !== null)
  const subtotal = priced.reduce((sum,row) => sum + row.unit_price_usd!, 0)
  return { components, resolvedByRef, errors, bom: { rows, summary: {
    total_line_items: rows.length, priced_line_items: priced.length, unpriced_line_items: rows.length - priced.length,
    priced_subtotal_usd: priced.length ? subtotal : null, ...(priced.length === rows.length ? {total_cost_usd: subtotal} : {}),
    unfilled_references: rows.filter((row) => row.status === 'unresolved').map((row) => row.reference),
  } }, eda_data: {components: [...resolvedByRef].map(([ref_id, part]) => ({ref_id,part_number:part.partNumber,footprint:part.package,pins_json:part.pinLabels,source:part.source}))} }
}
