import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'

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
      nets: [{name:'IO',interface:'GPIO',members:[{ref_id:'U1',role:'GPIO'},{ref_id:'R1',role:'SIGNAL',pin:'1'}]}],
    } : { files: [{filename:'main.ino',code:'void setup(){pinMode(3,OUTPUT);}\nvoid loop(){digitalWrite(3,LOW);}',description:'Safe GPIO starter'}] }
    await route.fulfill({ json: { data: { content: JSON.stringify(output), model:'test', usage:{} } } })
  })
  await page.goto('/labs/browser-compute')
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name:'Run browser agents' }).click()
  await expect(page.getByRole('status', { name:'Agent status' })).toHaveText('Agents finished on this device')
  const result = JSON.parse(await page.getByLabel('Agent result').innerText())
  expect(result.errors).toEqual([])
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
