import type { Page } from '@playwright/test'

export async function installCatalogueFixtures(page: Page) {
  await page.route('https://jlcsearch.tscircuit.com/api/search?**',async(route)=>{
    const q=new URL(route.request().url()).searchParams.get('q')
    const components=q==='C14877'||q==='ATMEGA328P-AU'?[{lcsc:14877,mfr:'ATMEGA328P-AU',package:'TQFP-32(7x7)',stock:30390,price:2.3541}]:[]
    await route.fulfill({json:{components},headers:{'access-control-allow-origin':'*'}})
  })
  await page.route('https://jlcsearch.tscircuit.com/resistors/list.json?**',async(route)=>{
    const params=new URL(route.request().url()).searchParams
    await route.fulfill({json:{resistors:[{lcsc:25804,mfr:'TEST-RESISTOR',package:params.get('package'),resistance:Number(params.get('resistance')),stock:10000,price1:0.0019,is_surface_mount:true}]},headers:{'access-control-allow-origin':'*'}})
  })
  await page.route('https://jlcsearch.tscircuit.com/capacitors/list.json?**',async(route)=>{
    const params=new URL(route.request().url()).searchParams
    await route.fulfill({json:{capacitors:[{lcsc:14663,mfr:'TEST-CAPACITOR',package:params.get('package'),capacitance_farads:Number(params.get('capacitance')),stock:10000,price1:0.0022,is_surface_mount:true}]},headers:{'access-control-allow-origin':'*'}})
  })
}
