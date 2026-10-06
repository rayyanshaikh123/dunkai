import { expect, test } from '@playwright/test'
import { loadEnvFile } from 'node:process'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'

test('live Groq answer completes the browser design and routing path', async ({page}, testInfo) => {
  test.skip(process.env.LIVE_GROQ_BROWSER_TEST !== 'true', 'Explicit opt-in for one operator-funded live inference')
  test.setTimeout(120000)
  // Only the Node test runner reads the key. The browser receives JSON data.
  loadEnvFile('../backend/.env')
  const key=process.env.GROQ_API_KEY
  const model=process.env.GROQ_BROWSER_MODEL || 'openai/gpt-oss-120b'
  const requireBackend=createRequire(`${process.cwd()}/package.json`)
  const {browserResponseFormat}=requireBackend('../backend/src/config/browserSchemas.js')
  expect(Boolean(key)).toBe(true)
  let calls=0
  await page.route('**/api/v1/ai/browser-inference',async(route)=>{
    calls+=1
    if(calls>1) throw new Error('Live smoke test allows only one provider request')
    const body=route.request().postDataJSON()
    expect(body.messages[0].content).toContain('Create only two 1k resistors R1 and R2')
    const response=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({model,messages:body.messages,temperature:0.2,max_completion_tokens:4096,response_format:browserResponseFormat(model,body.purpose || 'design'),...(model.startsWith('openai/gpt-oss-')?{reasoning_effort:'low',include_reasoning:false}:{})}),signal:AbortSignal.timeout(60000)})
    const result=await response.json()
    const providerPath=testInfo.outputPath('live-provider-response.json')
    await writeFile(providerPath,JSON.stringify(result,null,2).split(key || '__no_key__').join('[redacted]'))
    await testInfo.attach('live-provider-response.json',{path:providerPath,contentType:'application/json'})
    const reason=String(result.error?.message || '').split(key || '__no_key__').join('[redacted]').slice(0,1000)
    expect(response.status,`Live Groq response status: ${reason}`).toBe(200)
    const answerPath=testInfo.outputPath('live-design-response.json')
    await writeFile(answerPath,result.choices?.[0]?.message?.content || '{}')
    await testInfo.attach('live-design-response.json',{path:answerPath,contentType:'application/json'})
    expect(result.choices[0].finish_reason).not.toBe('length')
    await route.fulfill({json:{data:{content:result.choices[0].message.content,model:result.model,usage:result.usage}}})
  })
  await page.goto('/labs/browser-compute')
  await expect(page.getByRole('button',{name:'Run browser agents'})).toBeEnabled()
  await page.getByRole('textbox',{name:'Agent request'}).fill('Create only two 1k resistors R1 and R2, both 0603. Connect R1 pin2 to R2 pin1 in SIGNAL using explicit connections. A routing demonstration only; no power supply, MCU, firmware or other components. Leave the other pins unconnected.')
  page.once('dialog',(dialog)=>void dialog.accept())
  await page.getByRole('button',{name:'Run browser agents'}).click()
  await expect.poll(()=>page.getByRole('status',{name:'Agent status'}).innerText()).toMatch(/Agents finished|incomplete|invalid|failed/)
  await expect(page.getByRole('status',{name:'Agent status'})).toHaveText('Agents finished on this device',{timeout:1000})
  const result=JSON.parse(await page.getByLabel('Agent result').innerText())
  expect(result.errors).toEqual([])
  expect(result.pcb_ir.components).toHaveLength(2)
  await page.getByRole('textbox',{name:'PCB IR for local test'}).fill(JSON.stringify(result.pcb_ir))
  page.once('dialog',(dialog)=>void dialog.accept())
  await page.getByRole('button',{name:'Generate on this device'}).click()
  await expect(page.getByRole('status',{name:'Board status'})).toContainText('Finished locally')
  expect(calls).toBe(1)
})
