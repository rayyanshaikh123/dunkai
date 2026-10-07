import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {lookupCatalogueOffer,lookupPassiveOffer,passiveValue} from '../lib/browser-pcb/catalogue-offers.ts'
import {resolveDesignComponents} from '../lib/browser-pipeline/components.ts'
const originalFetch=globalThis.fetch
after(()=>{globalThis.fetch=originalFetch})
const mcu={lcsc:14877,mfr:'ATMEGA328P-AU',package:'TQFP-32(7x7)',stock:30390,price:2.3541}

test('resolves an LCSC code supplied as a manufacturer number using verified listing data',async()=>{
  const paths=[]
  globalThis.fetch=async(url)=>{paths.push(new URL(url).searchParams.get('q'));return Response.json({components:[mcu]})}
  const found=await lookupCatalogueOffer('C14877','TQFP-32')
  assert.deepEqual(paths,['C14877'])
  assert.equal(found.partNumber,'ATMEGA328P-AU')
  assert.equal(found.unitPriceUsd,2.3541)
  assert.equal(found.stock,30390)
  assert.equal((await lookupCatalogueOffer('','TQFP-32','C14877')).partNumber,'ATMEGA328P-AU')
  assert.match(found.sourceUrl,/^https:\/\/jlcsearch\.tscircuit\.com\/api\/search/)
  await assert.rejects(lookupCatalogueOffer('C14877','TQFP-32','C999'),/disagree/)
  await assert.rejects(lookupCatalogueOffer('OTHER-CHIP','TQFP-32','C14877'),/no exact/)
  await assert.rejects(lookupCatalogueOffer('ATMEGA328P-AU','DIP-28','C14877'),/no exact/)
})

test('matches numeric passive values and refuses an unrelated returned value',async()=>{
  assert.equal(passiveValue('10k','resistor'),10000)
  assert.equal(passiveValue('4k7','resistor'),4700)
  assert.equal(passiveValue('1mΩ','resistor'),0.001)
  assert.ok(Math.abs(passiveValue('0.1µF','capacitor')-1e-7)<1e-20)
  globalThis.fetch=async(url)=>{
    const parsed=new URL(url)
    assert.equal(parsed.searchParams.get('resistance'),'10000')
    return Response.json({resistors:[
      {lcsc:1,mfr:'WRONG-VALUE',package:'0603',resistance:10,price1:0.001,stock:999999},
      {lcsc:25804,mfr:'0603WAF1002T5E',package:'0603',resistance:10000,price1:0.000842857,stock:37165617},
    ]})
  }
  const found=await lookupPassiveOffer('resistor','10k','0603')
  assert.equal(found.lcsc,'C25804')
  assert.equal(found.unitPriceUsd,0.000842857)
  await assert.rejects(lookupPassiveOffer('resistor','10k','0603',{lcsc:'C1'}),/No exact passive/)
})

test('component selection provides genuine prices independently of footprint resolution',async()=>{
  const raw=JSON.parse(readFileSync(new URL('./fixtures/atmega328p-easyeda.json',import.meta.url)))
  globalThis.fetch=async(url)=>new URL(url).pathname.includes('easyeda_components')?Response.json(raw):Response.json({components:[mcu]})
  const selected=await resolveDesignComponents([{ref_id:'U1',part_class:'processing',part_number:'C14877',package:'TQFP-32'}])
  assert.deepEqual(selected.errors,[])
  assert.equal(selected.components[0].part_number,'ATMEGA328P-AU')
  assert.equal(selected.components[0].resolved.pads.length,32)
  assert.equal(selected.bom.rows[0].unit_price_usd,2.3541)
  assert.equal(selected.bom.summary.total_cost_usd,2.3541)
  assert.deepEqual(selected.bom.summary.unfilled_references,[])
})

test('an unavailable quote remains unknown and does not fabricate a price or stock',async()=>{
  globalThis.fetch=async()=>Response.json({resistors:[]})
  const selected=await resolveDesignComponents([{ref_id:'R1',part_class:'resistor',value:'1k',package:'0603'}])
  assert.deepEqual(selected.errors,[])
  assert.equal(selected.bom.rows[0].unit_price_usd,null)
  assert.equal(selected.bom.rows[0].stock,null)
  assert.equal(selected.bom.summary.priced_subtotal_usd,null)
  assert.equal(selected.bom.summary.unpriced_line_items,1)
  assert.equal('total_cost_usd' in selected.bom.summary,false)
})

test('a passive identity that contradicts its value is blocked rather than reused as generic geometry',async()=>{
  globalThis.fetch=async()=>Response.json({resistors:[{lcsc:1,mfr:'10-OHM',package:'0603',resistance:10,stock:1000,price1:0.01}]})
  const selected=await resolveDesignComponents([{ref_id:'R1',part_class:'resistor',part_number:'10-OHM',lcsc:'C1',value:'10k',package:'0603'}])
  assert.match(selected.errors[0],/identity could not be verified/)
  assert.equal(selected.bom.rows[0].status,'unresolved')
  assert.equal(selected.bom.rows[0].unit_price_usd,null)
})
