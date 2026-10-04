'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ImageOff, Maximize, ZoomIn, ZoomOut } from 'lucide-react'

/** SVG stays in the browser's image context, where embedded scripts cannot run. */
export function ArtifactSvg({ src, label }: { src: string; label: string }) {
  const [error, setError] = useState(false)
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  useEffect(() => { setError(false); setScale(1); setOffset({ x: 0, y: 0 }) }, [src])
  const onWheel = useCallback((event: React.WheelEvent) => {
    event.preventDefault()
    setScale((value) => Math.min(12, Math.max(0.2, value * (event.deltaY < 0 ? 1.12 : 1 / 1.12))))
  }, [])

  if (error) return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <ImageOff className="h-8 w-8" /><p className="text-sm">Could not load the {label}.</p>
    </div>
  )

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div className="h-full w-full cursor-grab overflow-hidden active:cursor-grabbing" onWheel={onWheel}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          dragRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y }
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current
          if (drag) setOffset({ x: drag.ox + event.clientX - drag.x, y: drag.oy + event.clientY - drag.y })
        }}
        onPointerUp={() => { dragRef.current = null }} onPointerLeave={() => { dragRef.current = null }}>
        {/* SVG loaded as an image does not execute scripts or leak its styles. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={label} draggable={false} onError={() => setError(true)}
          className="h-full w-full object-contain"
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`, transformOrigin: 'center center' }} />
      </div>
      <div className="absolute bottom-4 right-4 flex overflow-hidden rounded-lg border border-border bg-background/90 backdrop-blur">
        <button onClick={() => setScale((value) => Math.min(12, value * 1.25))} className="flex h-8 w-9 items-center justify-center" title="Zoom in"><ZoomIn className="h-3.5 w-3.5" /></button>
        <button onClick={() => setScale((value) => Math.max(0.2, value / 1.25))} className="flex h-8 w-9 items-center justify-center" title="Zoom out"><ZoomOut className="h-3.5 w-3.5" /></button>
        <button onClick={() => { setScale(1); setOffset({ x: 0, y: 0 }) }} className="flex h-8 w-9 items-center justify-center" title="Fit"><Maximize className="h-3.5 w-3.5" /></button>
      </div>
    </div>
  )
}
