import { z } from 'zod'
import type { BrowserPipelineInput, BrowserPipelineResult } from './protocol'

const scalar = z.string().trim().min(1).max(1000).nullable()
const list = z.array(z.string().trim().min(1).max(240)).max(20).nullable()
const hardware = z.object({
  project_name: scalar, category: scalar, objective: scalar, target_users: list,
  functional_requirements: list, hardware_inputs: list, hardware_outputs: list, connectivity: list,
  supported_platforms: list, power_requirements: scalar, physical_constraints: list,
  performance_requirements: list, safety_compliance: list, budget: scalar,
})
const answerSchema = z.object({
  status: z.enum(['question', 'complete']), question: scalar,
  options: z.array(z.string().trim().min(1).max(100)).max(6), requirements: hardware.nullable(),
})
const recordedAnswer = z.object({
  question: z.string().trim().min(1).max(1000),
  answer: z.string().trim().min(1).max(2500),
  options: z.array(z.string().trim().min(1).max(240)).max(8).optional(),
})
const stateSchema = z.object({
  version: z.literal(2), request: z.string().min(1).max(2500),
  turn: z.number().int().min(0), status: z.enum(['question', 'complete']),
  question: z.string().trim().min(1).max(1000).optional(),
  options: z.array(z.string().trim().min(1).max(100)).max(6).optional(),
  answers: z.array(recordedAnswer).optional(),
})
export type DesignInterview = z.infer<typeof stateSchema>
type RecordedAnswer = z.infer<typeof recordedAnswer>

export function readInterview(raw: unknown): DesignInterview | null {
  const parsed = stateSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

const hasValue = (value: unknown) => value !== null && value !== undefined && value !== '' &&
  (!Array.isArray(value) || value.length > 0)

/** Partial model replies must not erase previously confirmed requirements. */
export function mergeInterviewRequirements(previous: Record<string, unknown>, incoming?: Record<string, unknown> | null) {
  const merged = { ...previous }
  for (const [key, value] of Object.entries(incoming || {})) {
    if (hasValue(value)) merged[key] = value
  }
  return merged
}

const questionKey = (question: string) => question.toLowerCase()
  .replace(/\b(goal|purpose)\b/g, 'objective')
  .replace(/\b(measure|sense)\b/g, 'monitor')
  .replace(/\b(what|which|is|are|the|a|an|of|for|your|this|should|must|does|do|primary|main)\b/g, ' ')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

function valuesFromAnswer(record: RecordedAnswer): string[] {
  const values = record.answer.split('\n').map((line) => line.replace(/^\s*[-•]\s*/, '').trim())
    .filter((line) => line && !/^selected answers:$/i.test(line))
  return values.flatMap((value) => /^all (?:of )?(?:the )?(?:above|options)$/i.test(value)
    ? (record.options || []).filter((option) => !/^all (?:of )?(?:the )?(?:above|options)$/i.test(option))
    : [value])
}
const isAnswered = (record: RecordedAnswer) => valuesFromAnswer(record).some((value) =>
  !/^(?:i (?:don'?t know|am not sure)|not sure|unknown|please explain|help me (?:choose|decide)|continue|go on|next|skip)\.?$/i.test(value))

function questionField(question: string): string | undefined {
  const text = question.toLowerCase()
  if (/\b(objective|goal|purpose)\b/.test(text)) return 'objective'
  if (/\b(power|supply|battery|voltage|current draw)\b/.test(text)) return 'power_requirements'
  if (/\b(outputs?|actuators?|control or report|electronics.*control|display|indicators?)\b/.test(text)) return 'hardware_outputs'
  if (/\b(sensor|sensors|inputs?|parameters.*monitor|parameters.*measure)\b/.test(text)) return 'hardware_inputs'
  if (/\b(connectivity|communication|communicate|bluetooth|ble|wi-?fi|wireless)\b/.test(text)) return 'connectivity'
  if (/\b(budget|cost|price)\b/.test(text)) return 'budget'
  if (/\b(custom pcb|carrier pcb|wiring prototype|board approach|prototype approach)\b/.test(text)) return 'design_approach'
  if (/\b(quantity|how many|build count)\b/.test(text)) return 'build_quantity'
  if (/\b(dimensions?|size|enclosure|physical|environment)\b/.test(text)) return 'physical_constraints'
  if (/\b(performance|accuracy|sampling|response time|frequency)\b/.test(text)) return 'performance_requirements'
  if (/\b(safety|compliance|certification|hazards?)\b/.test(text)) return 'safety_compliance'
  if (/\b(functions?|features?|behavio[u]?r)\b/.test(text)) return 'functional_requirements'
  return undefined
}

function collectAnswers(input: BrowserPipelineInput, state: DesignInterview | null) {
  const records: RecordedAnswer[] = []
  let pending: BrowserPipelineInput['history'][number] | undefined
  for (const message of input.history) {
    if (message.role === 'assistant' && (message.options?.length || message.content.trim().endsWith('?'))) pending = message
    else if (message.role === 'user' && pending) {
      const parsed = recordedAnswer.safeParse({ question: pending.content, answer: message.content, options: pending.options })
      if (parsed.success) records.push(parsed.data)
      pending = undefined
    }
  }
  // Saved records take precedence over a partial transcript after a reload.
  records.push(...state?.answers || [])
  let current: RecordedAnswer | undefined
  const question = state?.question || pending?.content
  if ((state?.status === 'question' || pending) && question) {
    const parsed = recordedAnswer.safeParse({
      question, answer: input.request, options: state?.options || pending?.options,
    })
    if (parsed.success) { current = parsed.data; records.push(current) }
  }
  const unique = new Map<string, RecordedAnswer>()
  for (const record of records) {
    const key = questionKey(record.question)
    const previous = unique.get(key)
    if (previous && isAnswered(previous) && !isAnswered(record)) continue
    unique.delete(key)
    unique.set(key, record)
  }
  return { answers: [...unique.values()], current }
}

function applyConfirmedAnswers(facts: Record<string, unknown>, answers: RecordedAnswer[]) {
  const grouped = new Map<string, string[]>()
  for (const record of answers) {
    const field = questionField(record.question)
    if (!field || !isAnswered(record)) continue
    grouped.set(field, [...new Set([...(grouped.get(field) || []), ...valuesFromAnswer(record)])])
  }
  const scalarFields = new Set(['objective', 'power_requirements', 'budget', 'design_approach', 'build_quantity'])
  for (const [field, values] of grouped) {
    facts[field] = scalarFields.has(field) ? values.join('; ').slice(0, 1000) : values.slice(0, 20).map((value) => value.slice(0, 240))
  }
  if (grouped.has('objective') && !hasValue(facts.functional_requirements)) {
    facts.functional_requirements = grouped.get('objective')!.slice(0, 20).map((value) => value.slice(0, 240))
  }
  return facts
}

function alreadyAnswered(question: string, answers: RecordedAnswer[]) {
  const key = questionKey(question)
  const words = new Set(key.split(' '))
  return answers.some((record) => {
    if (!isAnswered(record)) return false
    const previous = questionKey(record.question)
    if (previous === key) return true
    // Similar wording within one topic is a repeat. A more specific voltage,
    // current, or performance question can still follow a broad source choice.
    if (!questionField(question) || questionField(question) !== questionField(record.question)) return false
    const other = new Set(previous.split(' '))
    const overlap = [...words].filter((word) => other.has(word)).length
    return overlap / new Set([...words, ...other]).size >= 0.8
  })
}

const followUps = [
  { field: 'objective', question: 'What should this project accomplish?', options: ['Monitor and report conditions', 'Control external equipment', 'Provide a user interface', 'Describe another objective'] },
  { field: 'hardware_inputs', question: 'Which signals or measurements must the electronics receive?', options: ['Sensors (specify measurements)', 'Buttons or switches', 'Data from another device', 'No external inputs'] },
  { field: 'hardware_outputs', question: 'What should the electronics control or report?', options: ['Sensor readings and alerts only', 'External actuators (specify which)', 'A local display or indicators', 'Describe other required outputs'] },
  { field: 'power_requirements', question: 'What power source and voltage should the electronics use?', options: ['USB 5 V', 'Battery (specify voltage)', 'External DC supply (specify voltage)', 'Help me choose a supply'] },
  { field: 'connectivity', question: 'How should this project communicate with other devices?', options: ['Bluetooth / BLE', 'Wi-Fi', 'Wired interface (specify)', 'No connectivity'] },
  { field: 'design_approach', question: 'Which board approach should this project use?', options: ['Custom PCB', 'Carrier PCB for existing modules', 'Wiring prototype', 'Help me choose an approach'] },
  { field: 'physical_constraints', question: 'What size or operating environment must the board fit?', options: ['No specific size or environment constraint', 'Specify an enclosure or dimensions', 'Specify environmental constraints'] },
  { field: 'performance_requirements', question: 'What measurement accuracy or response time is required?', options: ['No specific performance target', 'Specify accuracy or sampling rate', 'Specify response time'] },
  { field: 'budget', question: 'What is the hardware budget for each unit?', options: ['Under INR 500', 'INR 500–2,000', 'Above INR 2,000', 'No fixed budget'] },
  { field: 'build_quantity', question: 'How many units are you planning to build?', options: ['One prototype', '2–10 units', 'More than 10 units'] },
  { field: 'safety_compliance', question: 'Which safety or certification constraints apply?', options: ['Specify safety or certification requirements', 'No specific requirements identified yet', 'Help me identify relevant risks'] },
]
const REVIEW_QUESTION = 'Are the requirements complete, or is an essential detail still missing?'

function nextUnansweredQuestion(facts: Record<string, unknown>, answers: RecordedAnswer[]) {
  return followUps.find((item) => !hasValue(facts[item.field]) && !alreadyAnswered(item.question, answers))
}

const INSTRUCTION = "You are DunkAI's Requirement Analysis Agent. Use the original brief and explicit question/answer records. Selected answers are cumulative; multiple choices are intentional. All of the above means every listed substantive option. Confirmed facts and user corrections take precedence over null model fields. Ask only the highest-value missing architecture question; never repeat an answered question, including with different wording. Return status complete immediately when the objective, inputs, outputs and power are sufficiently clear. Do not stop or force completion based on the number of questions. Check relevant connectivity, performance, physical constraints, INR budget, build quantity, board approach and safety. Preserve cumulative confirmed requirements on every response and leave nonessential unknowns null. Do not recommend chips, footprints or traces. Questions have 3–6 short atomic options. Complete responses use question:null,options:[] and populated requirements. Return JSON only."

function interviewPrompt(initial: string, request: string, facts: Record<string, unknown>, answers: RecordedAnswer[], current?: RecordedAnswer) {
  const latest = current ? { question: current.question.slice(0, 350), options: current.options?.slice(0, 6), answer: request } : { answer: request }
  const latestText = '\nCurrent question and answer:\n' + JSON.stringify(latest) + '\n'
  const briefBudget = Math.max(0, Math.min(current ? 1000 : 2500, 6000 - INSTRUCTION.length - latestText.length - 700))
  const fixed = INSTRUCTION + '\nOriginal brief:\n' + initial.slice(0, briefBudget) + latestText
  const remaining = 6000 - fixed.length - 50
  const known: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(facts)) {
    if (key === 'design_interview' || key === 'design_brief' || !hasValue(value)) continue
    const compact = typeof value === 'string' ? value.slice(0, 500) : Array.isArray(value) ? value.slice(0, 8) : value
    if (JSON.stringify({ ...known, [key]: compact }).length <= Math.floor(remaining / 2)) known[key] = compact
  }
  const knownText = JSON.stringify(known)
  const records: Array<{ question: string; answer: string }> = []
  for (const record of [...answers].reverse()) {
    const compact = { question: record.question.slice(0, 220), answer: valuesFromAnswer(record).join('; ').slice(0, 500) }
    if (JSON.stringify([...records, compact]).length + knownText.length <= remaining) records.push(compact)
  }
  return fixed + 'Confirmed facts:\n' + knownText + '\nAnswered questions:\n' + JSON.stringify(records.reverse())
}

/** Adaptive browser interview with durable answer memory and local repeat recovery. */
export async function runInterviewStage(
  input: BrowserPipelineInput,
  infer: (prompt: string, stage: 'interview') => Promise<string>,
): Promise<BrowserPipelineResult> {
  const state = readInterview(input.existing?.requirements?.design_interview)
  const initial = state?.request || input.request
  const { answers, current } = collectAnswers(input, state)
  const previous = { ...input.existing?.requirements }
  delete previous.design_interview
  const known = applyConfirmedAnswers(previous, answers)
  const prompt = interviewPrompt(initial, input.request, known, answers, current)
  if (prompt.length > 6000) throw new Error('The requirements context is too large; shorten the project description')
  const answer = answerSchema.parse(JSON.parse(await infer(prompt, 'interview')))
  const facts = applyConfirmedAnswers(mergeInterviewRequirements(known, answer.requirements), answers)
  if (answer.status === 'question') {
    if (!answer.question || answer.options.length < 2) throw new Error('The requirements agent returned an incomplete question')
    if (alreadyAnswered(answer.question, answers)) {
      const next = nextUnansweredQuestion(facts, answers)
      if (next) { answer.question = next.question; answer.options = [...next.options] }
      else if (answers.some((record) => questionKey(record.question) === questionKey(REVIEW_QUESTION) &&
        valuesFromAnswer(record).some((value) => /^Requirements are complete$/i.test(value)))) answer.status = 'complete'
      else {
        answer.question = REVIEW_QUESTION
        answer.options = ['Requirements are complete', 'Add a missing requirement', 'Correct an earlier answer']
      }
    }
  }
  if (answer.status === 'complete' && (!facts.objective || !Array.isArray(facts.functional_requirements) || !facts.functional_requirements.length)) {
    throw new Error('The requirements agent did not capture the project objective and functions')
  }
  const nextState: DesignInterview = {
    version: 2, request: initial,
    turn: (input.interview?.turn ?? state?.turn ?? 0) + (answer.status === 'question' ? 1 : 0),
    status: answer.status, answers,
    ...(answer.status === 'question' ? { question: answer.question!, options: answer.options } : {}),
  }
  return {
    interview_status: answer.status,
    ...(answer.status === 'question' ? { interview_question: answer.question!, interview_options: answer.options } : {}),
    requirements: { ...facts, design_interview: nextState }, messages: [], errors: [],
  }
}
