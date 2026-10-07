import { expect, test } from '@playwright/test'

test('selected answers survive reloads and repeated model questions advance without an extra call', async ({page}) => {
  test.skip(process.env.NEXT_PUBLIC_BROWSER_COMPUTE_ONLY !== 'true', 'Requires the browser-mode workspace')
  const user={_id:'507f1f77bcf86cd799439011',name:'Test Engineer',email:'engineer@example.com',isVerified:true,role:'user'}
  const project={_id:'507f1f77bcf86cd799439012',owner:user._id,title:'Smart water purifier',status:'active',tags:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}
  const objectiveQuestion='What is the primary objective of the smart water purifier?'
  const objectives=['Provide safe drinking water by removing contaminants','Monitor water quality in real-time and alert users','Extend filter life through predictive maintenance']
  const sensors=['pH level','Turbidity','Conductivity (TDS)','Temperature','Chlorine concentration','All of the above']
  const emptyRequirements={project_name:null,category:null,objective:null,target_users:null,functional_requirements:null,hardware_inputs:null,hardware_outputs:null,connectivity:null,supported_platforms:null,power_requirements:null,physical_constraints:null,performance_requirements:null,safety_compliance:null,budget:null}
  const chat:Record<string,any>={_id:'507f1f77bcf86cd799439013',project:project._id,user:user._id,title:'Water purifier chat',createdAt:new Date().toISOString(),requirements:{...emptyRequirements,power_requirements:'Battery and solar',design_interview:{version:2,request:'Design a smart water purifier with BLE and quality sensors',turn:5,status:'question'}}}
  const messages:Record<string,any>[]=[
    {type:'user',content:chat.requirements.design_interview.request},
    {type:'assistant',content:'Which water quality parameters must the sensors monitor?',metadata:{options:sensors}},
    {type:'user',content:'Selected answers:\n- All of the above'},
    {type:'assistant',content:objectiveQuestion,metadata:{options:objectives}},
    {type:'user',content:'Selected answers:\n- '+objectives[1]+'\n- '+objectives[0]},
    {type:'assistant',content:objectiveQuestion,metadata:{options:objectives}},
  ]
  let calls=0
  await page.route('**/api/v1/**',async(route)=>{
    const request=route.request(),path=new URL(request.url()).pathname.replace('/api/v1','')
    const body=request.method()==='GET'?{}:request.postDataJSON()
    let data:any={}
    if(path==='/auth/me')data=user
    else if(path==='/billing/plans')data={billingEnabled:false,meteringEnabled:false,freeChatsPerMonth:5,packs:[],rates:{browserInference:2}}
    else if(path.includes('/notifications'))data={count:0,items:[]}
    else if(['/projects','/projects/recent','/projects/favourites'].includes(path))data={items:[project],pagination:{total:1}}
    else if(path===('/projects/'+project._id))data=project
    else if(path===('/chats/project/'+project._id))data={items:[chat]}
    else if(path===('/chats/'+chat._id))data=chat
    else if(path===('/chats/'+chat._id+'/messages'))data={items:messages}
    else if(path===('/chats/'+chat._id+'/messages/save')){const message={...body,metadata:{options:body.options || []}};messages.push(message);data={_id:String(messages.length),...message}}
    else if(path===('/chats/'+chat._id+'/artifacts')){Object.assign(chat,body);data=chat}
    else if(path==='/ai/providers')data={boardProviders:[],defaultBoardProvider:null}
    else if(path==='/ai/browser-inference'){
      calls++
      expect(body.purpose).toBe('interview')
      expect(body.messages[0].content).toContain('Chlorine concentration')
      expect(body.messages[0].content).toContain(objectives[0])
      expect(body.messages[0].content).toContain(objectives[1])
      // Reproduce the provider's duplicate question and null-filled facts.
      data={content:JSON.stringify({status:'question',question:objectiveQuestion,options:objectives,requirements:emptyRequirements}),model:'test',usage:{}}
    }
    await route.fulfill({json:{data}})
  })
  await page.goto('/workspace')
  await expect(page.getByText(objectiveQuestion,{exact:true})).toHaveCount(2)
  const composer=page.locator('input').filter({visible:true}).first()
  await composer.fill('Continue')
  await composer.press('Enter')
  const outputsQuestion='What should the electronics control or report?'
  await expect(page.getByText(outputsQuestion,{exact:true})).toBeVisible()
  await expect(page.getByText(objectiveQuestion,{exact:true})).toHaveCount(2)
  expect(calls).toBe(1)
  expect(chat.requirements.hardware_inputs).toEqual(sensors.slice(0,5))
  expect(chat.requirements.objective).toContain(objectives[0])
  expect(chat.requirements.objective).toContain(objectives[1])
  expect(chat.requirements.power_requirements).toBe('Battery and solar')
  expect(chat.requirements.design_interview.answers).toHaveLength(2)
  await page.reload()
  await expect(page.getByText(outputsQuestion,{exact:true})).toBeVisible()
  // Submit a real selected option with an empty free-text composer.
  await page.getByRole('button',{name:'Sensor readings and alerts only',exact:true}).click()
  await page.locator('input').filter({visible:true}).first().press('Enter')
  await expect.poll(()=>calls).toBe(2)
  await expect.poll(()=>chat.requirements.design_interview.turn).toBe(7)
  await expect(page.getByText('How should this project communicate with other devices?',{exact:true})).toBeVisible()
  await expect(page.getByText(objectiveQuestion,{exact:true})).toHaveCount(2)
  expect(chat.requirements.hardware_outputs).toEqual(['Sensor readings and alerts only'])
  expect(chat.requirements.hardware_inputs).toEqual(sensors.slice(0,5))
  expect(chat.requirements.objective).toContain(objectives[1])
  expect(calls).toBe(2)
})
