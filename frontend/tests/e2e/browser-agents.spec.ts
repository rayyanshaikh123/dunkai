import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { installCatalogueFixtures } from './catalogue-fixtures'
test.beforeEach(async({page})=>installCatalogueFixtures(page))

const design = {
  project_name: 'Passive test', summary: 'Two resistors for a routing preview',
  requirements: ['Connect two resistors'],
  nodes: [{ id: 'network', label: 'Resistor network', category: 'passive' }], edges: [],
  parts: [
    { ref_id: 'R1', part_class: 'resistor', value: '1k', package: '0603' },
    { ref_id: 'R2', part_class: 'resistor', value: '1k', package: '0603' },
  ],
  nets: [{ name: 'SIGNAL', connections: ['R1.2', 'R2.1'] }], unsupported_reasons: [],
}
const livePassive = JSON.parse(readFileSync('tests/fixtures/live-passive-design.json','utf8'))

test('executes agent stages in a local worker with only a bounded model relay', async ({ page }) => {
  let inferenceCalls = 0
  const aiRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('/api/v1/ai/')) aiRequests.push(new URL(request.url()).pathname)
  })
  await page.route('**/api/v1/ai/browser-inference', async (route) => {
    inferenceCalls += 1
    const body = route.request().postDataJSON()
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].content.length).toBeLessThanOrEqual(6000)
    await route.fulfill({ json: { data: { content: JSON.stringify({...design,parts:design.parts.map((part)=>({...part,part_number:null,lcsc:null}))}), model: 'test', usage: {} } } })
  })
  await page.goto('/labs/browser-compute')
  const workerCreated = page.waitForEvent('worker')
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Run browser agents' }).click()
  const worker = await workerCreated
  expect(worker.url()).toBeTruthy()
  await expect(page.getByRole('status', { name: 'Agent status' })).toHaveText('Agents finished on this device')
  await expect(page.getByLabel('Agent result')).toContainText('Passive test')
  await expect(page.getByLabel('Agent result')).toContainText('2.0-browser')
  expect(inferenceCalls).toBe(1)
  expect(aiRequests).toEqual(['/api/v1/ai/browser-inference'])
})

test('accepts the recorded live provider wire format without another model call', async ({page}) => {
  await page.route('**/api/v1/ai/browser-inference',(route)=>route.fulfill({json:{data:{content:JSON.stringify(livePassive),model:'test',usage:{}}}}))
  await page.goto('/labs/browser-compute')
  await expect(page.getByRole('button',{name:'Run browser agents'})).toBeEnabled()
  page.once('dialog',(dialog)=>void dialog.accept())
  await page.getByRole('button',{name:'Run browser agents'}).click()
  await expect(page.getByRole('status',{name:'Agent status'})).toHaveText('Agents finished on this device')
  const result=JSON.parse(await page.getByLabel('Agent result').innerText())
  expect(result.errors).toEqual([])
  expect(result.pcb_ir.components).toHaveLength(2)
  expect(result.pcb_ir.nets[0].connections).toEqual(['R1.2','R2.1'])
})

test('cancels local agents while inference is waiting and ignores a late answer', async ({ page }) => {
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/api/v1/ai/browser-inference', async (route) => {
    await released
    await route.fulfill({ json: { data: { content: JSON.stringify(design), model: 'test', usage: {} } } }).catch(() => {})
  })
  await page.goto('/labs/browser-compute')
  page.once('dialog', (dialog) => void dialog.accept())
  const requested = page.waitForRequest('**/api/v1/ai/browser-inference')
  await page.getByRole('button', { name: 'Run browser agents' }).click()
  await requested
  // UI actions remain usable while the agent worker waits on the model.
  await page.getByRole('textbox', { name: 'Agent request' }).fill('A different request')
  await page.getByRole('button', { name: 'Cancel agents' }).click()
  await expect(page.getByRole('status', { name: 'Agent status' })).toHaveText('Run cancelled')
  release()
  await expect(page.getByLabel('Agent result')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Run browser agents' })).toBeEnabled()
})

test('resolves an actual multi-pin part, maps schema 2.0 roles, and generates firmware', async ({ page }) => {
  const catalogue = JSON.parse(readFileSync('tests/fixtures/atmega328p-easyeda.json', 'utf8'))
  await page.route('https://jlcsearch.tscircuit.com/api/easyeda_components/C14877', (route) => route.fulfill({ json: catalogue, headers: { 'access-control-allow-origin': '*' } }))
  let calls = 0
  await page.route('**/api/v1/ai/browser-inference', async (route) => {
    calls += 1
    const output = calls === 1 ? { ...design,
      parts: [{ref_id:'U1',part_class:'processing',part_number:'ATMEGA328P-AU',package:'TQFP-32',lcsc:'C14877'},design.parts[0]],
      // Groq sometimes puts the protocol in role and leaves interface null.
      // Use its complete wire format, including the inactive empty array.
      nets: [{name:'IO',interface:null,net_class:null,connections:[],members:[{ref_id:'U1',role:'GPIO GPIO',pin:null},{ref_id:'R1',role:'SIGNAL',pin:'1'}]}],
    } : { files: [{filename:'main.ino',code:'void setup(){pinMode(3,OUTPUT);}\nvoid loop(){digitalWrite(3,LOW);}',description:'Safe GPIO starter'}] }
    await route.fulfill({ json: { data: { content: JSON.stringify(output), model:'test', usage:{} } } })
  })
  await page.goto('/labs/browser-compute')
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name:'Run browser agents' }).click()
  await expect(page.getByRole('status', { name:'Agent status' })).toHaveText('Agents finished on this device')
  const result = JSON.parse(await page.getByLabel('Agent result').innerText())
  expect(result.errors).toEqual([])
  expect(result.pcb_ir.nets[0].interface).toBe('GPIO')
  expect(result.pcb_ir.nets[0].members[0].role).toBe('GPIO')
  expect(result.pcb_ir.nets[0].connections).toBeUndefined()
  expect(result.pcb_ir.components[0].resolved.pads).toHaveLength(32)
  expect(result.code_generation.files[0].filename).toBe('main.ino')
  expect(calls).toBe(2)
  await page.getByRole('textbox', { name:'PCB IR for local test' }).fill(JSON.stringify(result.pcb_ir))
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name:'Generate on this device' }).click()
  await expect(page.getByRole('status', { name:'Board status' })).toContainText('Finished locally')
})

test('resumes after a refresh using the saved design answer without another model call', async ({ page }) => {
  let calls = 0
  await page.route('**/api/v1/ai/browser-inference', async (route) => {
    calls += 1
    await route.fulfill({ json: { data: { content: JSON.stringify(design), model: 'test', usage: {} } } })
  })
  await page.goto('/labs/browser-compute')
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Run browser agents' }).click()
  await expect(page.getByRole('status', { name: 'Agent status' })).toHaveText('Agents finished on this device')
  // Simulate a discard before project persistence: retain the per-stage answer,
  // discard only the assembled result to exercise worker reconstruction.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open('dunkai-browser-runtime', 1); request.onsuccess = () => resolve(request.result) })
    await new Promise<void>((resolve) => {
      const tx = db.transaction('entries', 'readwrite'), store = tx.objectStore('entries')
      const read = store.get('run:browser-compute-lab')
      read.onsuccess = () => { const entry = read.result; delete entry.value.result; store.put(entry) }
      tx.oncomplete = () => resolve()
    })
    db.close()
  })
  await page.reload()
  await expect(page.getByRole('button', { name: 'Resume browser agents' })).toBeVisible()
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: 'Resume browser agents' }).click()
  await expect(page.getByRole('status', { name: 'Agent status' })).toHaveText('Agents finished on this device')
  const result = JSON.parse(await page.getByLabel('Agent result').innerText())
  expect(result.errors).toEqual([])
  expect(result.pcb_ir.components).toHaveLength(2)
  expect(calls).toBe(1)
})

test('resumes a rejected JSON run with a fresh request ID after confirmation', async ({page}) => {
  const ids: string[] = []
  await page.route('**/api/v1/ai/browser-inference', async (route) => {
    ids.push(route.request().postDataJSON().requestId)
    if (ids.length === 1) {
      await route.fulfill({status:422,json:{success:false,message:'Groq could not produce valid design or code JSON. Try a smaller or more focused request.'}})
    } else {
      await route.fulfill({json:{data:{content:JSON.stringify(design),model:'test',usage:{}}}})
    }
  })
  await page.goto('/labs/browser-compute')
  await expect(page.getByRole('button',{name:'Run browser agents'})).toBeEnabled()
  page.once('dialog',(dialog)=>void dialog.accept())
  await page.getByRole('button',{name:'Run browser agents'}).click()
  await expect(page.getByRole('status',{name:'Agent status'})).toContainText('could not produce valid')
  await page.reload()
  await expect(page.getByRole('button',{name:'Resume browser agents'})).toBeVisible()
  page.once('dialog',(dialog)=>void dialog.accept())
  await page.getByRole('button',{name:'Resume browser agents'}).click()
  await expect(page.getByRole('status',{name:'Agent status'})).toHaveText('Agents finished on this device')
  expect(ids).toHaveLength(2)
  expect(ids[1]).not.toBe(ids[0])
})

test('resumes an interview stopped at four questions using its saved answer without another model call', async ({page}) => {
  let calls=0
  const answer={status:'question',question:'Does the LED need a physical brightness control?',options:['Fixed brightness','Adjustment knob','Buttons'],requirements:null}
  await page.route('**/api/v1/ai/browser-inference',async(route)=>{
    calls+=1
    await route.fulfill({json:{data:{content:JSON.stringify(answer),model:'test',usage:{}}}})
  })
  await page.goto('/labs/browser-compute')
  await expect(page.getByRole('button',{name:'Run browser agents'})).toBeEnabled()
  await page.evaluate(async(answer)=>{
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{
      const request=indexedDB.open('dunkai-browser-runtime',1)
      request.onupgradeneeded=()=>request.result.createObjectStore('entries',{keyPath:'key'})
      request.onsuccess=()=>resolve(request.result)
      request.onerror=()=>reject(request.error)
    })
    const checkpoint={version:1,id:crypto.randomUUID(),input:{request:'USB 5V',history:[],interview:{turn:4},existing:{requirements:{design_interview:{version:2,request:'Blink an LED',turn:4,status:'question'}}}},calls:{
      design:{requestId:crypto.randomUUID()},firmware:{requestId:crypto.randomUUID()},
      interview:{requestId:crypto.randomUUID(),prompt:'Previous policy: finish after four questions.',content:JSON.stringify(answer)},
    }}
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction('entries','readwrite')
      tx.objectStore('entries').put({key:'run:browser-compute-lab',value:checkpoint,expiresAt:Date.now()+60*60*1000})
      tx.oncomplete=()=>resolve()
      tx.onerror=()=>reject(tx.error)
    })
    db.close()
  },answer)
  await page.reload()
  await expect(page.getByRole('button',{name:'Resume browser agents'})).toBeVisible()
  page.once('dialog',(dialog)=>void dialog.accept())
  await page.getByRole('button',{name:'Resume browser agents'}).click()
  await expect(page.getByRole('status',{name:'Agent status'})).toHaveText('Agents finished on this device')
  const result=JSON.parse(await page.getByLabel('Agent result').innerText())
  expect(result.interview_status).toBe('question')
  expect(result.interview_question).toBe(answer.question)
  expect(result.interview_options).toEqual(answer.options)
  expect(calls).toBe(0)
})
