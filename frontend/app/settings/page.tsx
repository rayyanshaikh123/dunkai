'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  BadgeCheck,
  CircuitBoard,
  Gauge,
  KeyRound,
  Laptop,
  Loader2,
  Moon,
  Palette,
  Sun,
  Trash2,
  User as UserIcon,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ProtectedRoute } from '@/components/layouts/protected-route'
import { ProviderPicker } from '@/components/workspace/provider-picker'
import { accountApi, aiApi, billingApi, type ApiKeyStatus, type ByokProvider } from '@/lib/api'
import {
  BOARD_PROVIDERS,
  DEFAULT_BOARD_PROVIDER,
  hasStoredBoardProvider,
  readStoredBoardProvider,
  writeStoredBoardProvider,
  type BoardProviderId,
} from '@/lib/providers'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { CREDIT_PACK_COPY } from '@/lib/plans'
import { RuntimeSection } from '@/components/settings/runtime-section'

const KEY_PLACEHOLDERS: Record<ByokProvider, string> = {
  openai: 'sk-proj-…',
  groq: 'gsk_…',
  gemini: 'AIza…',
  anthropic: 'sk-ant-…',
}

function Section({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof KeyRound
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section className="shadow-soft rounded-[28px] border border-border bg-card p-6 sm:p-8">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-secondary">
          <Icon className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="mt-6">{children}</div>
    </section>
  )
}

function UsageCard() {
  const queryClient = useQueryClient()
  const usage = useQuery({ queryKey: ['billing', 'usage'], queryFn: billingApi.usage })
  const plans = useQuery({ queryKey: ['billing', 'plans'], queryFn: billingApi.plans, staleTime: 5 * 60_000 })
  const [buying, setBuying] = useState<string | null>(null)
  const [buyError, setBuyError] = useState<string | null>(null)

  if (usage.isLoading) return <div className="h-24 animate-pulse rounded-2xl bg-secondary" />
  if (!usage.data) return <p className="text-sm text-muted-foreground">Usage is unavailable right now.</p>

  const { wallet, billingEnabled, meteringEnabled, period } = usage.data
  const buy = async (packId: string) => {
    setBuying(packId)
    setBuyError(null)
    try {
      const checkout = await billingApi.checkout(packId)
      window.location.assign(checkout.url)
    } catch (error) {
      setBuyError(error instanceof Error ? error.message : 'Could not start checkout')
      setBuying(null)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground">Prepaid credits</span>
          <span className="text-xs text-muted-foreground">Free chats for {period} (UTC)</span>
        </div>
        <Button variant="outline" size="sm" onClick={() => queryClient.invalidateQueries({ queryKey: ['billing', 'usage'] })}>Refresh balance</Button>
      </div>

      {meteringEnabled ? (
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-2xl bg-secondary p-4"><p className="text-xs text-muted-foreground">Available credits</p><p className="mt-1 text-2xl font-semibold">{wallet.available}</p></div>
            <div className="rounded-2xl bg-secondary p-4"><p className="text-xs text-muted-foreground">Trial / paid</p><p className="mt-1 text-lg font-semibold">{wallet.trialAvailable} / {wallet.paidAvailable}</p></div>
            <div className="rounded-2xl bg-secondary p-4"><p className="text-xs text-muted-foreground">{plans.data?.localRuntimeEnabled ? 'Free hosted model calls' : 'Free design chats'}</p><p className="mt-1 text-lg font-semibold">{wallet.freeChatsUsed} / {wallet.freeChatsLimit} used</p></div>
          </div>
          <p className="text-sm text-muted-foreground">{wallet.reserved} credits reserved for running jobs. Credits are ₹1 of prepaid value and do not expire.</p>
          {!plans.data?.localRuntimeEnabled && <p className="text-sm text-muted-foreground">Each free chat includes its requirements interview, one complete pipeline, and one PCB generation. Failed attempts can be retried without spending the included run.</p>}
          {plans.data?.billingMode === 'test' && <p className="text-sm text-muted-foreground">Stripe is in test mode. Checkout uses test cards and does not collect real money.</p>}
          <div className="grid gap-3 sm:grid-cols-3">
            {CREDIT_PACK_COPY.map((pack) => (
              <Button key={pack.id} variant="outline" disabled={!billingEnabled || buying !== null || !plans.data?.packs.some((p) => p.id === pack.id && p.amountPaise === pack.rupees * 100)} onClick={() => buy(pack.id)}>
                {buying === pack.id ? 'Opening checkout…' : `${pack.credits} credits · ₹${pack.rupees}`}
              </Button>
            ))}
          </div>
          {buyError && <p className="text-sm text-destructive">{buyError}</p>}
          {!billingEnabled && <p className="text-sm text-muted-foreground">Credit purchases are closed. Your included free allowance is still available.</p>}
          <p className="text-xs text-muted-foreground">Payment confirmation updates your balance through Stripe; returning from checkout alone does not add credits.</p>
        </div>
      ) : (
        <p className="rounded-2xl bg-secondary px-4 py-3 text-sm text-muted-foreground">
          Billing is off on this server. Credit purchases are unavailable.
        </p>
      )}
    </div>
  )
}

function KeyRow({ status }: { status: ApiKeyStatus }) {
  const queryClient = useQueryClient()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['account', 'keys'] })
    queryClient.invalidateQueries({ queryKey: ['ai', 'providers'] })
  }

  const save = useMutation({
    mutationFn: () => accountApi.saveKey(status.provider, draft.trim()),
    onSuccess: (saved) => {
      setDraft('')
      setError(null)
      toast.success(`${saved.label} key verified and saved`)
      refresh()
    },
    onError: (err: Error) => setError(err.message),
  })

  const remove = useMutation({
    mutationFn: () => accountApi.removeKey(status.provider),
    onSuccess: () => {
      toast.success(`${status.label} key removed`)
      refresh()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  return (
    <div className="rounded-2xl border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{status.label}</p>
          <p className="text-xs text-muted-foreground">Powers: {status.powers}</p>
        </div>
        {status.configured && (
          <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-xs font-medium">
            <BadgeCheck className="h-3.5 w-3.5 text-[#36b37e]" />
            Verified
            {status.verifiedAt ? ` ${new Date(status.verifiedAt).toLocaleDateString()}` : ''}
          </span>
        )}
      </div>

      {status.configured ? (
        <div className="mt-3 flex items-center gap-2">
          <div className="flex h-10 flex-1 items-center rounded-xl bg-secondary px-3 font-mono text-sm text-muted-foreground">
            {status.masked}
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove ${status.label} key`}
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
            className="h-10 w-10 rounded-xl text-destructive hover:bg-destructive/10"
          >
            {remove.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          </Button>
        </div>
      ) : (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (draft.trim()) save.mutate()
          }}
        >
          <label htmlFor={`key-${status.provider}`} className="sr-only">
            {status.label} API key
          </label>
          <Input
            id={`key-${status.provider}`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              setError(null)
            }}
            placeholder={KEY_PLACEHOLDERS[status.provider]}
            aria-invalid={Boolean(error)}
            className="h-10 rounded-xl font-mono text-sm"
          />
          <Button type="submit" disabled={!draft.trim() || save.isPending} className="h-10 rounded-xl">
            {save.isPending ? (
              <>
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                Verifying
              </>
            ) : (
              'Save'
            )}
          </Button>
        </form>
      )}
      {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
    </div>
  )
}

function SettingsContent() {
  const router = useRouter()
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  const providers = useQuery({ queryKey: ['ai', 'providers'], queryFn: aiApi.providers })
  const keys = useQuery({ queryKey: ['account', 'keys'], queryFn: accountApi.listKeys, enabled: Boolean(providers.data && !providers.data.localRuntimeEnabled) })

  // Hydrated in an effect: the stored choice only exists on the client, and
  // reading it during render would make the first paint disagree with the server's.
  const [boardProvider, setBoardProvider] = useState<BoardProviderId>(DEFAULT_BOARD_PROVIDER)
  const [hasChoice, setHasChoice] = useState(false)
  useEffect(() => {
    setMounted(true)
    setBoardProvider(readStoredBoardProvider())
    setHasChoice(hasStoredBoardProvider())
    // Earlier builds kept "BYOK" keys here in plaintext, and nothing ever read
    // them. Keys now live encrypted on the server; drop the stale copies.
    try {
      window.localStorage.removeItem('dunkai-byok-keys')
    } catch {
      // Storage blocked: nothing was stored there either.
    }
  }, [])

  const changeBoardProvider = (next: BoardProviderId) => {
    setBoardProvider(next)
    setHasChoice(true)
    writeStoredBoardProvider(next)
    toast.success('Board generation model updated')
  }

  const status = Object.fromEntries((providers.data?.boardProviders ?? []).map((p) => [p.id, p]))
  const serverDefault = BOARD_PROVIDERS.find((p) => p.provider === providers.data?.defaultBoardProvider)
  const shown = hasChoice ? BOARD_PROVIDERS.find((p) => p.id === boardProvider) : serverDefault
  const shownStatus = shown ? status[shown.provider] : undefined

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="page-wash pointer-events-none fixed inset-0 -z-10" aria-hidden />

      <header className="mx-auto flex max-w-3xl items-center justify-between px-4 py-5 sm:px-6">
        <Link href="/" className="flex items-center gap-2">
          <Image src="/logo.png" alt="" width={30} height={24} className="h-6 w-auto [image-rendering:pixelated]" />
          <span className="text-[17px] font-semibold tracking-tight">DunkAI</span>
        </Link>
        <Button variant="ghost" size="sm" onClick={() => router.push('/workspace')} className="rounded-full">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to workspace
        </Button>
      </header>

      <main className="mx-auto max-w-3xl space-y-5 px-4 pb-16 pt-4 sm:px-6">
        <div className="pb-2">
          <h1 className="text-4xl font-semibold tracking-[-0.03em]">Settings</h1>
          <p className="mt-2 text-muted-foreground">Your credits, API keys, and how DunkAI looks.</p>
        </div>

        <Section icon={Gauge} title="Credits & usage" description="Free hosted chats, prepaid credits, and compute charges for longer jobs.">
          <UsageCard />
        </Section>

        {providers.data?.localRuntimeEnabled && (
          <Section icon={Laptop} title="This computer" description="Connect your computer to run the original design agents and PCB generator."><RuntimeSection /></Section>
        )}

        {!providers.data?.localRuntimeEnabled && <Section
          icon={KeyRound}
          title="Your API keys"
          description="Verified with the provider when you save, encrypted at rest, and never shown again in full."
        >
          <div className="space-y-3">
            {keys.isLoading && <div className="h-28 animate-pulse rounded-2xl bg-secondary" />}
            {keys.isError && <p className="text-sm text-destructive">Could not load your keys. Try refreshing.</p>}
            {keys.data?.map((k) => <KeyRow key={k.provider} status={k} />)}
          </div>
          {providers.data && (
            <p className="mt-4 text-sm text-muted-foreground">
              Choose GPT-4.1 or GPT-4.1 mini in the chat model picker to use your OpenAI key for the full design pipeline.
              {' '}Groq models use {providers.data.chat.byok ? 'your Groq key' : 'DunkAI’s hosted Groq key'}.
            </p>
          )}
        </Section>}

        {!providers.data?.localRuntimeEnabled && <Section
          icon={CircuitBoard}
          title="Board generation model"
          description="Which model lays out the PCB once the pipeline hands off a design."
        >
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {shown?.label ?? 'Server default'}
                {!hasChoice && <span className="ml-2 text-xs font-normal text-muted-foreground">(server default)</span>}
              </p>
              <p className="mt-0.5 text-sm text-muted-foreground">{shown?.hint ?? 'Applies to the next run.'}</p>
              {shownStatus && !shownStatus.available && (
                <p className="mt-1 text-sm text-destructive">Unavailable: {shownStatus.reason}. Pick another model or add a key above.</p>
              )}
            </div>
            <ProviderPicker
              value={hasChoice ? boardProvider : (serverDefault?.id ?? boardProvider)}
              onChange={changeBoardProvider}
              status={providers.data ? status : undefined}
              className="w-[210px] rounded-xl"
            />
          </div>
        </Section>}

        <Section icon={Palette} title="Appearance" description="Follow your system, or pick a side.">
          <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-full border border-border bg-secondary p-1">
            {[
              { value: 'system', label: 'System', icon: Laptop },
              { value: 'light', label: 'Light', icon: Sun },
              { value: 'dark', label: 'Dark', icon: Moon },
            ].map(({ value, label, icon: Icon }) => {
              const selected = mounted && theme === value
              return (
                <button
                  key={value}
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setTheme(value)}
                  className={cn(
                    'inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-medium transition-colors',
                    selected ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              )
            })}
          </div>
        </Section>

        <Section icon={UserIcon} title="Account" description="Profile details, password, and sessions.">
          <Button variant="outline" onClick={() => router.push('/profile')} className="rounded-full">
            Manage profile
          </Button>
        </Section>
      </main>
    </div>
  )
}

export default function SettingsPage() {
  return (
    <ProtectedRoute>
      <SettingsContent />
    </ProtectedRoute>
  )
}
