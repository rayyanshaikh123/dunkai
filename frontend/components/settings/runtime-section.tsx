'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { runtimeApi } from '@/lib/api'
import { toast } from 'sonner'

export function RuntimeSection() {
  const queryClient = useQueryClient()
  const devices = useQuery({ queryKey: ['runtime', 'devices'], queryFn: runtimeApi.devices, refetchInterval: 5000 })
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['runtime'] })
    queryClient.invalidateQueries({ queryKey: ['ai', 'providers'] })
  }
  const perform = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true)
    try { await action(); toast.success(message); refresh() }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Could not connect your computer') }
    finally { setBusy(false) }
  }
  const download = async () => {
    setBusy(true)
    try {
      const blob = await runtimeApi.download()
      const url = URL.createObjectURL(blob), link = document.createElement('a')
      link.href = url; link.download = 'dunkai-runtime.zip'; link.click()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Download failed') }
    finally { setBusy(false) }
  }
  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">Allow DunkAI to use your computer for design generation. The original agents and PCB tools run locally while models are accessed through Groq. Keep the runtime open during generation.</p>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li>Install and start Docker on Windows, macOS, or Linux.</li>
        <li>Download and extract the runtime. Follow the included <span className="font-mono">docs/LOCAL_RUNTIME.md</span> setup guide, set your backend URL, then run the launcher for your OS.</li>
        <li>Enter the pairing code shown in the runtime window below. Pairing authorizes this computer to process your account’s designs.</li>
      </ol>
      <Button variant="outline" disabled={busy} onClick={download}>Download local runtime</Button>
      <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); perform(() => runtimeApi.approve(code.trim()).then(() => setCode('')), 'Computer authorized. Wait for it to become ready.'); }}>
        <Input aria-label="Computer pairing code" placeholder="ABCDE-12345" value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} maxLength={11} className="max-w-60 font-mono" autoComplete="off" />
        <Button type="submit" disabled={busy || !/^[A-F0-9]{5}-?[A-F0-9]{5}$/.test(code)}>Connect this computer</Button>
      </form>
      {devices.isError && <p role="alert" className="text-sm text-destructive">Could not load connected computers. Refresh to try again.</p>}
      <div className="space-y-2" aria-live="polite">
        {devices.data?.devices.map((device) => (
          <div key={device.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4">
            <div><p className="font-medium">{device.name}{device.preferred ? ' · Default' : ''}</p><p className="text-sm text-muted-foreground">{device.connected ? device.ready ? 'Ready' : 'Starting AI engine…' : 'Offline — start the runtime'} · {device.mode === 'byok' ? 'Your Groq key' : 'Hosted Groq'} · Paired until {new Date(device.expiresAt).toLocaleDateString()}</p></div>
            <div className="flex gap-2">
              {!device.preferred && <Button size="sm" variant="outline" disabled={busy} onClick={() => perform(() => runtimeApi.prefer(device.id), 'Default computer updated')}>Use by default</Button>}
              <Button size="sm" variant="outline" disabled={busy} onClick={() => perform(() => runtimeApi.revoke(device.id), 'Computer disconnected')}>Disconnect</Button>
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">Create unlimited chats. Local computation uses 0 credits; hosted model calls cost 2 credits per successful call from your free or purchased balance. For BYOK, set your Groq key in the local runtime configuration; it stays on your computer. You can view projects on mobile while a paired computer processes them.</p>
    </div>
  )
}
