'use client'

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { saveMicroPythonFiles } from '@/lib/firmware/micropython'

export function MicroPythonPanel({ files, onClose }: { files: Array<{filename:string;code:string}>; onClose:()=>void }) {
  const [busy,setBusy]=useState(false)
  const [message,setMessage]=useState('')
  const abort=useRef<AbortController|null>(null)
  useEffect(()=>()=>abort.current?.abort(),[])
  const supported=typeof navigator!=='undefined' && 'serial' in navigator
  const upload=async()=>{
    if(busy || !supported) return
    if(!window.confirm('Save these Python files to the connected board? Existing files with these names will be replaced. The board must already run MicroPython.'))return
    setBusy(true)
    abort.current=new AbortController()
    try{
      const port=await navigator.serial.requestPort()
      await saveMicroPythonFiles(port,files,setMessage,abort.current.signal)
    }catch(error){setMessage(error instanceof Error?error.message:'Could not save firmware')}
    finally{abort.current=null;setBusy(false)}
  }
  return <aside className="flex w-[400px] shrink-0 flex-col gap-4 border-l p-5">
    <div className="flex items-center justify-between"><h3 className="font-semibold">MicroPython firmware</h3><Button variant="ghost" onClick={onClose}>Close</Button></div>
    <p className="text-sm text-muted-foreground">Save source directly to an ESP32 or RP2040 board already running MicroPython. Source is transferred over USB from this device.</p>
    {!supported && <p className="text-sm">Direct USB needs a browser with Web Serial support. Download the Python files from the editor to transfer them using your board tools.</p>}
    <Button onClick={upload} disabled={busy || !supported}>{busy?'Saving…':'Select board and save files'}</Button>
    {busy&&<Button variant="outline" onClick={()=>abort.current?.abort()}>Cancel upload</Button>}
    <pre role="status" className="whitespace-pre-wrap text-sm">{message}</pre>
  </aside>
}
