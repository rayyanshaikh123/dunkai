'use client'

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, Download, Loader2, Plug, Upload, Usb, X, Hammer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ApiError, firmwareApi } from '@/lib/api'
import { flashEsp } from '@/lib/firmware/esp'
import { flashStk500 } from '@/lib/firmware/stk500'
import { browserFirmwareBoards, compileBrowserFirmware } from '@/lib/firmware/browser-compiler'
import {
  decodeImage,
  type FirmwareBoard,
  type FirmwareBoardsResponse,
  type FirmwareBuild,
  type FlashProgress,
} from '@/lib/firmware/types'

interface SourceFile {
  filename: string
  code: string
}

type Busy = 'idle' | 'compiling' | 'flashing'

const USB_BRIDGES: Record<number, string> = {
  0x1a86: 'CH340',
  0x10c4: 'CP210x',
  0x0403: 'FTDI',
  0x2341: 'Arduino',
  0x2a03: 'Arduino',
  0x303a: 'Espressif USB',
}

const BAUD_RATES = [9600, 19200, 38400, 57600, 74880, 115200, 230400]

const portLabel = (port: SerialPort) => {
  const { usbVendorId, usbProductId } = port.getInfo()
  if (usbVendorId === undefined) return 'Serial port'
  const name = USB_BRIDGES[usbVendorId] || 'USB serial'
  return `${name} (${usbVendorId.toString(16).padStart(4, '0')}:${(usbProductId ?? 0).toString(16).padStart(4, '0')})`
}

const sketchBaud = (files: SourceFile[]) => {
  const ino = files.find((f) => f.filename.endsWith('.ino'))
  const match = ino?.code.match(/Serial\.begin\s*\(\s*(\d+)/)
  return match ? Number(match[1]) : null
}

const sourceKey = (boardId: string, files: SourceFile[]) =>
  boardId + '\u0000' + files.map((f) => `${f.filename}\u0000${f.code}`).join('\u0001')

export function FirmwarePanel({
  projectId,
  processingUnit,
  files,
  onClose,
}: {
  projectId: string
  processingUnit: string
  files: SourceFile[]
  onClose: () => void
}) {
  const webSerial = typeof navigator !== 'undefined' && 'serial' in navigator
  const browserMode = process.env.NEXT_PUBLIC_BROWSER_COMPUTE_ONLY === 'true'
  const compileAbort = useRef<AbortController | null>(null)

  const [catalogue, setCatalogue] = useState<FirmwareBoardsResponse | null>(null)
  const [catalogueError, setCatalogueError] = useState<string | null>(null)
  const [boardId, setBoardId] = useState<string>('')
  const [port, setPort] = useState<SerialPort | null>(null)
  const [busy, setBusy] = useState<Busy>('idle')
  const [build, setBuild] = useState<{ key: string; result: FirmwareBuild } | null>(null)
  const [progress, setProgress] = useState<FlashProgress | null>(null)
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [tab, setTab] = useState('upload')

  const [monitorOn, setMonitorOn] = useState(false)
  const [monitorText, setMonitorText] = useState('')
  const [monitorInput, setMonitorInput] = useState('')
  const [baud, setBaud] = useState<number>(() => sketchBaud(files) ?? 115200)
  const monitorReader = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null)
  const monitorLoop = useRef<Promise<void> | null>(null)
  const logEnd = useRef<HTMLDivElement>(null)
  const monitorEnd = useRef<HTMLDivElement>(null)

  const board: FirmwareBoard | undefined = catalogue?.boards.find((b) => b.id === boardId)
  const key = useMemo(() => sourceKey(boardId, files), [boardId, files])
  const currentBuild = build?.key === key ? build.result : null

  const append = useCallback((line: string) => setLog((prev) => [...prev.slice(-400), line]), [])

  useEffect(() => {
    ;(browserMode ? Promise.resolve(browserFirmwareBoards(processingUnit)) : firmwareApi.boards(processingUnit))
      .then((data) => {
        setCatalogue(data)
        if (data.suggestedBoardId) setBoardId(data.suggestedBoardId)
      })
      .catch((err) => setCatalogueError(err instanceof Error ? err.message : 'Could not load boards'))
  }, [processingUnit, browserMode])
  useEffect(() => () => compileAbort.current?.abort(), [])
  useEffect(() => () => { if (build?.result.download.url) URL.revokeObjectURL(build.result.download.url) }, [build])

  // Block bodies: scrollIntoView returns a Promise in current Chromium, which React would treat as a cleanup.
  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'end' })
  }, [log])
  useEffect(() => {
    monitorEnd.current?.scrollIntoView({ block: 'end' })
  }, [monitorText])

  // ---- Serial monitor ----

  const stopMonitor = useCallback(async (target: SerialPort | null) => {
    if (!monitorReader.current) return
    await monitorReader.current.cancel().catch(() => {})
    await monitorLoop.current
    monitorReader.current = null
    monitorLoop.current = null
    await target?.close().catch(() => {})
    setMonitorOn(false)
  }, [])

  const startMonitor = useCallback(async (target: SerialPort, baudRate: number) => {
    await target.open({ baudRate })
    if (!target.readable) return
    const reader = target.readable.getReader()
    const decoder = new TextDecoder()
    monitorReader.current = reader
    setMonitorOn(true)
    monitorLoop.current = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          if (value) setMonitorText((prev) => (prev + decoder.decode(value, { stream: true })).slice(-50_000))
        }
      } catch {
        // Port closed or unplugged.
      } finally {
        reader.releaseLock()
      }
    })()
  }, [])

  useEffect(() => {
    if (!webSerial) return
    const onDisconnect = (event: Event) => {
      if (event.target === port) {
        monitorReader.current = null
        monitorLoop.current = null
        setMonitorOn(false)
        setPort(null)
        append('Board disconnected.')
      }
    }
    navigator.serial.addEventListener('disconnect', onDisconnect)
    return () => navigator.serial.removeEventListener('disconnect', onDisconnect)
  }, [webSerial, port, append])

  useEffect(() => () => void stopMonitor(port), [port, stopMonitor])

  // ---- Actions ----

  const choosePort = async () => {
    try {
      const picked = await navigator.serial.requestPort()
      if (picked !== port) await stopMonitor(port)
      setPort(picked)
      return picked
    } catch {
      return null
    }
  }

  const compile = async (): Promise<FirmwareBuild | null> => {
    if (currentBuild) return currentBuild
    setBusy('compiling')
    setOutcome(null)
    setLog([`Compiling for ${board?.label}…`])
    try {
      compileAbort.current = new AbortController()
      const result = browserMode
        ? await compileBrowserFirmware(boardId, files, append, compileAbort.current.signal)
        : await firmwareApi.compile(projectId, boardId, files)
      setBuild({ key, result })
      if (result.skipped.length) append(`Skipped (not part of the sketch): ${result.skipped.join(', ')}`)
      append(result.log || 'Compiled.')
      return result
    } catch (err) {
      const compileLog = err instanceof ApiError ? (err.errors?.[0] as { log?: string } | undefined)?.log : undefined
      if (compileLog) append(compileLog)
      setOutcome({ ok: false, message: err instanceof Error ? err.message : 'Compilation failed' })
      return null
    } finally {
      compileAbort.current = null
      setBusy('idle')
    }
  }

  const verify = async () => {
    const result = await compile()
    if (result) setOutcome({ ok: true, message: result.summary[0] || 'Compiled successfully.' })
  }

  const upload = async () => {
    if (!board || board.flash.protocol === 'manual') return
    // requestPort needs the click's user activation, so it must come before any other await.
    const target = port ?? (await choosePort())
    if (!target) return

    const result = await compile()
    if (!result) return

    const resumeMonitor = monitorOn
    await stopMonitor(target)

    setBusy('flashing')
    setProgress(null)
    append(`Uploading to ${portLabel(target)}…`)
    try {
      const images = result.images.map((img) => ({ address: img.address, data: decodeImage(img) }))
      if (board.flash.protocol === 'stk500v1') {
        await flashStk500(target, images[0].data, board.flash, setProgress, append)
      } else {
        await flashEsp(target, images, board.flash, setProgress, append)
      }
      setOutcome({ ok: true, message: 'Upload complete.' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed'
      append(`Error: ${message}`)
      setOutcome({ ok: false, message })
    } finally {
      setBusy('idle')
      setProgress(null)
    }

    if (resumeMonitor) await startMonitor(target, baud).catch(() => {})
  }

  const toggleMonitor = async () => {
    if (monitorOn) return stopMonitor(port)
    const target = port ?? (await choosePort())
    if (!target) return
    try {
      await startMonitor(target, baud)
    } catch (err) {
      setMonitorText((prev) => `${prev}\n[Could not open port: ${err instanceof Error ? err.message : err}]\n`)
    }
  }

  const sendLine = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!port?.writable || !monitorInput) return
    const writer = port.writable.getWriter()
    try {
      await writer.write(new TextEncoder().encode(`${monitorInput}\n`))
    } finally {
      writer.releaseLock()
    }
    setMonitorInput('')
  }

  // ---- Render ----

  const percent = progress ? Math.round((progress.done / progress.total) * 100) : 0
  const canFlash = webSerial && board?.installed && board.flash.protocol !== 'manual'
  const disabled = busy !== 'idle' || !board || !board.installed

  return (
    <div className="w-[400px] shrink-0 border-l border-foreground/10 bg-background/95 backdrop-blur-xl flex flex-col h-full shadow-2xl relative z-10">
      <div className="shrink-0 p-4 border-b border-foreground/10 flex items-center justify-between bg-background/50">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
            <Usb className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Upload to board</h3>
            <p className="text-[10px] text-muted-foreground">{browserMode ? 'Compile on this device, flash over USB' : 'Compile in the cloud, flash over USB'}</p>
          </div>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8 rounded-full" aria-label="Close upload panel">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="flex-1 min-h-0 flex flex-col">
        <TabsList className="mx-4 mt-3 grid grid-cols-2">
          <TabsTrigger value="upload">Upload</TabsTrigger>
          <TabsTrigger value="monitor">Serial Monitor</TabsTrigger>
        </TabsList>

        <TabsContent value="upload" className="flex-1 min-h-0 flex flex-col gap-4 p-4 mt-0 data-[state=inactive]:hidden">
          {!webSerial && (
            <Notice tone="warn">
              This browser can&apos;t talk to USB serial ports. Use Chrome or Edge on desktop to upload directly, or
              compile and download the firmware to flash with Arduino IDE.
            </Notice>
          )}
          {catalogueError && <Notice tone="error">{catalogueError}</Notice>}
          {catalogue && !catalogue.toolchain.available && (
            <Notice tone="error">The firmware compiler isn&apos;t installed on the server (arduino-cli not found).</Notice>
          )}

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Board</label>
            <Select value={boardId} onValueChange={setBoardId} disabled={!catalogue || busy !== 'idle'}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={catalogue ? 'Choose a board' : 'Loading boards…'} />
              </SelectTrigger>
              <SelectContent>
                {catalogue?.boards.map((b) => (
                  <SelectItem key={b.id} value={b.id} disabled={!b.installed}>
                    {b.label}
                    {!b.installed && ' (not installed on server)'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              Design uses <span className="font-mono">{processingUnit}</span>
              {catalogue && (catalogue.suggestedBoardId
                ? boardId === catalogue.suggestedBoardId && ' — matched automatically.'
                : ' — no matching Arduino-compatible target; pick one manually if it applies.')}
            </p>
          </div>

          {board?.flash.protocol === 'manual' && <Notice tone="warn">{board.flash.note}</Notice>}

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">Port</label>
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0 truncate rounded-md border border-foreground/10 px-3 py-2 text-sm">
                {port ? portLabel(port) : <span className="text-muted-foreground">No port selected</span>}
              </div>
              <Button variant="outline" size="sm" onClick={choosePort} disabled={!webSerial || busy !== 'idle'}>
                <Plug className="h-3.5 w-3.5 mr-1.5" />
                {port ? 'Change' : 'Select'}
              </Button>
            </div>
          </div>

          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="flex-1" onClick={verify} disabled={disabled}>
              {busy === 'compiling' ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Hammer className="h-3.5 w-3.5 mr-1.5" />}
              Verify
            </Button>
            <Button size="sm" className="flex-1" onClick={upload} disabled={disabled || !canFlash}>
              {busy === 'flashing' ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Upload className="h-3.5 w-3.5 mr-1.5" />}
              Upload
            </Button>
            <Button
              variant="outline"
              size="sm"
              asChild={!!currentBuild}
              disabled={!currentBuild}
              title={currentBuild ? `Download ${currentBuild.download.filename}` : 'Compile first to download'}
            >
              {currentBuild ? (
                <a href={currentBuild.download.url || firmwareApi.downloadUrl(currentBuild.buildId)} download={currentBuild.download.filename}>
                  <Download className="h-3.5 w-3.5" />
                </a>
              ) : (
                <span>
                  <Download className="h-3.5 w-3.5" />
                </span>
              )}
            </Button>
          </div>

          {browserMode && busy === 'compiling' && <Button size="sm" variant="outline" onClick={() => compileAbort.current?.abort()}>Cancel compilation</Button>}

          {busy === 'flashing' && (
            <div className="space-y-1">
              <Progress value={percent} />
              <p className="text-[11px] text-muted-foreground">
                {progress ? `${progress.phase === 'verify' ? 'Verifying' : 'Writing'}… ${percent}%` : 'Connecting…'}
              </p>
            </div>
          )}

          {outcome && (
            <Notice tone={outcome.ok ? 'ok' : 'error'}>
              {outcome.message}
              {outcome.ok && currentBuild?.summary.slice(1).map((line) => <span key={line} className="block mt-1">{line}</span>)}
            </Notice>
          )}

          {board && board.flash.protocol !== 'manual' && (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {board.flash.protocol === 'esptool'
                ? 'If the board won’t connect, hold BOOT (IO0) while you click Upload, then release it once writing starts.'
                : 'Custom PCBs need a USB-serial chip with DTR auto-reset and a bootloader burned once over ISP.'}
            </p>
          )}

          <div className="flex-1 min-h-[120px] overflow-auto rounded-lg border border-foreground/10 bg-foreground/[0.03] p-3">
            {log.length === 0 ? (
              <p className="text-xs text-muted-foreground">Build and upload output appears here.</p>
            ) : (
              <pre className="text-[11px] leading-5 font-mono whitespace-pre-wrap break-words text-foreground/85">{log.join('\n')}</pre>
            )}
            <div ref={logEnd} />
          </div>
        </TabsContent>

        <TabsContent value="monitor" className="flex-1 min-h-0 flex flex-col gap-3 p-4 mt-0 data-[state=inactive]:hidden">
          <div className="flex items-center gap-2">
            <Select value={String(baud)} onValueChange={(v) => setBaud(Number(v))} disabled={monitorOn}>
              <SelectTrigger className="w-[130px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BAUD_RATES.map((rate) => (
                  <SelectItem key={rate} value={String(rate)}>
                    {rate} baud
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant={monitorOn ? 'outline' : 'default'} onClick={toggleMonitor} disabled={!webSerial || busy !== 'idle'}>
              {monitorOn ? 'Disconnect' : 'Connect'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMonitorText('')}>
              Clear
            </Button>
          </div>
          <div className="flex-1 min-h-0 overflow-auto rounded-lg border border-foreground/10 bg-foreground/[0.03] p-3">
            <pre className="text-[11px] leading-5 font-mono whitespace-pre-wrap break-words text-foreground/85">
              {monitorText || (monitorOn ? 'Waiting for data…' : 'Connect to see what the board prints over Serial.')}
            </pre>
            <div ref={monitorEnd} />
          </div>
          <form onSubmit={sendLine} className="flex gap-2">
            <input
              value={monitorInput}
              onChange={(e) => setMonitorInput(e.target.value)}
              placeholder={monitorOn ? 'Send to board…' : 'Connect first'}
              disabled={!monitorOn}
              className="flex-1 min-w-0 rounded-md border border-foreground/10 bg-transparent px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20"
            />
            <Button type="submit" size="sm" disabled={!monitorOn || !monitorInput}>
              Send
            </Button>
          </form>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function Notice({ tone, children }: { tone: 'ok' | 'warn' | 'error'; children: React.ReactNode }) {
  const styles = {
    ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    warn: 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200',
    error: 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300',
  }[tone]
  const Icon = tone === 'ok' ? CheckCircle2 : AlertTriangle
  return (
    <div className={`flex gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed ${styles}`}>
      <Icon className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  )
}
