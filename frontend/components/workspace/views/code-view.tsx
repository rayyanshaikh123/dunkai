'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import {
  Code2,
  Copy,
  Check,
  FileCode,
  Download,
  ChevronDown,
  ChevronRight,
  Cpu,
  Terminal,
  Braces,
  MessageSquare,
  Send,
  Loader2,
  X,
  Usb,
  Pencil,
  Trash2,
  Plus,
  CircleCheck,
  CloudOff,
} from 'lucide-react'
import { aiApi, chatApi } from '@/lib/api'
import { ModelSelector } from '../model-selector'
import { useWorkspaceStore, type AiOutput } from '@/lib/store'
import { FirmwarePanel } from './firmware-panel'
import { MicroPythonPanel } from './micropython-panel'

interface CodeFile {
  filename: string
  language: string
  description: string
  code: string
  category: string
}

interface CodeGenData {
  project_name: string
  processing_unit: string
  files: CodeFile[]
  total_files: number
  languages_used: string[]
  target?: string
}

const LANG_COLORS: Record<string, string> = {
  c: 'text-blue-400',
  cpp: 'text-blue-300',
  python: 'text-yellow-400',
  javascript: 'text-yellow-300',
  typescript: 'text-blue-400',
}

const LANG_LABELS: Record<string, string> = {
  c: 'C',
  cpp: 'C++',
  python: 'Python',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
}

const CATEGORY_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  firmware: Cpu,
  driver: Terminal,
  ai_ml: Braces,
  config: FileCode,
}

const CodeEditor = dynamic(() => import('./code-editor'), {
  ssr: false,
  loading: () => <div className="px-5 py-4 text-xs text-muted-foreground">Loading editor…</div>,
})

const SAFE_FILENAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/
const SAVE_DELAY_MS = 800

const EXTENSION_LANGUAGE: Record<string, string> = {
  ino: 'cpp',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  h: 'cpp',
  c: 'c',
  py: 'python',
  js: 'javascript',
  ts: 'typescript',
}

const languageFromName = (filename: string) =>
  EXTENSION_LANGUAGE[filename.split('.').pop()?.toLowerCase() ?? ''] ?? 'text'

const categoryFromName = (filename: string) => {
  const ext = filename.split('.').pop()?.toLowerCase()
  if (ext === 'h' || ext === 'hpp') return 'config'
  if (ext === 'py') return 'ai_ml'
  return 'firmware'
}

/** Returns an error message, or null when the name is usable. */
const filenameError = (name: string, taken: string[]) => {
  if (!SAFE_FILENAME.test(name)) return 'Use letters, numbers, dots, dashes or underscores (max 64).'
  if (!name.includes('.')) return 'Add an extension, e.g. .ino, .cpp, .h'
  if (taken.includes(name)) return 'A file with that name already exists.'
  return null
}

const withFiles = (codeGen: CodeGenData, files: CodeFile[]): CodeGenData => ({
  ...codeGen,
  files,
  total_files: files.length,
  languages_used: [...new Set(files.map((f) => f.language))],
})

type SaveState = 'saved' | 'saving' | 'pending' | 'error' | 'no-chat'

function FilenameInput({
  initial,
  validate,
  onSubmit,
  onCancel,
}: {
  initial: string
  validate: (name: string) => string | null
  onSubmit: (name: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const done = useRef(false)

  const submit = () => {
    if (done.current) return
    const name = value.trim()
    if (name === initial) return onCancel()
    const problem = validate(name)
    if (problem) return setError(problem)
    done.current = true
    onSubmit(name)
  }

  return (
    <div className="flex-1 min-w-0">
      <input
        autoFocus
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          setError(null)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
          if (e.key === 'Escape') onCancel()
        }}
        onBlur={() => (error ? onCancel() : submit())}
        placeholder="filename.cpp"
        aria-invalid={!!error}
        className={`w-full rounded-md border bg-background px-2 py-1 font-mono text-sm text-foreground focus:outline-none focus:ring-2 ${
          error ? 'border-red-500/60 focus:ring-red-500/30' : 'border-foreground/15 focus:ring-foreground/20'
        }`}
      />
      {error && <p className="mt-1 text-[11px] text-red-500">{error}</p>}
    </div>
  )
}

function SaveIndicator({ state, onRetry }: { state: SaveState; onRetry: () => void }) {
  const base = 'ml-2 inline-flex items-center gap-1 text-[11px] font-normal'
  switch (state) {
    case 'saved':
      return (
        <span className={`${base} text-muted-foreground`}>
          <CircleCheck className="h-3.5 w-3.5" /> Saved
        </span>
      )
    case 'pending':
    case 'saving':
      return (
        <span className={`${base} text-muted-foreground`}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Saving…
        </span>
      )
    case 'no-chat':
      return (
        <span className={`${base} text-amber-500`} title="Open a chat session to save code changes">
          <CloudOff className="h-3.5 w-3.5" /> Not saved — no chat session
        </span>
      )
    case 'error':
      return (
        <button type="button" onClick={onRetry} className={`${base} text-red-500 hover:underline`}>
          <CloudOff className="h-3.5 w-3.5" /> Save failed — retry
        </button>
      )
  }
}

function CodeBlock({
  file,
  isExpanded,
  readOnly,
  onToggle,
  onChange,
  validateName,
  onRename,
  onDelete,
}: {
  file: CodeFile
  isExpanded: boolean
  readOnly: boolean
  onToggle: () => void
  onChange: (code: string) => void
  validateName: (name: string) => string | null
  onRename: (name: string) => void
  onDelete: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [renaming, setRenaming] = useState(false)

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    await navigator.clipboard.writeText(file.code)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation()
    const blob = new Blob([file.code], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = file.filename
    a.click()
    URL.revokeObjectURL(url)
  }

  const CategoryIcon = CATEGORY_ICONS[file.category] || FileCode
  const langColor = LANG_COLORS[file.language] || 'text-muted-foreground'
  const langLabel = LANG_LABELS[file.language] || file.language

  return (
    <div className="rounded-xl border border-foreground/10 bg-background/60 overflow-hidden transition-all duration-200 hover:border-foreground/20">
      {/* Header — a row, not a button: the copy/download buttons live in it,
          and a <button> may not contain another <button>. */}
      <div className="w-full flex items-center hover:bg-foreground/5 transition-colors">
        {renaming ? (
          <div className="flex flex-1 min-w-0 items-start gap-3 py-3 pl-5 pr-3">
            <CategoryIcon className="h-4 w-4 mt-1.5 text-muted-foreground shrink-0" />
            <FilenameInput
              initial={file.filename}
              validate={validateName}
              onSubmit={(name) => {
                onRename(name)
                setRenaming(false)
              }}
              onCancel={() => setRenaming(false)}
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={isExpanded}
            className="flex flex-1 min-w-0 items-center gap-3 py-4 pl-5 pr-3 text-left"
          >
            {isExpanded ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            )}
            <CategoryIcon className="h-4 w-4 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground truncate">{file.filename}</span>
                <span className={`text-[10px] font-mono uppercase tracking-wider ${langColor}`}>{langLabel}</span>
              </div>
              {file.description && <p className="text-xs text-muted-foreground mt-0.5">{file.description}</p>}
            </div>
          </button>
        )}
        <div className="flex items-center gap-1 shrink-0 pr-5">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={() => setRenaming(true)}
            disabled={readOnly || renaming}
            title="Rename file"
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-red-500"
                disabled={readOnly}
                title="Delete file"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {file.filename}?</AlertDialogTitle>
                <AlertDialogDescription>
                  The file is removed from this chat session&apos;s code and won&apos;t be compiled or uploaded.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={onDelete} className="bg-red-600 text-white hover:bg-red-600/90">
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={handleCopy}
            title="Copy to clipboard"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-foreground"
            onClick={handleDownload}
            title="Download file"
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Code Content */}
      {isExpanded && (
        <div className="border-t border-foreground/5">
          <CodeEditor value={file.code} language={file.language} onChange={onChange} readOnly={readOnly} />
        </div>
      )}
    </div>
  )
}

export function CodeView({ projectId }: { projectId: string }) {
  const aiOutput = useWorkspaceStore((s) => s.aiOutput)
  const setAiOutput = useWorkspaceStore((s) => s.setAiOutput)
  const codeGen = (aiOutput?.code_generation ?? null) as CodeGenData | null
  const activeChatId = useWorkspaceStore((s) => s.activeChatId)
  // null until the user toggles anything: then the first file shows open by default.
  const [expandedFiles, setExpandedFiles] = useState<Set<string> | null>(null)
  const [addingFile, setAddingFile] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('saved')

  // ---- Persistence: edits autosave to the chat session the code was loaded from ----
  const pendingSave = useRef<{ chatId: string; data: CodeGenData } | null>(null)
  const saveTimer = useRef<number | null>(null)

  const flushSave = useCallback(async () => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = null
    const pending = pendingSave.current
    if (!pending) return
    pendingSave.current = null
    setSaveState('saving')
    try {
      await chatApi.updateArtifacts(pending.chatId, { code_generation: pending.data })
      // A newer edit may have queued while this request was in flight.
      setSaveState(pendingSave.current ? 'pending' : 'saved')
    } catch {
      setSaveState('error')
    }
  }, [])

  // Switching chats or leaving the tab must not drop an edit still waiting to save.
  useEffect(() => () => void flushSave(), [activeChatId, flushSave])

  const updateFiles = useCallback(
    (files: CodeFile[]) => {
      const current = useWorkspaceStore.getState().aiOutput?.code_generation as CodeGenData | null
      if (!current) return
      const next = withFiles(current, files)
      setAiOutput({ code_generation: next as unknown as Record<string, unknown> })
      const chatId = useWorkspaceStore.getState().activeChatId
      if (!chatId) {
        setSaveState('no-chat')
        return
      }
      pendingSave.current = { chatId, data: next }
      setSaveState('pending')
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => void flushSave(), SAVE_DELAY_MS)
    },
    [setAiOutput, flushSave]
  )

  const [sidePanel, setSidePanel] = useState<'chat' | 'upload' | null>(null)
  const chatOpen = sidePanel === 'chat'
  const setChatOpen = (open: boolean) => setSidePanel(open ? 'chat' : null)
  const [messages, setMessages] = useState<{ role: string; content: string }[]>([])
  const [input, setInput] = useState('')
  const [codeModel, setCodeModel] = useState(() => useWorkspaceStore.getState().selectedModel)
  const [loading, setLoading] = useState(false)
  const revisionAbort = useRef<AbortController | null>(null)
  useEffect(() => { setMessages([]); setLoading(false); return () => revisionAbort.current?.abort() }, [activeChatId])

  const handleSend = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!input.trim() || loading || !codeGen?.files) return
    const browserMode = process.env.NEXT_PUBLIC_BROWSER_COMPUTE_ONLY === 'true'
    if (browserMode && !window.confirm('Revise code using your configured Groq account? This uses one model request; validation runs on this device.')) return
    const controller = new AbortController()
    revisionAbort.current = controller
    const targetChat = activeChatId
    const snapshot = JSON.stringify(codeGen.files)
    
    const userMsg = { role: 'user', content: input }
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setLoading(true)
    
    try {
      const res = browserMode
        ? await (await import('@/lib/browser-pipeline/revise-code')).reviseBrowserCode(codeGen.files, userMsg.content, codeGen.target || codeGen.processing_unit, controller.signal)
        : await aiApi.codeChat(projectId, codeGen.files, [...messages, userMsg], codeModel)
      if (controller.signal.aborted || useWorkspaceStore.getState().activeChatId !== targetChat) return
      if (JSON.stringify((useWorkspaceStore.getState().aiOutput?.code_generation as CodeGenData | null)?.files) !== snapshot) throw new Error('Files changed during the revision. Retry with the current files.')
      
      if (res.updated_files && res.updated_files.length > 0) {
        const latest = (useWorkspaceStore.getState().aiOutput?.code_generation as CodeGenData | null)?.files ?? codeGen.files
        const existingFiles = [...latest]
        res.updated_files.forEach((updated: any) => {
          const idx = existingFiles.findIndex((f) => f.filename === updated.filename)
          if (idx !== -1) existingFiles[idx] = { ...existingFiles[idx], ...updated }
          else existingFiles.push(updated)
        })
        updateFiles(existingFiles)
      }
      
      setMessages((prev) => [...prev, { role: 'assistant', content: res.reply }])
    } catch (err) {
      if (useWorkspaceStore.getState().activeChatId === targetChat) setMessages((prev) => [...prev, { role: 'assistant', content: err instanceof Error ? err.message : 'Code revision failed' }])
    } finally {
      if (revisionAbort.current === controller) { revisionAbort.current = null; setLoading(false) }
    }
  }

  const files = codeGen?.files ?? []
  const firstName = files[0]?.filename
  const isExpanded = (name: string) => (expandedFiles ? expandedFiles.has(name) : name === firstName)
  const currentExpanded = () => expandedFiles ?? new Set(firstName ? [firstName] : [])

  const toggleFile = (name: string) => {
    const next = new Set(currentExpanded())
    if (next.has(name)) next.delete(name)
    else next.add(name)
    setExpandedFiles(next)
  }

  const expandAll = () => setExpandedFiles(new Set(files.map((f) => f.filename)))
  const collapseAll = () => setExpandedFiles(new Set())

  const namesExcept = (name?: string) => files.map((f) => f.filename).filter((n) => n !== name)

  // Read from the store, not this render: keystrokes can land before React re-renders.
  const latestFiles = () =>
    (useWorkspaceStore.getState().aiOutput?.code_generation as CodeGenData | null)?.files ?? []

  const editFile = (name: string, code: string) =>
    updateFiles(latestFiles().map((f) => (f.filename === name ? { ...f, code } : f)))

  const renameFile = (from: string, to: string) => {
    updateFiles(
      latestFiles().map((f) => (f.filename === from ? { ...f, filename: to, language: languageFromName(to) } : f))
    )
    const next = new Set(currentExpanded())
    if (next.delete(from)) next.add(to)
    setExpandedFiles(next)
  }

  const deleteFile = (name: string) => updateFiles(latestFiles().filter((f) => f.filename !== name))

  const addFile = (name: string) => {
    updateFiles([
      ...latestFiles(),
      { filename: name, language: languageFromName(name), category: categoryFromName(name), description: '', code: '' },
    ])
    setExpandedFiles(new Set([...currentExpanded(), name]))
    setAddingFile(false)
  }

  if (!codeGen || !Array.isArray(codeGen.files)) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-foreground/10 bg-foreground/5 mb-5">
          <Code2 className="h-6 w-6 text-muted-foreground" />
        </div>
        <h3 className="text-lg font-semibold text-foreground mb-2">No code generated yet</h3>
        <p className="text-sm text-muted-foreground max-w-sm">
          Code suggestions will appear here after the AI pipeline completes. The agent will generate
          firmware, drivers, and configuration files based on your project's architecture and components.
        </p>
      </div>
    )
  }

  const categories = [...new Set(codeGen.files.map((f) => f.category))]

  return (
    <div className="h-full flex flex-row min-h-0 w-full">
      {/* Main Code Area */}
      <div className="flex-1 flex flex-col min-w-0">
      {/* Header */}
      <div className="shrink-0 border-b border-foreground/10 bg-background/85 backdrop-blur-xl px-8 py-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-foreground flex items-center gap-2">
              <Code2 className="h-5 w-5" />
              Code Generation
              <SaveIndicator state={saveState} onRetry={() => updateFiles(latestFiles())} />
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {codeGen.total_files} file{codeGen.total_files !== 1 ? 's' : ''} generated for{' '}
              <span className="font-medium text-foreground">{codeGen.project_name}</span>
              {' · '}
              <span className="font-mono text-xs">{codeGen.processing_unit}</span>
              {' · '}
              {codeGen.languages_used.map((l) => LANG_LABELS[l] || l).join(', ')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={expandAll} className="text-xs">
              Expand All
            </Button>
            <Button variant="outline" size="sm" onClick={collapseAll} className="text-xs">
              Collapse All
            </Button>
            <Button
              variant={chatOpen ? "default" : "outline"}
              size="sm"
              onClick={() => setChatOpen(!chatOpen)}
              className="text-xs gap-1.5 ml-2"
            >
              <MessageSquare className="h-3.5 w-3.5" />
              Code Assistant
            </Button>
            {(process.env.NEXT_PUBLIC_BROWSER_COMPUTE_ONLY !== 'true' || /ATMEGA328P/i.test(codeGen.processing_unit) || codeGen.target === 'micropython') && <Button
              variant={sidePanel === 'upload' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setSidePanel(sidePanel === 'upload' ? null : 'upload')}
              className="text-xs gap-1.5"
            >
              <Usb className="h-3.5 w-3.5" />
              Upload to Board
            </Button>}
          </div>
        </div>

        {/* Category pills */}
        <div className="flex items-center gap-2 mt-4">
          {categories.map((cat) => {
            const Icon = CATEGORY_ICONS[cat] || FileCode
            const count = codeGen.files.filter((f) => f.category === cat).length
            return (
              <span
                key={cat}
                className="inline-flex items-center gap-1.5 rounded-full border border-foreground/10 bg-foreground/5 px-3 py-1 text-xs font-medium text-muted-foreground"
              >
                <Icon className="h-3 w-3" />
                {cat.replace('_', ' ')} ({count})
              </span>
            )
          })}
        </div>
      </div>

      {/* File list */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-8 space-y-4">
          {files.map((file) => (
            <CodeBlock
              key={file.filename}
              file={file}
              isExpanded={isExpanded(file.filename)}
              readOnly={loading}
              onToggle={() => toggleFile(file.filename)}
              onChange={(code) => editFile(file.filename, code)}
              validateName={(name) => filenameError(name, namesExcept(file.filename))}
              onRename={(name) => renameFile(file.filename, name)}
              onDelete={() => deleteFile(file.filename)}
            />
          ))}

          {addingFile ? (
            <div className="flex items-start gap-3 rounded-xl border border-dashed border-foreground/20 px-5 py-3">
              <FileCode className="h-4 w-4 mt-1.5 text-muted-foreground shrink-0" />
              <FilenameInput
                initial=""
                validate={(name) => filenameError(name, namesExcept())}
                onSubmit={addFile}
                onCancel={() => setAddingFile(false)}
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAddingFile(true)}
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-foreground/15 py-3 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              New file
            </button>
          )}
        </div>
      </ScrollArea>
      </div>

      {sidePanel === 'upload' && (codeGen.target === 'micropython' ? <MicroPythonPanel files={codeGen.files} onClose={() => setSidePanel(null)} /> : (
        <FirmwarePanel
          projectId={projectId}
          processingUnit={codeGen.processing_unit}
          files={codeGen.files}
          onClose={() => setSidePanel(null)}
        />
      ))}

      {/* Chat Sidebar */}
      {chatOpen && (
        <div className="w-[380px] shrink-0 border-l border-foreground/10 bg-background/95 backdrop-blur-xl flex flex-col h-full shadow-2xl relative z-10">
          <div className="shrink-0 p-4 border-b border-foreground/10 flex items-center justify-between bg-background/50">
            <div className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
                <Code2 className="h-4 w-4" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-foreground">Code Assistant</h3>
                <p className="text-[10px] text-muted-foreground">Ask to rewrite or modify code</p>
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={() => setChatOpen(false)} className="h-8 w-8 rounded-full">
              <X className="h-4 w-4" />
            </Button>
          </div>
          
          <ScrollArea className="flex-1 p-4">
            <div className="space-y-4 pb-4">
              {messages.length === 0 && (
                <div className="text-center py-10 px-4">
                  <MessageSquare className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    I can modify the generated code for you. Try asking me to rewrite a file in Python, add a new driver, or explain how a function works.
                  </p>
                </div>
              )}
              {messages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-6 ${
                    msg.role === 'user' 
                      ? 'bg-foreground text-background rounded-tr-sm' 
                      : 'bg-foreground/5 text-foreground rounded-tl-sm'
                  }`}>
                    {msg.content}
                  </div>
                </div>
              ))}
              {loading && (
                <div className="flex justify-start">
                  <div className="max-w-[85%] rounded-2xl px-4 py-3 bg-foreground/5 rounded-tl-sm flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    <span className="text-xs text-muted-foreground font-medium">Updating code...</span>
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
          
          <div className="shrink-0 p-4 bg-background/50 border-t border-foreground/5">
            <form onSubmit={handleSend} className="relative flex items-center gap-2 bg-foreground/5 rounded-2xl p-1.5 focus-within:ring-2 focus-within:ring-foreground/20 transition-shadow">
              {process.env.NEXT_PUBLIC_BROWSER_COMPUTE_ONLY !== 'true' && <ModelSelector value={codeModel} onChange={setCodeModel} disabled={loading} className="shrink-0" />}
              <input
                type="text" 
                value={input}
                onChange={e => setInput(e.target.value)}
                placeholder="Ask for changes..."
                className="flex-1 bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none min-w-0"
                disabled={loading}
              />
              <Button type="submit" size="icon" disabled={!input.trim() || loading} className="h-9 w-9 shrink-0 rounded-xl bg-foreground text-background hover:bg-foreground/90">
                <Send className="h-4 w-4" />
              </Button>
            </form>
            {loading && process.env.NEXT_PUBLIC_BROWSER_COMPUTE_ONLY === 'true' && <Button variant="ghost" size="sm" onClick={() => revisionAbort.current?.abort()}>Cancel revision</Button>}
          </div>
        </div>
      )}
    </div>
  )
}
