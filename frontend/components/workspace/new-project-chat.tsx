'use client'

import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Loader2, Mic, Paperclip, X } from 'lucide-react'
import Image from 'next/image'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useWorkspaceStore } from '@/lib/store'
import { ModelSelector } from './model-selector'
import { useCreateProject } from '@/hooks/use-projects'
import { fileApi } from '@/lib/api'
import { useSpeechToText } from '@/hooks/use-speech-to-text'
import { toast } from 'sonner'
import { takeDraftPrompt } from '@/lib/draft-prompt'

const suggestions = ['Design a low-power sensor board', 'Review my power architecture', 'Create a KiCad starter project']
const placeholderPrompts = [
  'Design an IoT temperature sensor with WiFi...',
  'Create a low-power wearable board...',
  'Review my power architecture...',
]
const browserComputeOnly = process.env.NEXT_PUBLIC_BROWSER_COMPUTE_ONLY === 'true'

function generateTitleFromPrompt(prompt: string): string {
  if (!prompt || !prompt.trim()) return 'Untitled Project'
  const clean = prompt
    .trim()
    .replace(/^(i want to|i need to|can you|please|build|design|create|make|develop|a|an|the)\s+/i, '')
    .replace(/^(i'd like to|help me|project for)\s+/i, '')
    .trim()

  if (!clean) return 'Untitled Project'
  const words = clean.split(/\s+/)
  const titleWords = words.slice(0, 5).join(' ')
  const title = titleWords.length > 40 ? titleWords.slice(0, 40) + '…' : titleWords
  return title.charAt(0).toUpperCase() + title.slice(1)
}

export function NewProjectChat() {
  const { setActiveProjectId, setActiveTab, setPendingPrompt, selectedModel, setSelectedModel } = useWorkspaceStore()
  const createProject = useCreateProject()
  const [input, setInput] = useState('')
  const [placeholder, setPlaceholder] = useState('')
  const [placeholderIndex, setPlaceholderIndex] = useState(0)
  const [attachments, setAttachments] = useState<Array<{ id: string; name: string }>>([])
  const [uploadingFile, setUploadingFile] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const speech = useSpeechToText(setInput)

  // An idea typed on the landing page before signing in (lib/draft-prompt.ts).
  useEffect(() => {
    const draft = takeDraftPrompt()
    if (draft) setInput(draft)
  }, [])

  useEffect(() => {
    if (input) return
    const prompt = placeholderPrompts[placeholderIndex]
    if (placeholder.length < prompt.length) {
      const timer = window.setTimeout(() => setPlaceholder(prompt.slice(0, placeholder.length + 1)), 42)
      return () => window.clearTimeout(timer)
    }
    const timer = window.setTimeout(() => {
      setPlaceholder('')
      setPlaceholderIndex((current) => (current + 1) % placeholderPrompts.length)
    }, 1800)
    return () => window.clearTimeout(timer)
  }, [input, placeholder, placeholderIndex])

  const send = async () => {
    if (speech.isListening) speech.toggle(input)
    const attachmentNote = attachments.length > 0 ? `Attached file(s): ${attachments.map((a) => a.name).join(', ')}` : ''
    const prompt = [attachmentNote, input.trim()].filter(Boolean).join('\n\n')
    if (!prompt || createProject.isPending) return
    try {
      const dynamicTitle = generateTitleFromPrompt(input.trim() || prompt)
      const project = await createProject.mutateAsync({
        title: dynamicTitle,
        description: prompt,
      })
      // Hand the prompt off to the project chat so the agent starts running immediately
      setPendingPrompt(prompt)
      setActiveProjectId(project._id)
      setActiveTab('chat')
      setInput('')
      setAttachments([])
    } catch {
      toast.error('Failed to start the project. Please try again.')
    }
  }

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploadingFile(true)
    try {
      const res = (await fileApi.upload(file)) as { _id?: string; id?: string }
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

  const busy = createProject.isPending

  return (
    <div className="relative flex h-full flex-col items-center justify-center overflow-hidden px-4 pb-20">
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[300px] w-[620px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground/[0.07] blur-[90px]" />
      <div className="relative z-10 mb-8 flex max-w-[720px] flex-col items-center text-center">
        <div className="mb-5 flex h-16 w-16 items-center justify-center">
          <Image src="/logo.png" alt="DunkAI" width={50} height={40} className="h-10 w-auto" />
        </div>
        <h1 className="font-display text-4xl tracking-tight sm:text-5xl">What are you building?</h1>
        <p className="mt-4 max-w-lg text-sm leading-6 text-muted-foreground">
          Describe a hardware idea, ask for a design review, or bring an existing board into the workspace.
        </p>
      </div>
      <div className="relative z-10 w-full">
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
              disabled={uploadingFile || busy || browserComputeOnly}
              className="h-9 w-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
              title={browserComputeOnly ? 'File analysis is not available in browser computation yet' : 'Attach a file'}
              aria-label="Attach a file"
            >
              {uploadingFile ? <Loader2 className="h-4 w-4 animate-spin" /> : <Paperclip className="h-4 w-4" />}
            </Button>
            {browserComputeOnly
              ? <span className="rounded-full border px-3 py-1.5 text-xs">Groq · browser pipeline</span>
              : <ModelSelector value={selectedModel} onChange={setSelectedModel} disabled={busy} />}
            <Input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  send()
                }
              }}
              disabled={busy}
              placeholder={speech.isListening ? 'Listening...' : placeholder || placeholderPrompts[0]}
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
              aria-label={speech.isListening ? 'Stop voice input' : 'Use voice input'}
            >
              <Mic className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              onClick={send}
              disabled={(!input.trim() && attachments.length === 0) || busy}
              size="icon"
              className="h-9 w-9 shrink-0 rounded-full bg-foreground text-background hover:bg-foreground/90"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
            </Button>
          </div>
          <p className="mt-3 text-center text-[11px] text-muted-foreground">
            {busy ? 'Setting up your project workspace...' : 'DunkAI can make mistakes. Review generated engineering decisions before manufacturing.'}
          </p>
        </div>
      </div>
      <div className="relative z-10 mt-7 flex max-w-[760px] flex-wrap justify-center gap-2">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => setInput(suggestion)}
            disabled={busy}
            className="rounded-full border border-border bg-secondary/50 px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-foreground/25 hover:text-foreground disabled:opacity-50"
          >
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  )
}
