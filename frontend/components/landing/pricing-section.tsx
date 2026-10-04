'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Check } from 'lucide-react'
import { CREDIT_PACK_COPY } from '@/lib/plans'
import { billingApi } from '@/lib/api'

export function PricingSection() {
  const [billingEnabled, setBillingEnabled] = useState(false)
  useEffect(() => {
    billingApi.plans().then((plans) => setBillingEnabled(plans.billingEnabled)).catch(() => {})
  }, [])
  return (
    <section id="pricing" data-ribbon="pricing" className="relative py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-medium text-muted-foreground">Pricing</p>
          <h2 className="mt-2 text-4xl font-semibold tracking-[-0.03em] sm:text-5xl">Start free. Add credits when you need them.</h2>
          <p className="mt-4 text-lg text-muted-foreground">
            Verified accounts get 150 one-time trial credits and five hosted chat turns each month.
            Credits never expire. No subscription is required.
          </p>
          {!billingEnabled && <p className="mt-3 text-sm text-muted-foreground">Pricing preview. Credit purchases open after launch checks are complete.</p>}
        </div>

        <div className="mt-14 grid gap-4 lg:grid-cols-3">
          {CREDIT_PACK_COPY.map((pack) => (
            <div key={pack.id} className={`shadow-soft relative flex flex-col rounded-[30px] bg-card p-8 ${pack.highlighted ? 'border-2 border-foreground' : 'border border-border'}`}>
              {pack.highlighted && <span className="absolute -top-3 left-8 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground">Popular</span>}
              <h3 className="text-xl font-semibold">{pack.name}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{pack.tagline}</p>
              <div className="mt-6 text-5xl font-semibold tracking-tight">₹{pack.rupees.toLocaleString('en-IN')}</div>
              <p className="mt-2 text-sm text-muted-foreground">{pack.credits.toLocaleString('en-IN')} prepaid credits · one-time purchase</p>
              <ul className="mt-6 flex-1 space-y-3 text-[15px]">
                <li className="flex gap-3"><Check className="mt-0.5 h-4 w-4 shrink-0" />Use credits for AI pipeline and PCB work</li>
                <li className="flex gap-3"><Check className="mt-0.5 h-4 w-4 shrink-0" />See your balance before starting a job</li>
                <li className="flex gap-3"><Check className="mt-0.5 h-4 w-4 shrink-0" />Bring your own model key when preferred</li>
              </ul>
              <Link href="/settings" className={`mt-8 inline-flex items-center justify-center rounded-full px-5 py-3 text-sm font-medium hover:opacity-90 ${pack.highlighted ? 'bg-primary text-primary-foreground' : 'border border-border bg-background'}`}>
                {billingEnabled ? `Get ${pack.credits.toLocaleString('en-IN')} credits` : 'View credit options'}
              </Link>
            </div>
          ))}
        </div>
        <p className="mt-8 text-center text-sm text-muted-foreground">
          Typical quotes: chat 2 credits after free turns, design pipeline 30, Groq PCB generation 101.
          Your own key removes AI token charges; pipeline compute is 10 credits and board compute is 20.
        </p>
      </div>
    </section>
  )
}
