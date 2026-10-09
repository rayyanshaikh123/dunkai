'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Loader2, AlertCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/lib/auth-context'

function AuthCallbackContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { refreshUser } = useAuth()
  const [error, setError] = useState('')

  useEffect(() => {
    const handleCallback = async () => {
      const success = searchParams.get('success')
      const errorParam = searchParams.get('error')

      if (errorParam) {
        setError(errorParam === 'no_code' ? 'Authentication failed: no code received.' : `Authentication error: ${errorParam}`)
        return
      }

      if (success === 'true') {
        // The backend already set auth cookies during the redirect
        // Refresh the user state and go to workspace
        await refreshUser()
        const verificationEmail = searchParams.get('verify_email')
        router.push(verificationEmail
          ? `/verify-email?email=${encodeURIComponent(verificationEmail)}&reason=google`
          : '/workspace')
      } else {
        setError('Authentication failed. Please try again.')
      }
    }

    handleCallback()
  }, [searchParams, router, refreshUser])

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <div className="w-full max-w-md text-center">
          <div className="mb-6 flex justify-center">
            <AlertCircle className="h-12 w-12 text-destructive" />
          </div>
          <h1 className="mb-3 font-display text-3xl">Authentication Failed</h1>
          <p className="mb-8 text-sm text-muted-foreground">{error}</p>
          <Button onClick={() => router.push('/login')} className="h-12 rounded-xl bg-foreground text-background hover:bg-foreground/90">
            Back to sign in
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-center">
        <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
        <p className="mt-4 text-sm text-muted-foreground">Completing authentication...</p>
      </div>
    </div>
  )
}

function CallbackFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-center">
        <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
        <p className="mt-4 text-sm text-muted-foreground">Completing authentication...</p>
      </div>
    </div>
  )
}

export default function AuthCallbackPage() {
  // useSearchParams requires a Suspense boundary for static prerendering
  return (
    <Suspense fallback={<CallbackFallback />}>
      <AuthCallbackContent />
    </Suspense>
  )
}
