'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { cancelBrowserBoard, runBrowserBoard } from '@/lib/browser-pcb/run-browser-board'
import { runBrowserPipeline } from '@/lib/browser-pipeline/run-browser-pipeline'
import { compileBrowserFirmware } from '@/lib/firmware/browser-compiler'
import type { FirmwareBuild } from '@/lib/firmware/types'
import { readCheckpoint } from '@/lib/browser-pipeline/checkpoint'

// Small editable fixture; the project workflow also resolves catalogue ICs.
const SAMPLE_IR = JSON.stringify({
  components: [
    { ref_id: 'R1', part_class: 'resistor', value: '1k', package: '0402' },
    { ref_id: 'R2', part_class: 'resistor', value: '1k', package: '0402' },
  ],
  nets: [{ name: 'SIGNAL', connections: ['R1.2', 'R2.1'] }],
  constraints: { board_outline: { width_mm: 30, height_mm: 20 } },
}, null, 2)

type Result = {
  json: string
  pcbUrl: string
  schematicUrl: string
  errors: string[]
  traces: number
}

export default function BrowserComputeLab() {
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const [source, setSource] = useState(SAMPLE_IR)
  const [hydrated, setHydrated] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const urlsRef = useRef<string[]>([])
  const runIdRef = useRef(0)
  const [agentRequest, setAgentRequest] = useState('Outline a simple NE555 timer with passive components')
  const [agentState, setAgentState] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [agentMessage, setAgentMessage] = useState('')
  const [agentResult, setAgentResult] = useState<string | null>(null)
  const agentAbortRef = useRef<AbortController | null>(null)
  const [canResume, setCanResume] = useState(false)
  const recoveryKey = 'browser-compute-lab'
  useEffect(() => { readCheckpoint(recoveryKey).then((saved) => { if (saved) { setAgentRequest(saved.input.request); setCanResume(true) } }).catch(() => {}) }, [])
  const [firmwareSource, setFirmwareSource] = useState(JSON.stringify([{ filename: 'main.ino', code: 'void setup(){pinMode(13,OUTPUT);}\nvoid loop(){digitalWrite(13,HIGH);delay(1000);digitalWrite(13,LOW);delay(1000);}' }], null, 2))
  const [firmwareMessage, setFirmwareMessage] = useState('')
  const [firmwareBuild, setFirmwareBuild] = useState<FirmwareBuild | null>(null)
  const [compiling, setCompiling] = useState(false)
  const firmwareAbortRef = useRef<AbortController | null>(null)
  useEffect(() => () => { firmwareAbortRef.current?.abort() }, [])
  useEffect(() => () => { if (firmwareBuild?.download.url) URL.revokeObjectURL(firmwareBuild.download.url) }, [firmwareBuild])

  const clearUrls = () => {
    for (const url of urlsRef.current) URL.revokeObjectURL(url)
    urlsRef.current = []
  }

  const cancel = () => {
    runIdRef.current += 1
    cancelBrowserBoard()
    setState('idle')
    setMessage('Run cancelled')
  }

  useEffect(() => () => {
    runIdRef.current += 1
    cancelBrowserBoard()
    agentAbortRef.current?.abort()
    clearUrls()
  }, [])
  useEffect(() => setHydrated(true), [])

  const start = async () => {
    if (state === 'running') return
    if (!window.confirm('Run the PCB test on this computer? This browser tab will use CPU and memory for a few moments. Keep it open until the run finishes.')) return

    const runId = ++runIdRef.current
    clearUrls()
    setResult(null)
    setState('running')
    setMessage('Loading local PCB evaluator…')

    try {
      if (source.length > 100_000) throw new Error('PCB IR is too large for this browser test')
      const { circuitJson, pcbSvg, schematicSvg } = await runBrowserBoard(JSON.parse(source), (_stage, label) => {
        if (runId === runIdRef.current) setMessage(label)
      })
      if (runId !== runIdRef.current) return

      const errors = circuitJson.filter((item) => item.type.includes('error')).map((item) => item.type)
      const pcbUrl = URL.createObjectURL(new Blob([pcbSvg], { type: 'image/svg+xml' }))
      const schematicUrl = URL.createObjectURL(new Blob([schematicSvg], { type: 'image/svg+xml' }))
      urlsRef.current = [pcbUrl, schematicUrl]
      setResult({
        json: JSON.stringify(circuitJson, null, 2), pcbUrl, schematicUrl, errors,
        traces: circuitJson.filter((item) => item.type === 'pcb_trace').length,
      })
      setState('done')
      setMessage(errors.length ? 'Finished with design-rule errors' : 'Finished locally')
    } catch (error) {
      if (runId === runIdRef.current) {
        setState('error')
        setMessage(error instanceof Error ? error.message : 'Browser computation failed')
      }
    }
  }

  const downloadJson = () => {
    if (!result) return
    const url = URL.createObjectURL(new Blob([result.json], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'browser-pcb-test-circuit.json'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const startAgents = async (resume = false) => {
    if (agentAbortRef.current || !agentRequest.trim()) return
    if (!window.confirm('Run agents on this device? The tab will use CPU and memory. Groq model requests use your configured account and may use credits.')) return
    const controller = new AbortController()
    agentAbortRef.current = controller
    setAgentState('running')
    setAgentResult(null)
    setAgentMessage('Starting agents on this device…')
    try {
      const output = await runBrowserPipeline(agentRequest, [], (stage) => setAgentMessage(`Running ${stage} on this device…`), controller.signal, null, { key: recoveryKey, resume })
      setAgentResult(JSON.stringify(output, null, 2))
      setAgentMessage('Agents finished on this device')
      setAgentState('done')
    } catch (error) {
      setAgentMessage(error instanceof Error ? error.message : 'Agent run failed')
      setAgentState('error')
    } finally {
      agentAbortRef.current = null
      setCanResume(Boolean(await readCheckpoint(recoveryKey).catch(() => null)))
    }
  }

  const startCompiler = async () => {
    if (firmwareAbortRef.current) return
    const controller = new AbortController()
    firmwareAbortRef.current = controller
    setCompiling(true)
    setFirmwareBuild(null)
    try {
      const files = JSON.parse(firmwareSource)
      const build = await compileBrowserFirmware('uno', files, setFirmwareMessage, controller.signal)
      setFirmwareBuild(build)
      setFirmwareMessage(build.summary[0])
    } catch (error) { setFirmwareMessage(error instanceof Error ? error.message : 'Compilation failed') }
    finally { firmwareAbortRef.current = null; setCompiling(false) }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-6 py-12">
      <Link href="/workspace" className="text-sm text-muted-foreground underline">Back to workspace</Link>
      <div>
        <h1 className="text-2xl font-semibold">Browser PCB computation test</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Test local routing for 2–32 passive or catalogue-resolved parts and explicit or schema 2.0 nets. Exact pin and footprint data are required. Project chats use this same browser runtime and save their results privately.
        </p>
      </div>
      <label data-ready={hydrated} className="flex flex-col gap-2 text-sm font-medium">
        PCB IR for local test
        <textarea aria-label="PCB IR for local test" value={source} onChange={(event) => setSource(event.target.value)} rows={15} spellCheck={false} className="w-full rounded-md border bg-background p-3 font-mono text-xs" />
      </label>
      <div className="flex items-center gap-3">
        <button onClick={start} disabled={state === 'running'} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">
          Generate on this device
        </button>
        {state === 'running' && <button onClick={cancel} className="rounded-md border px-4 py-2 text-sm">Cancel</button>}
        <span role="status" aria-label="Board status" className="text-sm text-muted-foreground">{message}</span>
      </div>
      {result && (
        <>
          <p className="text-sm">{result.traces} routed trace{result.traces === 1 ? '' : 's'} · {result.errors.length} error{result.errors.length === 1 ? '' : 's'}</p>
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
            Prototype preview only. Zero reported errors does not make this board safe to fabricate.
          </p>
          <div className="grid gap-6 md:grid-cols-2">
            <section><h2 className="mb-2 font-medium">PCB</h2><img src={result.pcbUrl} alt="Test PCB layout" className="w-full rounded-md border bg-white" /></section>
            <section><h2 className="mb-2 font-medium">Schematic</h2><img src={result.schematicUrl} alt="Test schematic" className="w-full rounded-md border bg-white" /></section>
          </div>
          <button onClick={downloadJson} className="w-fit rounded-md border px-4 py-2 text-sm">Download circuit JSON</button>
        </>
      )}
      <section className="mt-6 flex flex-col gap-3 border-t pt-6">
        <h2 className="text-xl font-semibold">Browser agent execution test</h2>
        <p className="text-sm text-muted-foreground">Requires a signed-in account and the Node browser inference gateway. The agent stages run in a local worker; the model runs on Groq. This test does not save a project.</p>
        <label className="flex flex-col gap-2 text-sm">
          Agent request
          <textarea aria-label="Agent request" value={agentRequest} onChange={(event) => setAgentRequest(event.target.value)} rows={3} className="rounded-md border bg-background p-3" />
        </label>
        <div className="flex items-center gap-3">
          <button onClick={() => startAgents()} disabled={agentState === 'running' || !hydrated} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">Run browser agents</button>
          {canResume && agentState !== 'running' && <button onClick={() => startAgents(true)} className="rounded-md border px-4 py-2 text-sm">Resume browser agents</button>}
          {agentState === 'running' && <button onClick={() => agentAbortRef.current?.abort()} className="rounded-md border px-4 py-2 text-sm">Cancel agents</button>}
          <span role="status" aria-label="Agent status" className="text-sm">{agentMessage}</span>
        </div>
        {agentResult && <pre aria-label="Agent result" className="max-h-96 overflow-auto rounded-md border p-3 text-xs">{agentResult}</pre>}
      </section>
      <section className="mt-6 flex flex-col gap-3 border-t pt-6">
        <h2 className="text-xl font-semibold">Local firmware compiler</h2>
        <p className="text-sm text-muted-foreground">Uno/Nano ATmega328P C/C++ compilation uses a site-served WebAssembly compiler and linker in a worker. Generated code is compiled, and hardware upload requires a separate user action.</p>
        <textarea aria-label="Firmware source files" value={firmwareSource} onChange={(event) => setFirmwareSource(event.target.value)} rows={5} className="rounded-md border bg-background p-3 font-mono text-xs" />
        <div className="flex items-center gap-3">
          <button onClick={startCompiler} disabled={compiling || !hydrated} className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">Compile locally</button>
          {compiling && <button onClick={() => firmwareAbortRef.current?.abort()} className="rounded-md border px-4 py-2 text-sm">Cancel compiler</button>}
        </div>
        <pre role="status" aria-label="Firmware status" className="whitespace-pre-wrap text-sm">{firmwareMessage}</pre>
        {firmwareBuild?.download.url && <a href={firmwareBuild.download.url} download="firmware.hex" className="w-fit rounded-md border px-4 py-2 text-sm">Download HEX</a>}
      </section>
    </main>
  )
}
