import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { unzipSync, strFromU8 } from 'fflate'

for (const mcu of [false,true]) test(`saves a signed-in ${mcu ? 'MCU firmware' : 'passive'} project, builds locally, and reloads private artifacts`, async ({ page }, testInfo) => {
  test.skip(process.env.NEXT_PUBLIC_BROWSER_COMPUTE_ONLY !== 'true', 'Workspace integration requires the browser-mode frontend build')
  const user = { _id: '507f1f77bcf86cd799439011', name: 'Test Engineer', email: 'engineer@example.com', isVerified: true, role: 'user' }
  const project = { _id: '507f1f77bcf86cd799439012', owner: user._id, title: 'Browser project', status: 'active', tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  const chat: Record<string, any> = { _id: '507f1f77bcf86cd799439013', project: project._id, user: user._id, title: 'Project chat', createdAt: new Date().toISOString() }
  const messages: Record<string, any>[] = []
  let inferenceCalls = 0, boardSaves = 0
  const forbidden: string[] = [], unexpected: string[] = []
  const design = { project_name:'Saved resistor project', summary:'Two resistors connected for a routing preview',requirements:['Connect two resistors'],nodes:[{id:'resistors',label:'Resistor network',category:'passive'}],edges:[],parts:[{ref_id:'R1',part_class:'resistor',value:'1k',package:'0603'},{ref_id:'R2',part_class:'resistor',value:'1k',package:'0603'}],nets:[{name:'SIGNAL',connections:['R1.2','R2.1']}],unsupported_reasons:[] }
  const plan = mcu ? {...design,parts:[{ref_id:'U1',part_class:'processing',part_number:'ATMEGA328P-AU',package:'TQFP-32',lcsc:'C14877'},design.parts[0]],nets:[{name:'IO',interface:'GPIO',members:[{ref_id:'U1',role:'GPIO'},{ref_id:'R1',role:'SIGNAL',pin:'1'}]}]} : design
  if (mcu) await page.route('https://jlcsearch.tscircuit.com/api/easyeda_components/C14877',(route)=>route.fulfill({body:readFileSync('tests/fixtures/atmega328p-easyeda.json','utf8'),contentType:'application/json',headers:{'access-control-allow-origin':'*'}}))
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(), path = new URL(request.url()).pathname.replace('/api/v1','')
    const method = request.method()
    const body = method === 'GET' ? {} : request.postDataJSON()
    let data: any
    if (path === '/auth/me') data = user
    else if (path === '/billing/plans') data = { billingEnabled:false,meteringEnabled:true,freeChatsPerMonth:5,trialCredits:0,packs:[],rates:{browserInference:2} }
    else if (path.includes('/notifications')) data = { count:0, items:[] }
    else if (path === '/projects' || path === '/projects/recent' || path === '/projects/favourites') data = { items:[project],pagination:{total:1} }
    else if (path === `/projects/${project._id}`) { if (method === 'PATCH') Object.assign(project,body); data=project }
    else if (path === `/chats/project/${project._id}`) data = {items:[chat]}
    else if (path === `/chats/${chat._id}`) data=chat
    else if (path === `/chats/${chat._id}/messages`) data={items:messages}
    else if (path === `/chats/${chat._id}/messages/save`) { messages.push(body); data={_id:String(messages.length),...body} }
    else if (path === `/chats/${chat._id}/artifacts`) { Object.assign(chat,body); data=chat }
    else if (path === '/ai/browser-inference') {
      inferenceCalls+=1
      const revision = body.messages[0].content.startsWith('Review this firmware')
      const files=[{filename:'main.ino',code:`void setup(){pinMode(3,OUTPUT);}\nvoid loop(){digitalWrite(3,LOW);delay(${revision?100:1000});}`,description:'GPIO starter'}]
      const result=revision?{reply:'Updated the delay to 100 ms.',updated_files:files}:inferenceCalls===1?plan:{files}
      data={content:JSON.stringify(result),model:'test',usage:{}}
    }
    else if (path === `/chats/${chat._id}/browser-board` && method === 'POST') {
      expect(body.sourceIr).toEqual(chat.pcb_ir)
      expect(body.circuitJson.some((item:any)=>item.type==='pcb_trace')).toBe(true)
      boardSaves+=1
      chat.board={execution:'browser',verified:false,design_name:design.project_name,out_dir:'',generated_at:new Date().toISOString(),stats:{components:2,traces:1},sizes:{},urls:{pcbSvg:`/api/v1/chats/${chat._id}/browser-board/pcb`,schematicSvg:`/api/v1/chats/${chat._id}/browser-board/schematic`,circuitJson:`/api/v1/chats/${chat._id}/browser-board/circuit`}}
      chat._boardFiles=body
      data=chat.board
    } else if (path.startsWith(`/chats/${chat._id}/browser-board/`)) {
      const kind=path.split('/').at(-1)
      const content=kind==='pcb'?chat._boardFiles.pcbSvg:kind==='schematic'?chat._boardFiles.schematicSvg:JSON.stringify(chat._boardFiles.circuitJson)
      await route.fulfill({contentType:kind==='circuit'?'application/json':'image/svg+xml',body:content});return
    } else if (path === '/ai/providers') data={boardProviders:[],defaultBoardProvider:null}
    else { if(path.includes('/ai/')||path.includes('/firmware/compile')) forbidden.push(path); else unexpected.push(path); data={} }
    await route.fulfill({json:{data}})
  })
  await page.goto('/workspace')
  const composer = page.locator('input').filter({visible:true}).first()
  await expect(page.getByRole('main').getByRole('button', {name:'Chat',exact:true})).toBeVisible()
  await composer.fill('Connect two 1k resistors')
  page.once('dialog',(dialog)=>void dialog.accept())
  await composer.press('Enter')
  await expect.poll(()=>boardSaves).toBe(1)
  await page.getByRole('main').getByRole('button',{name:'PCB',exact:true}).click()
  await expect(page.getByText('Unverified browser preview')).toBeVisible()
  expect(messages.some((message)=>message.type==='user'&&message.clientMessageId)).toBe(true)
  expect(chat.pcb_ir.components).toHaveLength(2)
  if (mcu) {
    await page.getByRole('main').getByRole('button',{name:'Code',exact:true}).click()
    await page.getByRole('button',{name:'Code Assistant',exact:true}).click()
    const request=page.getByPlaceholder('Ask for changes...')
    await request.fill('Use a 100 ms delay')
    page.once('dialog',(dialog)=>void dialog.accept())
    await request.press('Enter')
    await expect(page.getByText('Updated the delay to 100 ms.',{exact:true})).toBeVisible()
    await expect.poll(()=>chat.code_generation.files[0].code).toContain('delay(100)')
    expect(inferenceCalls).toBe(3)
  }
  const downloading = page.waitForEvent('download')
  await page.getByRole('button',{name:'Download project archive'}).click()
  const download = await downloading
  const destination = testInfo.outputPath('project.zip')
  await download.saveAs(destination)
  const archive = unzipSync(await readFile(destination))
  expect(Object.keys(archive)).toEqual(expect.arrayContaining(['README.md','project.json','pcb-ir.json','bom.csv','board/circuit.json','board/pcb.svg','board/schematic.svg']))
  expect(JSON.parse(strFromU8(archive['pcb-ir.json'])).components).toHaveLength(2)
  expect(strFromU8(archive['bom.csv'])).toContain('R1')
  await page.reload()
  await page.getByRole('main').getByRole('button',{name:'PCB',exact:true}).click()
  await expect(page.getByText('Unverified browser preview')).toBeVisible()
  expect(inferenceCalls).toBe(mcu?3:1)
  expect(boardSaves).toBe(1)
  expect(forbidden).toEqual([])
  expect(unexpected).toEqual([])
})
