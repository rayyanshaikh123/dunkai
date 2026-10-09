'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUp, Loader2, Mic, Paperclip, X } from 'lucide-react'
import Image from 'next/image'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useWorkspaceStore, type PendingAction, type AiOutput, type BoardArtifact } from '@/lib/store'
import { ModelSelector } from './model-selector'
import { aiApi, billingApi, chatApi, fileApi } from '@/lib/api'
import { useUpdateProject } from '@/hooks/use-projects'
import { useUpdateChatArtifacts } from '@/hooks/use-chats'
import { useBoardGeneration } from '@/hooks/use-board-generation'
import { useSpeechToText } from '@/hooks/use-speech-to-text'
import { toast } from 'sonner'

// ---- Message types ----
type MessageRole = 'user' | 'assistant'
interface Message {
  id: string
  role: MessageRole
  content: string
  // Quick-reply options shown beneath an interview question
  options?: string[]
}

/**
 * One word for the loader, Claude-style. The word names the stage that is
 * actually running (from ai:progress); before the first progress event, or
 * for a node without a word, it cycles through the idle set.
 */
const STAGE_WORDS: Record<string, string> = {
  supervisor: 'Planning',
  safety: 'Checking',
  requirements: 'Scoping',
  architecture: 'Architecting',
  component: 'Sourcing',
  eda_enrichment: 'Footprinting',
  pcb: 'Routing',
  validation: 'Validating',
  documentation: 'Documenting',
  code_generation: 'Coding',
  board: 'Fabricating',
}
const IDLE_WORDS = ['Thinking', 'Tinkering', 'Sketching', 'Wiring', 'Probing', 'Calibrating']

/** Shown instead of a success message when a turn came back with nothing. */
const NO_OUTPUT =
  'That run finished without producing anything to show. Try rephrasing the request, or run it again.'


function humanText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const text = value.trim()
  if (!text) return fallback

  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text) as { question?: unknown; content?: unknown; message?: unknown }
      for (const candidate of [parsed.question, parsed.content, parsed.message]) {
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
      }
    } catch {
      // Preserve normal prose that merely starts with a bracket.
    }
  }
  return text
}

function humanOptions(value: unknown): string[] {
  let raw = value
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      raw = [raw]
    }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    raw = (raw as { options?: unknown }).options
  }
  if (!Array.isArray(raw)) return []

  return raw.reduce<string[]>((choices, item) => {
    const label = typeof item === 'string'
      ? item
      : item && typeof item === 'object'
        ? String((item as { label?: unknown; text?: unknown; value?: unknown }).label ?? (item as { text?: unknown }).text ?? (item as { value?: unknown }).value ?? '')
        : ''
    const clean = label.trim()
    if (clean && !/^(other|custom)(\b|\s|[-—:])/i.test(clean) && !choices.includes(clean)) choices.push(clean)
    return choices
  }, []).slice(0, 8)
}

const suggestions = [
  'Design a smart water purifier with BLE and quality sensors',
  'Design a low-power sensor board',
  'Review my power architecture',
  'Create a KiCad starter project',
]
const placeholderPrompts = [
  'Design a smart water purifier with BLE & status LED...',
  'Design an IoT temperature sensor with WiFi...',
  'Create a low-power wearable board...',
]

// The three notices the chat posts around an automatic board run. Kept here so
// the failure wording is identical whether the run died before it got a jobId
// or after.
const BOARD_STARTING = 'Generating PCB...'
const BOARD_DONE = 'PCB preview generated — open the PCB tab for the layout and 3D board. Fabrication export awaits independent checks.'
const boardFailure = (error: string | null) => `⚠️ PCB generation failed: ${error ?? 'unknown error'}`

export function ChatInterface({ projectId }: { projectId: string }) {
  const { pendingPrompt, setPendingPrompt, setAiOutput, replaceAiOutput, setActiveTab, setPipelineProgress, clearPipelineProgress, setPipelineRun, selectedModel, setSelectedModel } = useWorkspaceStore()
  // Which chat *session* this view is showing — lives in the shared store so
  // the sidebar's session list can switch it directly instead of relaying
  // through a reset signal.
  const activeChatId = useWorkspaceStore((s) => s.activeChatId)
  const setActiveChatId = useWorkspaceStore((s) => s.setActiveChatId)
  // Read (not depended-on) by the message-loading effect below, so it can
  // check "is a prompt about to be auto-sent into this chat" at the moment
  // activeChatId changes without re-running every time pendingPrompt itself
  // changes (which happens moments later, right as that same send begins,
  // and would re-fire the reload mid-race if it were a real dependency).
  const pendingPromptRef = useRef(pendingPrompt)
  pendingPromptRef.current = pendingPrompt
  const updateProject = useUpdateProject()
  const updateChatArtifacts = useUpdateChatArtifacts(projectId)
  // Board generation runs itself off the back of the pipeline; this view owns
  // the trigger because this is where the pipeline's completion lands.
  const { generate: generateBoard } = useBoardGeneration(projectId, activeChatId)
  const boardJob = useWorkspaceStore((s) => s.boardJob)
  // The jobId of a board run this view started, so the outcome is announced
  // once and only for a run the chat is actually narrating.
  const announcedBoardJobRef = useRef<{ jobId: string; chatId: string | null } | null>(null)
  // Set right before runAgent's own inline chatId-resolution fallback calls
  // setActiveChatId (rare: only when the pick-a-chat effect hasn't resolved
  // one yet). The message-loading effect below checks this so it doesn't
  // treat "runAgent just adopted the chat it's mid-way through posting to"
  // as a session switch and wipe the message/loading state runAgent already
  // set with a reload of what the server has saved so far (which can still
  // be empty at that exact instant) — that race is what caused the send to
  // visibly flash back to empty right after the user hit send.
  const selfInitiatedChatIdRef = useRef<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [billingEnabled, setBillingEnabled] = useState(false)
  const [localRuntime, setLocalRuntime] = useState(false)
  useEffect(() => {
    billingApi.plans().then((plans) => { setBillingEnabled(plans.billingEnabled); setLocalRuntime(plans.localRuntimeEnabled) }).catch(() => {})
  }, [])
  const [placeholder, setPlaceholder] = useState('')
  const [placeholderIndex, setPlaceholderIndex] = useState(0)
  const [selectedOptions, setSelectedOptions] = useState<string[]>([])
  const [activeQuestionId, setActiveQuestionId] = useState<string | null>(null)
  
  const [completedNodes, setCompletedNodes] = useState<string[]>([])
  const [activeNode, setActiveNode] = useState<string>('')
  const [idleWord, setIdleWord] = useState(0)

  const [attachments, setAttachments] = useState<Array<{ id: string; name: string }>>([])
  const [uploadingFile, setUploadingFile] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const speech = useSpeechToText(setInput)

  const bottomRef = useRef<HTMLDivElement>(null)

  // ---- Sync pipeline progress to workspace store for top Nav Tabs ----
  useEffect(() => {
    setPipelineProgress({ activeNode, completedNodes })
  }, [activeNode, completedNodes, setPipelineProgress])

  // ---- Loader word: the running stage, else a slow idle cycle ----
  useEffect(() => {
    if (!loading) return
    const interval = setInterval(() => setIdleWord((i) => (i + 1) % IDLE_WORDS.length), 2400)
    return () => clearInterval(interval)
  }, [loading])
  const loaderWord = STAGE_WORDS[activeNode] ?? IDLE_WORDS[idleWord]

  // ---- Animated placeholder ----
  useEffect(() => {
    if (input) return
    const prompt = placeholderPrompts[placeholderIndex]
    if (placeholder.length < prompt.length) {
      const t = window.setTimeout(() => setPlaceholder(prompt.slice(0, placeholder.length + 1)), 42)
      return () => window.clearTimeout(t)
    }
    const t = window.setTimeout(() => {
      setPlaceholder('')
      setPlaceholderIndex((i) => (i + 1) % placeholderPrompts.length)
    }, 1800)
    return () => window.clearTimeout(t)
  }, [input, placeholder, placeholderIndex])

  // ---- Auto-scroll ----
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading, activeNode])

  // Show an assistant line and persist it — the pattern every reply in this
  // view already follows. The id carries a suffix because the board notices can
  // land in the same millisecond as the pipeline's closing message.
  const postAssistant = useCallback((content: string, chatId: string | null) => {
    setMessages((prev) => [
      ...prev,
      { id: `${Date.now()}-${prev.length}-assistant`, role: 'assistant', content },
    ])
    if (chatId) chatApi.saveMessage(chatId, 'assistant', content).catch(() => {})
  }, [])

  // ---- Report how an automatic board run ended ----
  // Only for a run this view announced: a board started by hand from the BOM
  // tab narrates itself there and should not appear in the transcript twice.
  //
  // Posts into the chat CAPTURED when the run started, not the live
  // activeChatId: a board build runs for minutes, and if the user switches
  // sessions before it finishes, using the live activeChatId would post
  // "PCB generated" into whatever session happens to be open now — leaving
  // the session that actually started the build stuck showing "Generating
  // PCB..." forever, with no completion message ever reaching it.
  useEffect(() => {
    const announced = announcedBoardJobRef.current
    if (!announced || boardJob.jobId !== announced.jobId) return
    if (boardJob.status !== 'done' && boardJob.status !== 'error') return

    announcedBoardJobRef.current = null
    postAssistant(boardJob.status === 'done' ? BOARD_DONE : boardFailure(boardJob.error), announced.chatId)
  }, [boardJob.status, boardJob.jobId, boardJob.error, postAssistant])

  // ---- Pick a chat session when the project changes ----
  // Split from the message/artifact-loading effect below (keyed on
  // activeChatId): a project can have many chat sessions (see the Chat model
  // / sidebar session list), each with its OWN independent
  // requirements/architecture/bom/etc — nothing project-level to hydrate
  // here, just which session to open.
  useEffect(() => {
    let isMounted = true
    // Reset messages when active project changes so previous project messages are not retained
    setMessages([])
    setInput('')
    setLoading(false)
    setSelectedOptions([])
    setActiveQuestionId(null)
    setCompletedNodes([])
    setActiveNode('')
    clearPipelineProgress()
    setPipelineRun('idle')

    async function pickChat() {
      if (!projectId) return
      try {
        // Pick which chat session to open: the most recent one, or a fresh
        // session if this project has none yet. The sidebar's session list
        // lets the user switch to a different one afterward, which updates
        // the store directly rather than re-running this effect.
        const chatsRes = (await chatApi.list(projectId)) as { items?: Array<{ _id: string }> }
        const chatList = chatsRes?.items || []
        let chatId = chatList[0]?._id

        if (!chatId) {
          const newChat = (await chatApi.create(projectId, 'New chat')) as { _id: string }
          chatId = newChat?._id
        }

        if (isMounted && chatId) setActiveChatId(chatId)
      } catch {
        // Soft fallback
      }
    }

    pickChat()

    return () => {
      isMounted = false
    }
  }, [projectId, clearPipelineProgress, setPipelineRun, setActiveChatId])

  // ---- Load messages + artifacts for whichever chat session is active ----
  // Fires on the initial project-open (once the effect above resolves a
  // chatId) and again any time the sidebar switches sessions. Each session
  // carries its own requirements/architecture/bom/etc (see the Chat model),
  // so switching sessions must fully REPLACE the store's aiOutput rather than
  // merge into it — otherwise the previous session's data would bleed
  // through wherever the new session hasn't generated something yet.
  useEffect(() => {
    if (!activeChatId) return
    if (selfInitiatedChatIdRef.current === activeChatId) {
      // runAgent just adopted this chatId itself, mid-send — nothing to
      // load, and reloading here would race the save it's still doing.
      selfInitiatedChatIdRef.current = null
      return
    }
    if (pendingPromptRef.current) {
      // A prompt is about to be sent into this very chat (the pick-a-chat
      // effect just resolved it, and the auto-run effect below is waiting
      // on exactly this activeChatId to fire runAgent). Reloading "what's on
      // the server" here is not just redundant but actively racy: on a
      // brand-new chat it is still empty, and if this reload's setMessages([])
      // lands after runAgent's optimistic setMessages, it wipes the message
      // the user just sent back off the screen.
      return
    }
    let isMounted = true
    setMessages([])
    setInput('')
    setLoading(false)
    setSelectedOptions([])
    setActiveQuestionId(null)
    setCompletedNodes([])
    setActiveNode('')
    clearPipelineProgress()
    setPipelineRun('idle')

    async function loadChatSession() {
      try {
        const [chatData, msgRes] = await Promise.all([
          chatApi.get(activeChatId!) as Promise<Record<string, unknown>>,
          chatApi.messages(activeChatId!) as Promise<{
            items?: Array<{ type: string; content: string; metadata?: { options?: string[] } }>
          }>,
        ])
        if (!isMounted) return
        if (typeof chatData.designModel === 'string' && chatData.designModel) setSelectedModel(chatData.designModel)

        // Mongoose stores these as Mixed with `default: {}`, so an untouched
        // field arrives as `{}` (or absent) rather than null. `{}` must not
        // reach the store: it is indistinguishable from a real-but-empty
        // artifact downstream, and setAiOutput's merge would treat it as
        // "nothing new" instead of the wholesale replace this needs.
        const saved = (key: string): Record<string, unknown> | null => {
          const val = chatData?.[key]
          return val && typeof val === 'object' && !Array.isArray(val) && Object.keys(val as object).length > 0
            ? (val as Record<string, unknown>)
            : null
        }

        replaceAiOutput({
          requirements: saved('requirements'),
          architecture: saved('architecture'),
          bom: saved('bom'),
          eda_data: saved('eda_data'),
          pcb_ir: saved('pcb_ir'),
          // Schema 2.0 designs report here and leave `validation` unset, so
          // forwarding only `validation` left the Validation tab empty on
          // every current run.
          validation: saved('validation'),
          handoff_validation: saved('handoff_validation'),
          documentation: saved('documentation'),
          code_generation: saved('code_generation'),
          // The board's files live under uploads/boards/ and outlive the
          // session; `urls` points straight at them, so restoring the saved
          // object is enough to bring the PCB, DRC and Docs figures back.
          board: saved('board') as BoardArtifact | null,
        })

        const parsed: Message[] = (msgRes?.items || []).map((m, idx) => ({
          id: `history-${idx}`,
          role: (m.type === 'user' ? 'user' : 'assistant') as MessageRole,
          content: m.content,
          options: m.metadata?.options,
        }))

        // Reconcile a "Generating PCB..." message a reload/disconnect left
        // dangling mid-build: its completion follow-up (see the boardJob
        // effect above) is a live, in-memory socket announcement only, with
        // no persistence fallback, so a client that wasn't around when the
        // job actually finished never sees it — even though the board
        // (saved on this very chat, just hydrated above) genuinely completed.
        const lastMsg = parsed[parsed.length - 1]
        if (lastMsg?.role === 'assistant' && lastMsg.content === BOARD_STARTING && saved('board')) {
          parsed.push({ id: `${Date.now()}-catchup`, role: 'assistant', content: BOARD_DONE })
          chatApi.saveMessage(activeChatId!, 'assistant', BOARD_DONE).catch(() => {})
        }

        setMessages(parsed)

        const lastAssistant = parsed.filter((m) => m.role === 'assistant').pop()
        setActiveQuestionId(lastAssistant?.options ? lastAssistant.id : null)
      } catch {
        // Soft fallback
      }
    }

    loadChatSession()

    return () => {
      isMounted = false
    }
  }, [activeChatId, clearPipelineProgress, setPipelineRun, replaceAiOutput])

  // ---- Core agent runner ----
  const runAgent = useCallback(
    async (request: string, runAction: PendingAction = 'run_workflow') => {
      const userMessageId = `${Date.now()}-user`
      setMessages((prev) => {
        if (prev.some((m) => m.content === request)) return prev
        return [...prev, { id: userMessageId, role: 'user', content: request }]
      })
      setLoading(true)
      setPipelineRun('running')
      setCompletedNodes([])
      setActiveNode('supervisor')

      // Dynamically resolve targetChatId if state hasn't populated yet
      let targetChatId = activeChatId
      if (!targetChatId && projectId) {
        try {
          const chatsRes = (await chatApi.list(projectId)) as { items?: Array<{ _id: string }> }
          targetChatId = chatsRes?.items?.[0]?._id || null
          if (!targetChatId) {
            const newChat = (await chatApi.create(projectId, 'Project Chat')) as { _id: string }
            targetChatId = newChat?._id
          }
          if (targetChatId) {
            selfInitiatedChatIdRef.current = targetChatId
            setActiveChatId(targetChatId)
          }
        } catch {
          // Soft fallback
        }
      }

      try {
        const res = await aiApi.runStream({
          projectId,
          chatId: targetChatId ?? undefined,
          action: runAction,
          model: selectedModel,
          messages: [
            ...messages.map((m) => ({ role: m.role, content: m.content })),
            { role: 'user', content: request },
          ],
        })
        const jobId = res?.jobId

        // Persist the message only after the server accepts the quoted job.
        // A 402 must not leave an unanswered turn in the chat history.
        if (targetChatId) {
          chatApi.saveMessage(targetChatId, 'user', request).catch(() => {})
        }

        if (!jobId) {
          const chatRes = (await aiApi.chat(projectId, request, undefined, selectedModel)) as { reply?: string }
          const hasReply = Boolean(chatRes?.reply?.trim())
          const replyText = hasReply ? (chatRes.reply as string) : NO_OUTPUT
          setMessages((prev) => [
            ...prev,
            { id: `${Date.now()}-assistant`, role: 'assistant', content: replyText },
          ])
          if (targetChatId) {
            chatApi.saveMessage(targetChatId, 'assistant', replyText).catch(() => {})
          }
          setLoading(false)
          // No reply is not a success: nothing for the arcade to celebrate.
          setPipelineRun(hasReply ? 'done' : 'error')
          setActiveNode('')
          return
        }

        const socket = (await import('@/lib/socket')).getSocket()
        socket.emit('ai:subscribe', jobId)

        const cleanup = () => {
          socket.off('ai:progress', handleProgress)
          socket.off('ai:complete', handleComplete)
          socket.off('ai:error', handleError)
          socket.emit('ai:unsubscribe', jobId)
        }

        // Accumulated locally (not read back from React state) so
        // handleComplete below sees exactly what happened in *this* run —
        // the `completedNodes` state closed over at call time would still
        // read as last run's value, since state updates from handleProgress
        // land in later renders this closure never sees.
        const runCompletedNodes: string[] = []
        const handleProgress = (data: { node?: string }) => {
          if (data.node) {
            setActiveNode(data.node)
            if (!runCompletedNodes.includes(data.node)) runCompletedNodes.push(data.node)
            setCompletedNodes((prev) => (prev.includes(data.node!) ? prev : [...prev, data.node!]))
          }
        }

        const handleComplete = async (socketData: Record<string, any>) => {
          cleanup()
          setLoading(false)
          setActiveNode('')

          let payload = socketData.data ?? socketData.result ?? socketData
          if (payload && payload.data && typeof payload.data === 'object') {
            payload = payload.data
          }

          // Case 1: Requirements agent needs clarifying response
          if (payload.interview_status === 'question') {
            const question = humanText(payload.interview_question, 'Could you provide more detail?')
            const options = humanOptions(payload.interview_options)
            const messageId = `${Date.now()}-assistant`
            const assistantMsg: Message = {
              id: messageId,
              role: 'assistant',
              content: question,
              options: options.length > 0 ? options : undefined,
            }
            setMessages((prev) => [...prev, assistantMsg])
            setSelectedOptions([])
            setActiveQuestionId(messageId)

            if (targetChatId) {
              chatApi.saveMessage(targetChatId, 'assistant', question, options).catch(() => {})
            }
            setPipelineRun('question')
            return
          }

          // Case 1b: the safety check stopped this turn before any design work.
          // The supervisor's last message is the neutral explanation; nothing
          // else in the payload is new (it only echoes the design already on
          // screen), so none of the artifact handling below applies.
          if (payload.workflow_status === 'blocked') {
            const blockedMsgs = payload.messages as Array<{ content?: string }> | undefined
            const notice =
              (Array.isArray(blockedMsgs) ? blockedMsgs[blockedMsgs.length - 1]?.content : undefined) ||
              "This request can't be processed."
            setMessages((prev) => [...prev, { id: `${Date.now()}-assistant`, role: 'assistant', content: notice }])
            if (targetChatId) chatApi.saveMessage(targetChatId, 'assistant', notice).catch(() => {})
            setPipelineRun('error')
            return
          }

          const errors = payload.errors as string[] | undefined

          // Case 2: Full workflow complete -> update state, persist to MongoDB, and update dynamic project title
          // Captured BEFORE setAiOutput below, which itself clears `board`
          // the instant this run touches bom/pcb_ir (see that store method) —
          // reading it after would always see null, defeating the check that
          // uses this to tell "a board already existed" from "this is fresh".
          const boardExistedBeforeThisRun = Boolean(useWorkspaceStore.getState().aiOutput?.board)
          // Whether this run produced any artifact at all; a run that did not
          // must not be announced as complete.
          let anyPopulated = false

          if (payload) {
            const artifactPayload = {
              requirements: (payload.requirements as Record<string, unknown>) ?? null,
              architecture: (payload.architecture as Record<string, unknown>) ?? null,
              bom: (payload.bom as Record<string, unknown>) ?? null,
              eda_data: (payload.eda_data as Record<string, unknown>) ?? null,
              pcb_ir: (payload.pcb_ir as Record<string, unknown>) ?? null,
              validation: (payload.validation as Record<string, unknown>) ?? null,
              // Schema 2.0 designs report here and leave `validation` unset, so
              // forwarding only `validation` leaves the Validation tab empty on
              // every current run.
              handoff_validation: (payload.handoff_validation as Record<string, unknown>) ?? null,
              documentation: (payload.documentation as Record<string, unknown>) ?? null,
              code_generation: (payload.code_generation as Record<string, unknown>) ?? null,
              board: (payload.board as AiOutput['board']) ?? null,
            } satisfies AiOutput

            anyPopulated = Object.values(artifactPayload).some((value) => value != null)

            // A run that failed and produced nothing has nothing to contribute.
            // Writing it would be a no-op under the merging `setAiOutput`, but
            // skipping it keeps the failure purely a chat message and leaves
            // the board job log of the design still on screen untouched.
            if (anyPopulated || !errors?.length) {
              setAiOutput(artifactPayload)
            }

            // Persist the generated artifacts onto THIS chat session, not the
            // project — each session holds its own independent design (see
            // the Chat model), so writing to the project would bleed one
            // session's results into every other session in the same project.
            const artifactUpdate: Record<string, unknown> = {}
            if (artifactPayload.requirements) artifactUpdate.requirements = artifactPayload.requirements
            if (artifactPayload.architecture) artifactUpdate.architecture = artifactPayload.architecture
            if (artifactPayload.bom) artifactUpdate.bom = artifactPayload.bom
            if (artifactPayload.eda_data) artifactUpdate.eda_data = artifactPayload.eda_data
            if (artifactPayload.pcb_ir) artifactUpdate.pcb_ir = artifactPayload.pcb_ir
            if (artifactPayload.validation) artifactUpdate.validation = artifactPayload.validation
            if (artifactPayload.handoff_validation) artifactUpdate.handoff_validation = artifactPayload.handoff_validation
            if (artifactPayload.documentation) artifactUpdate.documentation = artifactPayload.documentation
            if (artifactPayload.code_generation) artifactUpdate.code_generation = artifactPayload.code_generation

            if (Object.keys(artifactUpdate).length > 0 && targetChatId && !localRuntime && !billingEnabled) {
              updateChatArtifacts.mutate({ id: targetChatId, data: artifactUpdate })
            }

            // The project's title, unlike the design artifacts above, is a
            // project-level concept shared by every session in it.
            if (payload.requirements && typeof payload.requirements === 'object') {
              const reqs = payload.requirements as Record<string, unknown>
              const projName = typeof reqs.project_name === 'string' ? reqs.project_name.trim() : null
              if (projName && projName.toLowerCase() !== 'untitled project') {
                updateProject.mutate({ id: projectId, data: { title: projName } })
              }
              // `requirements` is echoed back in the serialised state on
              // EVERY run, single-node revisions included (it's carried-over
              // state, not something that node produced) — so jumping to the
              // Requirements tab here unconditionally used to hijack the view
              // away from whatever tab a targeted revision was actually about.
              // Only a genuine full-pipeline run touches requirements_node
              // itself; a single-node run's runCompletedNodes never includes
              // it, which is exactly the signal to tell the two apart.
              if (runCompletedNodes.includes('requirements')) {
                setActiveTab('requirements')
              }
            }
          }

          const aiMsgs = payload.messages as Array<{ content?: string }> | undefined
          const lastAiMsg = Array.isArray(aiMsgs) ? aiMsgs[aiMsgs.length - 1]?.content : undefined

          const producedNothing = !anyPopulated && !lastAiMsg?.trim()
          const finalMsg =
            (errors?.length ? `⚠️ Pipeline completed with issues: ${errors.join('; ')}` : undefined) ||
            lastAiMsg ||
            // "Complete, go look at the tabs" only when there is something in them.
            (producedNothing ? NO_OUTPUT : 'AI pipeline complete. Switch to any tab to review the generated results.')

          const cleanReply = humanText(finalMsg, 'Requirements are ready to review.')
          setMessages((prev) => [
            ...prev,
            { id: `${Date.now()}-assistant`, role: 'assistant', content: cleanReply },
          ])

          if (targetChatId) {
            chatApi.saveMessage(targetChatId, 'assistant', cleanReply).catch(() => {})
          }

          // The pipeline's last act is a PCB handoff, so the board run starts
          // here instead of waiting for someone to find the button — but only
          // the FIRST time (no board yet) or when the user specifically asked
          // about the PCB/board itself. Without that second guard, ANY
          // revision request that didn't match a narrower keyword (see
          // _infer_single_node_action) falls back to a full-workflow re-run,
          // which touches 'pcb' just like every other stage — and would
          // silently rebuild the physical board every time regardless of what
          // was actually asked to change, making it look like every revision
          // "only remakes the PCB" no matter which tab it was really about.
          const handoff = payload.pcb_ir as { components?: unknown[] } | null | undefined
          const handoffComponents = Array.isArray(handoff?.components) ? handoff.components.length : 0
          const isPcbTargetedRevision = runCompletedNodes.length === 1 && runCompletedNodes[0] === 'pcb'
          // An interface revision exists to get a board that can be built, so
          // it always rebuilds — the old board was made from the old wiring.
          const shouldAutoBuildBoard =
            !boardExistedBeforeThisRun || isPcbTargetedRevision || runAction === 'revise_interfaces'
          if (
            handoffComponents > 0 &&
            runCompletedNodes.includes('pcb') &&
            shouldAutoBuildBoard &&
            useWorkspaceStore.getState().boardJob.status !== 'running'
          ) {
            postAssistant(BOARD_STARTING, targetChatId)

            await generateBoard(selectedModel, targetChatId)

            // generate() either reached startBoardJob, which means there is a
            // jobId for the watcher to match on, or it failed before getting
            // one (the POST itself was refused). The second case never produces
            // a state change the watcher can recognise, so it is reported here.
            const started = useWorkspaceStore.getState().boardJob
            if (started.jobId) announcedBoardJobRef.current = { jobId: started.jobId, chatId: targetChatId }
            else if (started.status === 'error') postAssistant(boardFailure(started.error), targetChatId)
          }

          // Settled only now, after the board job (if any) is already running,
          // so the two overlap and the turn never looks idle in between.
          setPipelineRun(errors?.length || producedNothing ? 'error' : 'done')
        }

        const handleError = (socketData: Record<string, any>) => {
          cleanup()
          setLoading(false)
          setPipelineRun('error')
          setActiveNode('')

          const errObj = socketData.error
          const errorMsg = typeof errObj === 'object' ? errObj.error || errObj.message : errObj
          const reply = `⚠️ AI Engine error: ${errorMsg || 'Pipeline failed mid-stream.'}`

          setMessages((prev) => [
            ...prev,
            { id: `${Date.now()}-assistant`, role: 'assistant', content: reply },
          ])

          if (targetChatId) {
            chatApi.saveMessage(targetChatId, 'assistant', reply).catch(() => {})
          }
        }

        socket.on('ai:progress', handleProgress)
        socket.on('ai:complete', handleComplete)
        socket.on('ai:error', handleError)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to connect to DunkAI'
        toast.error(msg)
        setMessages((prev) => [...prev, { id: `${Date.now()}-assistant`, role: 'assistant', content: `⚠️ ${msg}` }])
        setPipelineRun('error')
        setLoading(false)
        setActiveNode('')
      }
    },
    [projectId, activeChatId, setActiveChatId, messages, setAiOutput, setActiveTab, setPipelineRun, updateProject, updateChatArtifacts, generateBoard, postAssistant, localRuntime, billingEnabled, selectedModel]
  )

  // Auto-run initial prompt passed from new project initial screen.
  //
  // Waits for activeChatId: on a brand-new project this effect and the
  // pick-a-chat effect above both start on mount, and firing immediately
  // raced them — this effect's own inline chatId fallback in runAgent could
  // create ITS OWN new chat at the same time the other effect created a
  // different one, and whichever finished last would win, sometimes leaving
  // the visible conversation attached to the wrong (empty) chat, which read
  // as the whole chat flashing away right after sending. Waiting for the
  // pick-a-chat effect to actually resolve one first makes this the only
  // writer in the common case, so there's nothing left to race.
  useEffect(() => {
    if (pendingPrompt && activeChatId) {
      const p = pendingPrompt
      const action = useWorkspaceStore.getState().pendingAction ?? 'run_workflow'
      setPendingPrompt(null)
      useWorkspaceStore.getState().setPendingAction(null)
      runAgent(p, action)
    }
  }, [pendingPrompt, activeChatId, setPendingPrompt, runAgent])

  const send = () => {
    if ((!input.trim() && selectedOptions.length === 0 && attachments.length === 0) || loading) return
    if (speech.isListening) speech.toggle(input)
    const customAnswer = input.trim()
    const request = [
      selectedOptions.length > 0 ? `Selected answers:\n- ${selectedOptions.join('\n- ')}` : '',
      attachments.length > 0 ? `Attached file(s): ${attachments.map((a) => a.name).join(', ')}` : '',
      customAnswer,
    ]
      .filter(Boolean)
      .join('\n\n')
    setInput('')
    setSelectedOptions([])
    setActiveQuestionId(null)
    setAttachments([])
    runAgent(request)
  }

  const toggleOption = (option: string) => {
    setSelectedOptions((current) =>
      current.includes(option) ? current.filter((item) => item !== option) : [...current, option]
    )
  }

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploadingFile(true)
    try {
      const res = (await fileApi.upload(file, projectId)) as { _id?: string; id?: string }
      const id = res?._id || res?.id || `${Date.now()}`
      setAttachments((prev) => [...prev, { id, name: file.name }])
      toast.success(`Attached ${file.name}`)
    } catch {
      toast.error(`Failed to upload ${file.name}`)
    } finally {
      setUploadingFile(false)
    }
  }

  const removeAttachment = (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id))

  const handleMicClick = () => {
    if (!speech.isSupported) {
      toast.error('Voice input is not supported in this browser.')
      return
    }
    speech.toggle(input)
  }

  const composer = (
    <div className="mx-auto w-full max-w-[780px] px-5">
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((a) => (
            <span
              key={a.id}
              className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs text-foreground"
            >
              {a.name}
              <button
                type="button"
                onClick={() => removeAttachment(a.id)}
                aria-label={`Remove ${a.name}`}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex h-[58px] items-center gap-2 rounded-full border border-foreground/15 bg-card/90 px-3 shadow-[0_14px_50px_rgba(0,0,0,0.22)] backdrop-blur-md transition-colors focus-within:border-foreground/35">
        <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileSelected} />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadingFile}
          className="h-9 w-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
          title="Attach a file"
        >
          {uploadingFile ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
        </Button>
        <ModelSelector value={selectedModel} onChange={setSelectedModel} disabled={loading} />
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              send()
            }
          }}
          placeholder={
            speech.isListening
              ? 'Listening...'
              : selectedOptions.length
                ? 'Add any details, or send your selections...'
                : placeholder || placeholderPrompts[0]
          }
          className="h-10 flex-1 border-0 bg-transparent px-1 text-sm shadow-none placeholder:text-muted-foreground/80 focus-visible:ring-0"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={handleMicClick}
          className={`h-9 w-9 shrink-0 rounded-full transition-colors ${
            speech.isListening ? 'animate-pulse text-red-500 hover:text-red-500' : 'text-muted-foreground hover:text-foreground'
          }`}
          title={speech.isListening ? 'Stop voice input' : 'Use voice input'}
        >
          <Mic className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          onClick={send}
          disabled={(!input.trim() && selectedOptions.length === 0 && attachments.length === 0) || loading}
          size="icon"
          className="h-9 w-9 shrink-0 rounded-full bg-foreground text-background hover:bg-foreground/90"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
        </Button>
      </div>
      <p className="mt-3 text-center text-[11px] text-muted-foreground">
        {localRuntime ? 'Designs run on your connected computer. Local computation is free; hosted model calls cost 2 credits after the free allowance. ' : billingEnabled && 'Design runs reserve up to 30 credits; an automatic PCB build reserves up to 101 more. '}
        Review generated engineering decisions before manufacturing.
      </p>
    </div>
  )

  if (!messages.length && !loading) {
    return (
      <div className="relative flex h-full flex-col items-center justify-center overflow-hidden px-4 pb-20">
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-[200px] w-[900px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/[0.07] blur-[90px]" />
        <div className="relative z-10 mb-8 flex max-w-[720px] flex-col items-center text-center">
          <div className="mb-5 flex h-16 w-16 items-center justify-center">
            <Image src="/logo.png" alt="DunkAI" width={50} height={40} className="h-10 w-auto" />
          </div>
          <h1 className="font-display text-4xl tracking-tight sm:text-5xl">What are you building?</h1>
          <p className="mt-4 max-w-lg text-sm leading-6 text-muted-foreground">
            Describe a hardware idea, ask for a design review, or bring an existing board into the workspace.
          </p>
        </div>
        <div className="relative z-10 w-full">{composer}</div>
        <div className="relative z-10 mt-7 flex max-w-[760px] flex-wrap justify-center gap-2">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setInput(s)}
              className="rounded-full border border-border bg-secondary/50 px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground"
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex h-full flex-col">
      <div className="flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-[820px] flex-col gap-8 px-5 py-10">
          {messages.map((message) => (
            <div key={message.id} className={`flex items-start gap-3 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {message.role === 'assistant' && (
                <div className="flex h-7 w-10 shrink-0 items-center justify-center">
                  <Image src="/logo.png" alt="DunkAI" width={35} height={28} className="h-7 w-auto" />
                </div>
              )}
              <div className="flex flex-col gap-2 max-w-[680px]">
                <div className={`text-sm leading-7 ${message.role === 'user' ? 'rounded-2xl bg-secondary px-4 py-3' : 'text-foreground'}`}>
                  {message.content}
                </div>
                {message.options && message.options.length > 0 && (
                  <div className="mt-2 ml-0">
                    <div className="flex flex-wrap gap-2">
                      {message.options.map((opt) => {
                        const isSelected = selectedOptions.includes(opt)
                        return (
                          <button
                            key={opt}
                            type="button"
                            disabled={loading || activeQuestionId !== message.id}
                            aria-pressed={isSelected}
                            onClick={() => toggleOption(opt)}
                            className={`flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-all active:scale-95 disabled:cursor-not-allowed disabled:opacity-40 ${
                              isSelected
                                ? 'border-foreground bg-foreground text-background shadow-sm'
                                : 'border-foreground/20 bg-secondary/60 text-foreground hover:border-foreground/40 hover:bg-secondary'
                            }`}
                          >
                            <span className="font-bold text-[11px]">{isSelected ? '✓' : '+'}</span>
                            <span>{opt}</span>
                          </button>
                        )
                      })}
                    </div>
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      Select one or multiple options above, then click send — or type custom details below.
                    </p>
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* Loader: no container, Kevin and one shimmering word for the
              stage that is running, the way Claude shows "Thinking…". */}
          {loading && (
            <div role="status" aria-live="polite" className="flex items-center gap-2.5 py-1 pl-1">
              <img src="/kevin.webp" alt="" className="h-7 w-auto shrink-0 [image-rendering:pixelated]" />
              <span key={loaderWord} className="text-shimmer text-[15px] font-medium animate-in fade-in duration-300">
                {loaderWord}…
              </span>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
      <div className="border-t border-border bg-background/90 py-5 backdrop-blur-xl">{composer}</div>
    </div>
  )
}
