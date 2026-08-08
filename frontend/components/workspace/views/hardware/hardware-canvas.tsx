'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useEdgesState,
  useNodesState,
  useReactFlow,
  ReactFlowProvider,
  type OnSelectionChangeParams,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Braces, Check, Copy, Download, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { toast } from 'sonner'
import type { BusFlowEdge, HardwareFlowNode, HardwareSpec } from './types'
import { nodeTypes } from './hardware-nodes'
import { edgeTypes } from './bus-edge'
import { flowToSpec, minimapColor, specToFlow, toHardwareSpec } from './normalize'

const LEGEND = [
  { label: 'MCU / SoC', color: '#22d3ee' },
  { label: 'Sensor', color: '#34d399' },
  { label: 'Memory', color: '#a78bfa' },
  { label: 'Power', color: '#fbbf24' },
  { label: 'Comms', color: '#f472b6' },
]

/** Automatically centers & zooms the diagram when loaded or updated */
function AutoFitView({ spec }: { spec: HardwareSpec }) {
  const { fitView } = useReactFlow()

  useEffect(() => {
    const timer = setTimeout(() => {
      fitView({ padding: 0.2, duration: 400 })
    }, 80)
    return () => clearTimeout(timer)
  }, [spec, fitView])

  return null
}

function HardwareCanvasInner({ spec: initialSpec }: { spec: HardwareSpec }) {
  const [spec, setSpec] = useState<HardwareSpec>(initialSpec)
  const initial = useMemo(() => specToFlow(spec), [spec])
  const [nodes, setNodes, onNodesChange] = useNodesState<HardwareFlowNode>(initial.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<BusFlowEdge>(initial.edges)

  // Inspector state
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [draftError, setDraftError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Re-render graph whenever the spec changes
  useEffect(() => {
    const flow = specToFlow(spec)
    setNodes(flow.nodes)
    setEdges(flow.edges)
  }, [spec, setNodes, setEdges])

  useEffect(() => {
    setSpec(initialSpec)
  }, [initialSpec])

  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const onSelectionChange = useCallback(({ nodes: selected }: OnSelectionChangeParams) => {
    setSelectedIds((prev) => {
      const next = new Set(selected.map((n) => n.id))
      if (next.size === prev.size && [...next].every((id) => prev.has(id))) return prev
      return next
    })
  }, [])

  const displayEdges = useMemo(() => {
    const hasSelection = selectedIds.size > 0
    return edges.map((e) => {
      const active = hasSelection && (selectedIds.has(e.source) || selectedIds.has(e.target))
      return { ...e, data: { ...e.data!, active, dimmed: hasSelection && !active } }
    })
  }, [edges, selectedIds])

  const displayNodes = useMemo(() => {
    const hasSelection = selectedIds.size > 0
    return nodes.map((n) => {
      const connected =
        !hasSelection ||
        selectedIds.has(n.id) ||
        edges.some(
          (e) =>
            (e.source === n.id && selectedIds.has(e.target)) ||
            (e.target === n.id && selectedIds.has(e.source))
        )
      return { ...n, data: { ...n.data, dimmed: hasSelection && !connected } }
    })
  }, [nodes, edges, selectedIds])

  const currentJson = useCallback(() => JSON.stringify(flowToSpec(spec, nodes), null, 2), [spec, nodes])

  const openInspector = () => {
    setDraft(currentJson())
    setDraftError(null)
    setInspectorOpen(true)
  }

  const applyDraft = () => {
    try {
      const parsed = toHardwareSpec(JSON.parse(draft))
      setSpec(parsed)
      setDraftError(null)
      toast.success('Architecture updated from JSON')
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : 'Invalid JSON')
    }
  }

  const copyDraft = async () => {
    await navigator.clipboard.writeText(draft)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const downloadJson = () => {
    const blob = new Blob([currentJson()], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'hardware-spec.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="relative h-full w-full overflow-hidden bg-secondary/20">
      <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onSelectionChange={onSelectionChange}
        fitView
        fitViewOptions={{ padding: 0.2, includeHiddenNodes: false }}
        minZoom={0.2}
        maxZoom={1.75}
        proOptions={{ hideAttribution: true }}
        className="!bg-transparent"
      >
        <AutoFitView spec={spec} />
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} className="!bg-transparent opacity-60" />
        <Controls
          position="bottom-left"
          className="!rounded-lg !border !border-border !bg-background/90 !shadow-lg backdrop-blur [&>button]:!border-border [&>button]:!bg-transparent [&>button]:!text-foreground [&>button:hover]:!bg-secondary"
        />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeColor={minimapColor}
          maskColor="rgba(0,0,0,0.25)"
          className="!h-28 !w-40 !rounded-lg !border !border-border !bg-background/90 backdrop-blur"
        />
      </ReactFlow>

      {/* Top-left board meta */}
      <div className="pointer-events-none absolute left-4 top-4 select-none">
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
          {spec.meta?.name || 'System board'} {spec.meta?.revision ? `· ${spec.meta.revision}` : ''}
        </p>
        <div className="mt-2 flex flex-wrap gap-3">
          {LEGEND.map((l) => (
            <span key={l.label} className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-sm" style={{ background: l.color }} />
              {l.label}
            </span>
          ))}
        </div>
      </div>

      {/* Top-right actions */}
      <div className="absolute right-4 top-4 flex gap-2">
        <Button variant="outline" size="sm" className="h-8 rounded-lg bg-background/90 text-xs backdrop-blur" onClick={downloadJson}>
          <Download className="mr-1.5 h-3.5 w-3.5" />
          Export
        </Button>
        <Button variant="outline" size="sm" className="h-8 rounded-lg bg-background/90 text-xs backdrop-blur" onClick={openInspector}>
          <Braces className="mr-1.5 h-3.5 w-3.5" />
          JSON
        </Button>
      </div>

      {/* JSON Inspector drawer */}
      <Sheet open={inspectorOpen} onOpenChange={setInspectorOpen}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 border-border bg-background/95 backdrop-blur-xl sm:max-w-xl">
          <SheetHeader className="border-b border-border pb-4">
            <SheetTitle className="flex items-center gap-2 font-display text-xl">
              <Braces className="h-4 w-4" />
              Architecture JSON
            </SheetTitle>
            <SheetDescription className="font-mono text-[10px] uppercase tracking-[0.18em]">
              Inspect or edit the board live — Apply re-renders the canvas
            </SheetDescription>
          </SheetHeader>
          <textarea
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              setDraftError(null)
            }}
            spellCheck={false}
            className="mt-4 flex-1 resize-none rounded-lg border border-border bg-secondary/30 p-3 font-mono text-[11px] leading-relaxed text-foreground outline-none focus:border-foreground/30"
          />
          {draftError && (
            <p className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 font-mono text-[10px] text-destructive">
              {draftError}
            </p>
          )}
          <div className="mt-4 flex items-center gap-2">
            <Button size="sm" className="rounded-lg text-xs" onClick={applyDraft}>
              <Check className="mr-1.5 h-3.5 w-3.5" />
              Apply
            </Button>
            <Button variant="outline" size="sm" className="rounded-lg text-xs" onClick={copyDraft}>
              {copied ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto rounded-lg text-xs text-muted-foreground"
              onClick={() => {
                setDraft(currentJson())
                setDraftError(null)
              }}
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Reset
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}

export function HardwareCanvas(props: { spec: HardwareSpec }) {
  return (
    <ReactFlowProvider>
      <HardwareCanvasInner {...props} />
    </ReactFlowProvider>
  )
}
