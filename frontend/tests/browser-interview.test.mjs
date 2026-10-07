import test from 'node:test'
import assert from 'node:assert/strict'
import {mergeInterviewRequirements,readInterview,runInterviewStage} from '../lib/browser-pipeline/interview.ts'
const hardware={project_name:'LED project',category:'Indicator',objective:'Blink an LED',target_users:null,functional_requirements:['Blink at 1 Hz'],hardware_inputs:null,hardware_outputs:['LED'],connectivity:null,supported_platforms:null,power_requirements:'USB 5 V',physical_constraints:null,performance_requirements:null,safety_compliance:null,budget:'Under INR 500'}

test('a detailed brief completes requirements in one model turn without mandatory questions',async()=>{
  let calls=0
  const result=await runInterviewStage({request:'Blink an LED at 1Hz on USB 5V; custom PCB under INR500',history:[],interview:{turn:0}},async(prompt,stage)=>{
    calls+=1;assert.equal(stage,'interview');assert.match(prompt,/never repeat an answered question/)
    return JSON.stringify({status:'complete',question:null,options:[],requirements:hardware})
  })
  assert.equal(calls,1)
  assert.equal(result.interview_status,'complete')
  assert.equal(result.requirements.power_requirements,'USB 5 V')
})
test('a sparse brief returns a project-specific question and preserves cumulative answers',async()=>{
  const result=await runInterviewStage({request:'USB 5V',history:[{role:'user',content:'Blink an LED'}],interview:{turn:1},existing:{requirements:{design_interview:{version:2,request:'Blink an LED',turn:1,status:'question'},budget:'Under INR 500'}}},async(prompt)=>{
    assert.match(prompt,/Blink an LED/);assert.match(prompt,/Under INR 500/);assert.match(prompt,/USB 5V/)
    return JSON.stringify({status:'question',question:'What blink rate do you need?',options:['1 Hz','2 Hz','Adjustable'],requirements:null})
  })
  assert.equal(result.interview_status,'question')
  assert.deepEqual(result.interview_options,['1 Hz','2 Hz','Adjustable'])
})
test('an incomplete interview answer cannot start architecture or component selection',async()=>{
  await assert.rejects(runInterviewStage({request:'An indicator',history:[],interview:{turn:0}},async()=>JSON.stringify({status:'complete',question:null,options:[],requirements:{...hardware,objective:null}})),/did not capture/)
})

test('an interview continues beyond four questions and completes when the requirements are clear',async()=>{
  for(const turn of [4,5,12]) {
    const state={version:2,request:'Blink an LED',turn,status:'question'}
    assert.deepEqual(readInterview(state),state)
    const input={request:'USB 5V',history:[],interview:{turn},existing:{requirements:{...hardware,design_interview:state}}}
    const result=await runInterviewStage(input,async(prompt)=>{
      assert.match(prompt,/Original brief:\nBlink an LED/)
      assert.match(prompt,/USB 5V/)
      assert.match(prompt,/do not stop or force completion based on the number of questions/i)
      assert.doesNotMatch(prompt,/at most four|You have asked four questions/)
      return JSON.stringify({status:'question',question:'Does the LED need a physical brightness control?',options:['Fixed brightness','Adjustment knob','Buttons'],requirements:hardware})
    })
    assert.equal(result.interview_status,'question')
    assert.equal(result.interview_question,'Does the LED need a physical brightness control?')
    assert.equal(result.requirements.objective,hardware.objective)
    assert.equal(readInterview(result.requirements.design_interview).turn,turn+1)
    const completed=await runInterviewStage(input,async()=>JSON.stringify({status:'complete',question:null,options:[],requirements:hardware}))
    assert.equal(completed.interview_status,'complete')
  }
})

const emptyHardware=Object.fromEntries(Object.keys(hardware).map(key=>[key,null]))
const objectiveQuestion='What is the primary objective of the smart water purifier?'
const objectiveOptions=['Provide safe drinking water by removing contaminants','Monitor water quality in real-time and alert users','Extend filter life through predictive maintenance']
const selectedObjectives='Selected answers:\n- Monitor water quality in real-time and alert users\n- Provide safe drinking water by removing contaminants'

test('selected objectives are paired with their question and a repeated model question advances locally',async()=>{
  let calls=0
  const result=await runInterviewStage({request:selectedObjectives,history:[{role:'assistant',content:objectiveQuestion,options:objectiveOptions}],interview:{turn:4},existing:{requirements:{power_requirements:'Battery and solar',hardware_inputs:['pH','TDS','Turbidity'],design_interview:{version:2,request:'Design a smart water purifier with BLE and quality sensors',turn:4,status:'question'}}}},async(prompt)=>{
    calls++
    assert.match(prompt,/Current question and answer/)
    assert.match(prompt,/Provide safe drinking water by removing contaminants/)
    assert.match(prompt,/Monitor water quality in real-time and alert users/)
    return JSON.stringify({status:'question',question:objectiveQuestion,options:objectiveOptions,requirements:emptyHardware})
  })
  assert.equal(calls,1)
  assert.notEqual(result.interview_question,objectiveQuestion)
  assert.equal(result.interview_question,'What should the electronics control or report?')
  assert.match(result.requirements.objective,/Monitor water quality/)
  assert.match(result.requirements.objective,/Provide safe drinking water/)
  assert.equal(result.requirements.power_requirements,'Battery and solar')
  assert.deepEqual(result.requirements.hardware_inputs,['pH','TDS','Turbidity'])
  assert.equal(readInterview(result.requirements.design_interview).answers[0].answer,selectedObjectives)
})

test('All of the above expands the original option labels and persists them across reloads',async()=>{
  const question='Which water quality parameters must the sensors monitor?'
  const options=['pH level','Turbidity','Conductivity (TDS)','Temperature','Chlorine concentration','All of the above']
  const result=await runInterviewStage({request:'Selected answers:\n- All of the above',history:[],interview:{turn:2},existing:{requirements:{objective:'Purify and monitor water',power_requirements:'USB 5 V',design_interview:{version:2,request:'Smart water purifier',turn:2,status:'question',question,options}}}},async(prompt)=>{
    assert.match(prompt,/Chlorine concentration/)
    assert.match(prompt,/Conductivity \(TDS\)/)
    return JSON.stringify({status:'question',question,options,requirements:emptyHardware})
  })
  assert.deepEqual(result.requirements.hardware_inputs,options.slice(0,5))
  assert.equal(result.requirements.power_requirements,'USB 5 V')
  assert.notEqual(result.interview_question,question)
  const restored=readInterview(result.requirements.design_interview)
  assert.deepEqual(restored.answers[0].options,options)
})

test('saved answer memory survives a short history and blocks differently worded repeats',async()=>{
  const result=await runInterviewStage({request:'Continue',history:[],interview:{turn:12},existing:{requirements:{objective:'Previously confirmed objective',design_interview:{version:2,request:'Smart water purifier',turn:12,status:'question',question:objectiveQuestion,options:objectiveOptions,answers:[{question:objectiveQuestion,answer:selectedObjectives,options:objectiveOptions}]}}}},async(prompt)=>{
    assert.match(prompt,/Monitor water quality/)
    return JSON.stringify({status:'question',question:'What is the main goal of your smart water purifier?',options:objectiveOptions,requirements:emptyHardware})
  })
  assert.match(result.requirements.objective,/Monitor water quality/)
  assert.notEqual(result.interview_question,'What is the main goal of your smart water purifier?')
  assert.equal(readInterview(result.requirements.design_interview).answers[0].answer,selectedObjectives)
})

test('a more specific power question can follow a confirmed power-source choice',async()=>{
  const result=await runInterviewStage({request:'Battery',history:[],interview:{turn:1},existing:{requirements:{design_interview:{version:2,request:'A sensor',turn:1,status:'question',question:'What power source should this design use?',options:['Battery','USB 5 V','External DC']}}}},async()=>JSON.stringify({status:'question',question:'What battery voltage and peak current must the board support?',options:['3.7 V and 500 mA','7.4 V and 1 A','Help me choose'],requirements:emptyHardware}))
  assert.equal(result.interview_question,'What battery voltage and peak current must the board support?')
})

test('a question about outputs responding to sensors does not replace the confirmed inputs',async()=>{
  const result=await runInterviewStage({request:'Display and BLE alerts',history:[],interview:{turn:3},existing:{requirements:{hardware_inputs:['pH','TDS'],design_interview:{version:2,request:'Smart water purifier',turn:3,status:'question',question:'What outputs should respond to the sensor readings?',options:['Display and BLE alerts','Control actuators','Other']}}}},async()=>JSON.stringify({status:'question',question:'Which enclosure size is required?',options:['No size constraint','50 mm square','Specify another size'],requirements:emptyHardware}))
  assert.deepEqual(result.requirements.hardware_inputs,['pH','TDS'])
  assert.deepEqual(result.requirements.hardware_outputs,['Display and BLE alerts'])
})

test('partial requirements cannot erase confirmed fields with null or empty arrays',()=>{
  assert.deepEqual(mergeInterviewRequirements({objective:'Monitor water',hardware_inputs:['pH'],budget:'INR 1000'},{objective:null,hardware_inputs:[],budget:'INR 1500'}),{objective:'Monitor water',hardware_inputs:['pH'],budget:'INR 1500'})
})

test('long interviews keep a valid bounded prompt and full answer memory',async()=>{
  const answers=Array.from({length:30},(_,index)=>({question:'Which extra requirement number '+index+' applies?',answer:'A confirmed requirement '+index+' '+ 'x'.repeat(300)}))
  const input={request:'a'.repeat(2500),history:[],interview:{turn:31},existing:{requirements:{...hardware,design_interview:{version:2,request:'b'.repeat(2500),turn:31,status:'question',question:'What enclosure dimensions are required?',options:['Specify dimensions','No size constraint'],answers}}}}
  const result=await runInterviewStage(input,async(prompt)=>{
    assert.ok(prompt.length<=6000)
    const facts=prompt.split('Confirmed facts:\n')[1].split('\nAnswered questions:\n')[0]
    const records=prompt.split('\nAnswered questions:\n')[1]
    assert.doesNotThrow(()=>JSON.parse(facts))
    assert.doesNotThrow(()=>JSON.parse(records))
    return JSON.stringify({status:'question',question:'What external interface is required?',options:['UART','SPI','None'],requirements:emptyHardware})
  })
  assert.equal(readInterview(result.requirements.design_interview).answers.length,31)
})
