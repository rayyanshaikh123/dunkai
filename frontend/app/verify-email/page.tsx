'use client'

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { AuthShell } from '@/components/auth/auth-shell'
import { Button } from '@/components/ui/button'
import { authApi } from '@/lib/api'

function VerifyEmailContent() {
  const params = useSearchParams()
  const token = params.get('token') || ''
  const email = params.get('email') || ''
  const [status, setStatus] = useState<'waiting' | 'checking' | 'verified' | 'error'>(token ? 'checking' : 'waiting')
  const [message, setMessage] = useState('')
  const [resending, setResending] = useState(false)

  useEffect(() => {
    if (!token) return
    authApi.verifyEmail(token).then(() => setStatus('verified')).catch((error) => {
      setMessage(error instanceof Error ? error.message : 'This verification link is invalid or expired.')
      setStatus('error')
    })
  }, [token])

  const resend = async () => {
    if (!email) return
    setResending(true)
    try {
      await authApi.resendVerification(email)
      setMessage('A new verification link has been sent if this account needs one.')
      setStatus('waiting')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not send a new link.')
    } finally {
      setResending(false)
    }
  }

  return (
    <AuthShell eyebrow="Account verification" title={status === 'verified' ? 'Email verified' : 'Verify your email'}
      description={status === 'verified' ? 'Your trial credits and hosted chat allowance are now available when billing is enabled.' : 'Open the link sent to your email. It expires after 24 hours.'}>
      <div className="space-y-4 text-sm">
        {status === 'checking' && <p className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Verifying…</p>}
        {message && <p className="rounded-xl bg-secondary p-3">{message}</p>}
        {status === 'verified' ? (
          <Button className="w-full" onClick={() => window.location.assign('/workspace')}>Continue to workspace</Button>
        ) : (
          <>
            {email && <Button type="button" variant="outline" className="w-full" disabled={resending} onClick={resend}>{resending ? 'Sending…' : 'Resend verification email'}</Button>}
            <Button asChild variant="ghost" className="w-full"><Link href="/login">Back to login</Link></Button>
          </>
        )}
      </div>
    </AuthShell>
  )
}

export default function VerifyEmailPage() {
  return <Suspense fallback={<div className="flex min-h-screen items-center justify-center"><Loader2 className="h-8 w-8 animate-spin" /></div>}><VerifyEmailContent /></Suspense>
}
