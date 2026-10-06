'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Box,
  CircuitBoard,
  Download,
  Layers2,
  Maximize2,
  Minimize2,
  Waypoints,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { toast } from 'sonner'
import { KiCanvasViewer } from './pcb/kicanvas-viewer'
import { Board3D } from './pcb/board-3d'
import { SAMPLE_BOARD, SAMPLE_BOARD_NAME } from './pcb/sample-board'
import { ArtifactSvg } from './pcb/artifact-svg'
import { BoardGltf } from './pcb/board-gltf'
import { useWorkspaceStore } from '@/lib/store'
import { useBoardGeneration } from '@/hooks/use-board-generation'

type Pane = 'schematic' | 'pcb' | '3d'

const PANES: Array<{ id: Pane; label: string; icon: typeof Layers2 }> = [
  { id: 'schematic', label: 'Schematic', icon: Waypoints },
  { id: 'pcb', label: 'PCB', icon: Layers2 },
  { id: '3d', label: '3D', icon: Box },
]

const formatBytes = (n?: number) => {
  if (!n || n <= 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

const DOWNLOADS: Array<{ key: string; label: string }> = [
  { key: 'circuitJson', label: 'Circuit JSON' },
  { key: 'schematicSvg', label: 'Schematic SVG' },
  { key: 'pcbSvg', label: 'PCB SVG' },
  { key: 'boardGlb', label: '3D model (.glb)' },
  { key: 'bomCsv', label: 'Bill of materials (.csv)' },
  { key: 'pickAndPlaceCsv', label: 'Pick and place (.csv)' },
  { key: 'designBrief', label: 'Design brief (.md)' },
  { key: 'resolution', label: 'Component resolution (.json)' },
]

export function PcbView({ projectId }: { projectId?: string } = {}) {
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId)
  const activeChatId = useWorkspaceStore((s) => s.activeChatId)
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab)
  // Display only. The board is generated automatically when the chat pipeline
  // hands off (see chat-interface.tsx); the manual re-run lives on the BOM tab,
  // next to the components it is built from.
  const { board, job, componentCount, cancel } = useBoardGeneration(projectId ?? activeProjectId, activeChatId)

  const [pane, setPane] = useState<Pane>('pcb')
  const [showSample, setShowSample] = useState(false)
  // The sample board is a .kicad_pcb, so it keeps the original viewers:
  // KiCanvas for 2D and board-3d.tsx's s-expression renderer for 3D. Generated
  // boards are tscircuit artifacts and take the SVG / glTF path instead.
  const [sampleView, setSampleView] = useState<'2d' | '3d'>('2d')

  const containerRef = useRef<HTMLDivElement>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    const onChange = () => setIsFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFullscreen = useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else await containerRef.current?.requestFullscreen()
    } catch {
      toast.error('Fullscreen is not available in this browser')
    }
  }, [])

  const stats = board?.stats
  const drcErrors = stats?.errors ?? 0

  // Open connections, one line per part: "U7 HDSP-521G: asked for SPI · supports GPIO".
  const mismatches = stats?.mismatches ?? []
  const openParts = useMemo(() => {
    const byRef = new Map<string, { ref: string; part: string; asked: string[]; supports: string }>()
    for (const m of mismatches) {
      const entry = byRef.get(m.ref_id) ?? { ref: m.ref_id, part: m.part_number, asked: [], supports: m.supports.join(', ') }
      if (!entry.asked.includes(m.interface)) entry.asked.push(m.interface)
      byRef.set(m.ref_id, entry)
    }
    return [...byRef.values()]
  }, [mismatches])

  const setPendingPrompt = useWorkspaceStore((s) => s.setPendingPrompt)
  const setPendingAction = useWorkspaceStore((s) => s.setPendingAction)
  const pipelineRun = useWorkspaceStore((s) => s.pipelineRun)
  // Re-runs architecture -> components -> PCB handoff with these constraints
  // (supervisor action revise_interfaces), then rebuilds the board.
  const fixConnections = useCallback(() => {
    setPendingAction('revise_interfaces')
    setPendingPrompt(
      `Fix the ${openParts.length === 1 ? 'connection' : 'connections'} the board could not build: ` +
        openParts.map((p) => `${p.ref} (${p.part}) asked for ${p.asked.join('/')}`).join('; ') +
        ' — use interfaces the parts actually support.'
    )
    setActiveTab('chat')
  }, [openParts, setPendingAction, setPendingPrompt, setActiveTab])

  const available = useMemo(
    () => DOWNLOADS.filter((d) => board?.urls?.[d.key as keyof typeof board.urls]),
    [board]
  )

  // ---- generating -----------------------------------------------------------
  if (job.status === 'running') {
    return (
      <div className="force-dark dark flex h-full w-full flex-col items-center justify-center bg-[#131318] px-6 text-foreground">
        <div className="w-full max-w-md">
          <div className="mb-6 flex items-center gap-3">
            <img src="/kevin.webp" alt="" className="h-12 w-auto shrink-0" />
            <div className="min-w-0">
              <p className="truncate text-sm">{job.label ?? 'Generating board…'}</p>
              {job.detail && (
                <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{job.detail}</p>
              )}
            </div>
          </div>

          <div className="max-h-64 overflow-auto rounded-lg border border-border bg-background/40 p-3">
            {job.log.slice(-14).map((entry, i) => (
              <div key={i} className="flex gap-2 py-0.5 font-mono text-[10px] leading-relaxed">
                <span className="w-4 shrink-0 text-muted-foreground/60">{entry.stage ?? '·'}</span>
                <span className="text-muted-foreground">{entry.label}</span>
                {entry.detail && <span className="truncate text-muted-foreground/60">— {entry.detail}</span>}
              </div>
            ))}
          </div>
          {process.env.NEXT_PUBLIC_BROWSER_PCB_ENABLED === 'true' && (
            <Button variant="outline" size="sm" className="mt-4" onClick={cancel}>Cancel on this device</Button>
          )}
        </div>
      </div>
    )
  }

  // ---- no board yet ---------------------------------------------------------
  if (!board) {
    if (showSample) {
      return (
        <div
          ref={containerRef}
          className="force-dark dark relative h-full w-full overflow-hidden bg-[#131318] text-foreground"
        >
          {sampleView === '2d' ? (
            <KiCanvasViewer source={SAMPLE_BOARD} name={SAMPLE_BOARD_NAME} type="board" controls="full" />
          ) : (
            <Board3D source={SAMPLE_BOARD} />
          )}
          <div className="absolute left-4 top-4 flex flex-col gap-2">
            <p className="pointer-events-none select-none font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Sample board · not your design
            </p>
            <div className="flex gap-2">
              <div className="flex overflow-hidden rounded-lg border border-border bg-background/90 backdrop-blur">
                {(['2d', '3d'] as const).map((v) => (
                  <button
                    key={v}
                    onClick={() => setSampleView(v)}
                    className={`flex h-8 items-center gap-1.5 px-3 text-xs uppercase transition-colors ${
                      sampleView === v ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {v === '2d' ? <Layers2 className="h-3.5 w-3.5" /> : <Box className="h-3.5 w-3.5" />}
                    {v}
                  </button>
                ))}
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-8 w-fit rounded-lg bg-background/90 text-xs backdrop-blur"
                onClick={() => setShowSample(false)}
              >
                Back
              </Button>
            </div>
          </div>
        </div>
      )
    }

    return (
      <div className="force-dark dark flex h-full w-full flex-col items-center justify-center gap-4 bg-[#131318] px-6 text-center text-muted-foreground">
        <CircuitBoard className="h-10 w-10 opacity-40" />
        {job.status === 'error' ? (
          <>
            <p className="max-w-md text-sm text-foreground">Board generation failed.</p>
            <p className="max-w-lg font-mono text-[10px] leading-relaxed">{job.error}</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2 rounded-lg text-xs"
              onClick={() => setActiveTab('bom')}
            >
              Retry from BOM
            </Button>
          </>
        ) : componentCount > 0 ? (
          <>
            <p className="max-w-md text-sm">
              {componentCount} component{componentCount === 1 ? '' : 's'} are ready, but no board has been
              generated from them yet.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-1 rounded-lg text-xs"
              onClick={() => setActiveTab('bom')}
            >
              Generate from BOM
            </Button>
          </>
        ) : (
          <>
            <p className="max-w-md text-sm">
              Run the AI pipeline from the Chat tab, then generate the board from the BOM tab.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-1 rounded-lg text-xs"
              onClick={() => setActiveTab('chat')}
            >
              Go to Chat
            </Button>
          </>
        )}
        <button
          onClick={() => setShowSample(true)}
          className="mt-4 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground/60 underline-offset-4 transition-colors hover:text-muted-foreground hover:underline"
        >
          View sample board
        </button>
      </div>
    )
  }

  // ---- real board -----------------------------------------------------------
  const urls = board.urls

  return (
    <div
      ref={containerRef}
      className="force-dark dark relative h-full w-full overflow-hidden bg-[#131318] text-foreground"
    >
      {pane === 'schematic' && urls.schematicSvg && (
        <ArtifactSvg src={urls.schematicSvg} label="schematic" />
      )}
      {pane === 'pcb' && urls.pcbSvg && <ArtifactSvg src={urls.pcbSvg} label="PCB layout" />}
      {pane === '3d' &&
        (urls.boardGlb ? (
          <BoardGltf src={urls.boardGlb} />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-muted-foreground">
            <Box className="h-8 w-8 opacity-40" />
            <p className="text-sm">No 3D model was produced for this board.</p>
          </div>
        ))}

      {/* Top-left meta + controls — the viewers own the rest of the surface */}
      <div className="absolute left-4 top-4 flex flex-col gap-2">
        <p className="pointer-events-none select-none font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          {board.verified === false ? 'Unverified browser preview' : 'Design artifact / PCB'} · {board.design_name ?? 'board'}
          {stats?.components ? ` · ${stats.components} parts` : ''}
          {stats?.traces ? ` · ${stats.traces} traces` : ''}
        </p>

        <div className="flex flex-wrap gap-2">
          <div className="flex overflow-hidden rounded-lg border border-border bg-background/90 backdrop-blur">
            {PANES.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setPane(id)}
                className={`flex h-8 items-center gap-1.5 px-3 text-xs transition-colors ${
                  pane === id ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 rounded-lg bg-background/90 text-xs backdrop-blur"
              >
                <Download className="mr-1.5 h-3.5 w-3.5" />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="border-border bg-background/95 backdrop-blur-xl">
              <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                {board.verified === false ? 'Preview files' : 'Manufacturing outputs'}
              </DropdownMenuLabel>
              <DropdownMenuSeparator className="bg-border" />
              {available.map(({ key, label }) => (
                <DropdownMenuItem key={key} asChild className="cursor-pointer text-sm">
                  <a href={urls[key as keyof typeof urls]} download>
                    <span className="flex-1">{label}</span>
                    <span className="ml-3 font-mono text-[10px] text-muted-foreground">
                      {formatBytes(board.sizes?.[key])}
                    </span>
                  </a>
                </DropdownMenuItem>
              ))}
              {/* Fabrication export stays blocked until independent checks and approval. */}
            </DropdownMenuContent>
          </DropdownMenu>

          <Button
            variant="outline"
            size="sm"
            className="h-8 rounded-lg bg-background/90 text-xs backdrop-blur"
            onClick={toggleFullscreen}
          >
            {isFullscreen ? (
              <Minimize2 className="mr-1.5 h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="mr-1.5 h-3.5 w-3.5" />
            )}
            {isFullscreen ? 'Exit' : 'Fullscreen'}
          </Button>
        </div>

        {/* A board that built WITH DRC errors is still shown — the layout is how
            you see what went wrong — but it is never shown as if it were clean. */}
        {board.verified === false && (
          <div className="w-fit rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-foreground">
            Pins, footprints, electrical behavior, and fabrication have not been independently verified.
          </div>
        )}
        {drcErrors > 0 && (
          <div className="flex w-fit items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
            <div className="text-[11px] leading-relaxed">
              <p className="text-foreground">
                {drcErrors} design-rule error{drcErrors === 1 ? '' : 's'} — not ready to fabricate
              </p>
              {stats?.errorTypes?.length ? (
                <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                  {stats.errorTypes.slice(0, 3).join(', ')}
                </p>
              ) : null}
            </div>
          </div>
        )}

        {/* Connections the architecture asked for that the chosen parts cannot do
            (a display on SPI). Left open on purpose — a guessed pin could short a
            rail — and offered back to the agents to redesign around. */}
        {mismatches.length > 0 && (
          <div className="w-full max-w-md rounded-lg border border-amber-500/30 bg-background/95 px-3 py-2.5 backdrop-blur">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
              <div className="min-w-0 flex-1 text-[11px] leading-relaxed">
                <p className="text-foreground">
                  {mismatches.length} connection{mismatches.length === 1 ? '' : 's'} left open — the part
                  {openParts.length === 1 ? ' does' : 's do'} not have that interface
                </p>
                <ul className="mt-1 space-y-0.5 text-muted-foreground">
                  {openParts.slice(0, 4).map((p) => (
                    <li key={p.ref}>
                      <span className="font-mono text-foreground/80">{p.ref}</span> {p.part}: asked for{' '}
                      {p.asked.join(', ')} · supports {p.supports}
                    </li>
                  ))}
                  {openParts.length > 4 && <li>…and {openParts.length - 4} more</li>}
                </ul>
                <Button
                  size="sm"
                  onClick={fixConnections}
                  // A board job never reaches here (the view shows its log instead).
                  disabled={pipelineRun === 'running'}
                  className="mt-2 h-7 rounded-full px-3 text-[11px]"
                >
                  Fix connections
                </Button>
              </div>
            </div>
          </div>
        )}

        {(stats?.unresolvedComponents ?? 0) > 0 && (
          <p className="w-fit rounded-lg border border-border bg-background/90 px-3 py-1.5 text-[11px] text-muted-foreground backdrop-blur">
            {stats?.unresolvedComponents} component
            {stats?.unresolvedComponents === 1 ? '' : 's'} could not be resolved and were omitted
          </p>
        )}
      </div>
    </div>
  )
}
