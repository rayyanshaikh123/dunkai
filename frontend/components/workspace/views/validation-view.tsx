'use client'

import React, { useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Download,
  Info,
  ShieldCheck,
  ShieldAlert,
  CircleDashed,
  Thermometer,
  Waves,
  BatteryCharging,
  CircuitBoard,
  Factory,
  BadgeCheck,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { useWorkspaceStore } from '@/lib/store'

interface ValidationViewProps {
  projectId: string
}

interface ValidationIssue {
  id?: string
  title?: string
  name?: string
  category?: string
  code?: string
  status?: 'passed' | 'warning' | 'failed' | 'error' | 'info'
  severity?: 'error' | 'warning' | 'info' | 'passed'
  details?: string
  message?: string
  description?: string
  recommendation?: string
  suggestion?: string
  fix?: string
  timestamp?: string
  createdAt?: string
  updatedAt?: string
}

interface ValidationData {
  issues?: ValidationIssue[]
  checks?: ValidationIssue[]
  results?: ValidationIssue[]
  passed?: number | boolean
  passed_count?: number
  warnings?: number
  failures?: number
  info_count?: number
  status?: string
  summary?: string
  createdAt?: string
  updatedAt?: string
  timestamp?: string
  validatedAt?: string
  lastValidatedAt?: string
}

type StatusKey = 'passed' | 'warning' | 'failed' | 'error' | 'info'
type CategoryKey = 'Electrical' | 'Thermal' | 'Power' | 'Signal Integrity' | 'Manufacturing' | 'Compliance'

const STATUS_CONFIG: Record<StatusKey, { icon: React.ReactNode; label: string; tone: string; border: string; bg: string }> = {
  passed: {
    icon: <CheckCircle2 className="h-5 w-5 text-emerald-500" />,
    label: 'Passed',
    tone: 'text-emerald-600 dark:text-emerald-400',
    border: 'border-emerald-500/20 dark:border-emerald-400/20',
    bg: 'bg-emerald-500/5 dark:bg-emerald-400/10',
  },
  warning: {
    icon: <CircleAlert className="h-5 w-5 text-amber-500" />,
    label: 'Warning',
    tone: 'text-amber-600 dark:text-amber-400',
    border: 'border-amber-500/20 dark:border-amber-400/20',
    bg: 'bg-amber-500/5 dark:bg-amber-400/10',
  },
  failed: {
    icon: <ShieldAlert className="h-5 w-5 text-rose-500" />,
    label: 'Failed',
    tone: 'text-rose-600 dark:text-rose-400',
    border: 'border-rose-500/20 dark:border-rose-400/20',
    bg: 'bg-rose-500/5 dark:bg-rose-400/10',
  },
  error: {
    icon: <ShieldAlert className="h-5 w-5 text-rose-500" />,
    label: 'Error',
    tone: 'text-rose-600 dark:text-rose-400',
    border: 'border-rose-500/20 dark:border-rose-400/20',
    bg: 'bg-rose-500/5 dark:bg-rose-400/10',
  },
  info: {
    icon: <Info className="h-5 w-5 text-slate-500 dark:text-slate-400" />,
    label: 'Info',
    tone: 'text-slate-600 dark:text-slate-400',
    border: 'border-slate-500/20 dark:border-slate-400/20',
    bg: 'bg-slate-500/5 dark:bg-slate-400/10',
  },
}

const CATEGORY_CONFIG: Record<CategoryKey, { icon: React.ReactNode; accent: string; badge: string }> = {
  Electrical: {
    icon: <CircuitBoard className="h-4 w-4" />,
    accent: 'text-cyan-600 dark:text-cyan-400',
    badge: 'border-cyan-500/20 bg-cyan-500/5 text-cyan-700 dark:border-cyan-400/20 dark:bg-cyan-400/10 dark:text-cyan-300',
  },
  Thermal: {
    icon: <Thermometer className="h-4 w-4" />,
    accent: 'text-orange-600 dark:text-orange-400',
    badge: 'border-orange-500/20 bg-orange-500/5 text-orange-700 dark:border-orange-400/20 dark:bg-orange-400/10 dark:text-orange-300',
  },
  Power: {
    icon: <BatteryCharging className="h-4 w-4" />,
    accent: 'text-amber-600 dark:text-amber-400',
    badge: 'border-amber-500/20 bg-amber-500/5 text-amber-700 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-300',
  },
  'Signal Integrity': {
    icon: <Waves className="h-4 w-4" />,
    accent: 'text-violet-600 dark:text-violet-400',
    badge: 'border-violet-500/20 bg-violet-500/5 text-violet-700 dark:border-violet-400/20 dark:bg-violet-400/10 dark:text-violet-300',
  },
  Manufacturing: {
    icon: <Factory className="h-4 w-4" />,
    accent: 'text-emerald-600 dark:text-emerald-400',
    badge: 'border-emerald-500/20 bg-emerald-500/5 text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-300',
  },
  Compliance: {
    icon: <BadgeCheck className="h-4 w-4" />,
    accent: 'text-pink-600 dark:text-pink-400',
    badge: 'border-pink-500/20 bg-pink-500/5 text-pink-700 dark:border-pink-400/20 dark:bg-pink-400/10 dark:text-pink-300',
  },
}

const CATEGORY_ORDER: CategoryKey[] = [
  'Electrical',
  'Thermal',
  'Power',
  'Signal Integrity',
  'Manufacturing',
  'Compliance',
]

function statusFromItem(item: ValidationIssue): StatusKey {
  const sev = item.severity ?? item.status
  if (sev === 'passed') return 'passed'
  if (sev === 'error') return 'failed'
  if (sev === 'warning') return 'warning'
  if (sev === 'info') return 'info'
  if (sev === 'failed') return 'failed'
  return 'info'
}

function categoryFromItem(item: ValidationIssue): CategoryKey {
  // Prefer the category field from the backend if it matches a known category
  const backendCat = item.category?.trim()
  if (backendCat && CATEGORY_ORDER.includes(backendCat as CategoryKey)) {
    return backendCat as CategoryKey
  }

  const text = `${item.category ?? ''} ${item.title ?? item.name ?? ''} ${item.details ?? item.message ?? item.description ?? ''}`.toLowerCase()

  if (/(thermal|temperature|temp|heat|cool|derating)/.test(text)) return 'Thermal'
  if (/(power|vbat|vcc|vdd|rail|regulator|pmic|battery|current|consumption)/.test(text)) return 'Power'
  if (/(signal|integrity|impedance|noise|crosstalk|clock|timing|skew|trace|routing)/.test(text)) return 'Signal Integrity'
  if (/(manufactur|assembly|bom|footprint|pick and place|dfm|drc|availability|solder|stock|moq|package)/.test(text)) return 'Manufacturing'
  if (/(compliance|regulatory|emc|emi|fcc|ce|ul|rf|antenna|ble|wifi|can|safety|pin|pricing|cost)/.test(text)) return 'Compliance'
  return 'Electrical'
}

function formatTime(value?: string): string {
  if (!value) return 'Not available'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Not available'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function relativeTime(value?: string): string {
  if (!value) return 'just now'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'just now'
  const diff = Date.now() - date.getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return formatTime(value)
}

function recommendationFor(item: ValidationIssue, status: StatusKey): string | null {
  if (item.recommendation || item.suggestion || item.fix) return item.recommendation ?? item.suggestion ?? item.fix ?? null
  if (status === 'passed') return null
  if (status === 'info') return 'This is informational — no immediate action required.'
  if (status === 'warning') return 'Review the referenced constraint and confirm the chosen value remains within tolerance.'
  if (status === 'failed' || status === 'error') return 'Resolve the issue before export to avoid downstream board or manufacturing failures.'
  return null
}

function donutColor(status: StatusKey): string {
  if (status === 'warning') return 'var(--warning, #f59e0b)'
  if (status === 'failed' || status === 'error') return 'var(--destructive, #ef4444)'
  return 'var(--accent, #59616e)'
}

function StatusPill({ status }: { status: StatusKey }) {
  const cfg = STATUS_CONFIG[status]
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] ${cfg.border} ${cfg.bg} ${cfg.tone}`}>
      {cfg.icon}
      {cfg.label}
    </span>
  )
}

function DonutChart({ passed, warning, failed }: { passed: number; warning: number; failed: number }) {
  const total = Math.max(passed + warning + failed, 1)
  const passedPct = (passed / total) * 100
  const warningPct = (warning / total) * 100
  const failedPct = (failed / total) * 100

  return (
    <div className="relative mx-auto flex h-36 w-36 items-center justify-center">
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background: `conic-gradient(${donutColor('passed')} 0% ${passedPct}%, ${donutColor('warning')} ${passedPct}% ${passedPct + warningPct}%, ${donutColor('failed')} ${passedPct + warningPct}% 100%)`,
        }}
      />
      <div className="absolute inset-[14px] rounded-full border border-border bg-background shadow-inner dark:bg-card" />
      <div className="relative z-10 text-center">
        <p className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">Distribution</p>
        <p className="mt-1 text-lg font-semibold text-foreground">{total}</p>
        <p className="text-[11px] text-muted-foreground">checks</p>
      </div>
    </div>
  )
}

function ValidationItemCard({ item, index }: { item: ValidationIssue; index: number }) {
  const [open, setOpen] = useState(index === 0)
  const status = statusFromItem(item)
  const category = categoryFromItem(item)
  const categoryConfig = CATEGORY_CONFIG[category]
  const title = item.title ?? item.name ?? `Check ${index + 1}`
  const summary = item.details ?? item.message ?? item.description ?? 'No additional details provided.'
  const recommendation = recommendationFor(item, status)
  const timestamp = item.timestamp ?? item.updatedAt ?? item.createdAt

  return (
    <article className={`rounded-2xl border bg-card/90 shadow-sm transition-[transform,border-color,box-shadow,background-color] duration-200 hover:-translate-y-0.5 hover:border-foreground/15 hover:shadow-[0_12px_30px_rgba(0,0,0,0.08)] dark:bg-card/70 dark:hover:shadow-[0_12px_30px_rgba(0,0,0,0.2)] ${STATUS_CONFIG[status].border}`}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-start justify-between gap-4 p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border ${STATUS_CONFIG[status].border} ${STATUS_CONFIG[status].bg}`}>
            {STATUS_CONFIG[status].icon}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold leading-5 text-foreground">{title}</h3>
              <Badge variant="outline" className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] ${categoryConfig.badge}`}>
                <span className={`mr-1 inline-flex items-center`}>{categoryConfig.icon}</span>
                {category}
              </Badge>
              <StatusPill status={status} />
            </div>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{summary}</p>
          </div>
        </div>
        <span className="mt-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border bg-background/80 text-muted-foreground transition-colors">
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </span>
      </button>

      {open && (
        <div className="border-t border-border/70 px-4 pb-4 pt-3">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_240px]">
            <div className="space-y-3">
              {recommendation && (
                <div className="rounded-xl border border-border bg-secondary/40 p-3">
                  <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground">Recommendation</p>
                  <p className="mt-1 text-sm leading-6 text-foreground">{recommendation}</p>
                </div>
              )}
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-xl border border-border bg-background/80 p-3">
                  <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground">Check details</p>
                  <p className="mt-1 text-sm leading-6 text-foreground">{summary}</p>
                </div>
                <div className="rounded-xl border border-border bg-background/80 p-3">
                  <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground">Category</p>
                  <p className="mt-1 text-sm leading-6 text-foreground">{category}</p>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-border bg-background/80 p-3">
              <p className="text-[10px] font-mono uppercase tracking-[0.22em] text-muted-foreground">Timestamp</p>
              <p className="mt-1 text-sm leading-6 text-foreground">{formatTime(timestamp)}</p>
              <p className="text-xs text-muted-foreground">{relativeTime(timestamp)}</p>
            </div>
          </div>
        </div>
      )}
    </article>
  )
}

function SectionCard({ category, issues }: { category: CategoryKey; issues: ValidationIssue[] }) {
  const config = CATEGORY_CONFIG[category]
  const counts = issues.reduce(
    (acc, item) => {
      const status = statusFromItem(item)
      if (status === 'passed') acc.passed += 1
      else if (status === 'warning') acc.warning += 1
      else if (status === 'failed' || status === 'error') acc.failed += 1
      return acc
    },
    { passed: 0, warning: 0, failed: 0 }
  )
  const total = Math.max(issues.length, 1)
  const passRate = Math.round((counts.passed / total) * 100)

  return (
    <section className="rounded-3xl border border-border bg-card/80 shadow-sm">
      <div className="border-b border-border px-5 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={`flex h-8 w-8 items-center justify-center rounded-xl border border-border bg-background/80 ${config.accent}`}>
                {config.icon}
              </span>
              <div>
                <p className="text-[10px] font-mono uppercase tracking-[0.24em] text-muted-foreground">Section</p>
                <h3 className="text-lg font-semibold text-foreground">{category}</h3>
              </div>
            </div>
          </div>
          <div className="text-right">
            <p className="text-sm font-semibold text-foreground">{passRate}%</p>
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-muted-foreground">Pass rate</p>
          </div>
        </div>
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          <div className="rounded-xl border border-border bg-background/70 px-3 py-2">
            <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Passed</p>
            <p className={`mt-1 text-sm font-semibold ${STATUS_CONFIG.passed.tone}`}>{counts.passed}</p>
          </div>
          <div className="rounded-xl border border-border bg-background/70 px-3 py-2">
            <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Warnings</p>
            <p className={`mt-1 text-sm font-semibold ${STATUS_CONFIG.warning.tone}`}>{counts.warning}</p>
          </div>
          <div className="rounded-xl border border-border bg-background/70 px-3 py-2">
            <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Errors</p>
            <p className={`mt-1 text-sm font-semibold ${STATUS_CONFIG.failed.tone}`}>{counts.failed}</p>
          </div>
        </div>
        <Progress value={passRate} className="mt-4 h-2" />
      </div>

      <div className="space-y-3 p-4">
        {issues.map((item, index) => (
          <ValidationItemCard key={item.id ?? `${category}-${index}`} item={item} index={index} />
        ))}
      </div>
    </section>
  )
}

export function ValidationView({ projectId: _projectId }: ValidationViewProps) {
  const aiOutput = useWorkspaceStore((s) => s.aiOutput)
  const validation = aiOutput?.validation as ValidationData | null | undefined

  const checks: ValidationIssue[] = validation?.issues ?? validation?.checks ?? validation?.results ?? []

  const { grouped, passedCount, warningCount, failedCount, totalCount, score, overallStatus, lastValidationTime } = useMemo(() => {
    const buckets: Record<CategoryKey, ValidationIssue[]> = {
      Electrical: [],
      Thermal: [],
      Power: [],
      'Signal Integrity': [],
      Manufacturing: [],
      Compliance: [],
    }

    for (const item of checks) {
      buckets[categoryFromItem(item)].push(item)
    }

    const passed = (typeof validation?.passed_count === 'number' ? validation.passed_count : null) ?? checks.filter((c) => statusFromItem(c) === 'passed').length
    const warnings = validation?.warnings ?? checks.filter((c) => statusFromItem(c) === 'warning').length
    const failures = validation?.failures ?? checks.filter((c) => ['failed', 'error'].includes(statusFromItem(c))).length
    const infoCount = (typeof validation?.info_count === 'number' ? validation.info_count : null) ?? checks.filter((c) => statusFromItem(c) === 'info').length
    const actionableTotal = Math.max(passed + warnings + failures, 1)
    const total = Math.max(checks.length, 1)
    const health = Math.max(0, Math.min(100, Math.round((passed / actionableTotal) * 100)))
    const status = failures > 0 ? 'Needs Review' : warnings > 0 ? 'Warnings Present' : 'All Checks Passed'
    const lastTime = validation?.lastValidatedAt ?? validation?.validatedAt ?? validation?.updatedAt ?? validation?.timestamp ?? validation?.createdAt

    return {
      grouped: buckets,
      passedCount: passed,
      warningCount: warnings,
      failedCount: failures,
      totalCount: checks.length,
      score: health,
      overallStatus: status,
      lastValidationTime: lastTime,
    }
  }, [checks, validation])

  if (!validation || checks.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
        <ShieldCheck className="h-10 w-10 opacity-40" />
        <p className="text-sm">
          {aiOutput
            ? 'No validation results were generated for this run.'
            : 'Run the AI pipeline from the Chat tab to generate the Validation Report.'}
        </p>
      </div>
    )
  }

  const exportReport = () => {
    const text = checks
      .map((c) => `[${statusFromItem(c).toUpperCase()}] ${c.title ?? c.name ?? 'Check'}: ${c.details ?? c.message ?? c.description ?? ''}`)
      .join('\n')
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'validation-report.txt'
    a.click()
    URL.revokeObjectURL(url)
  }

  const visibleSections = CATEGORY_ORDER.filter((category) => grouped[category].length > 0)

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-6 p-6 pr-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-1">
              <p className="text-[10px] font-mono uppercase tracking-[0.24em] text-muted-foreground">Validation dashboard</p>
              <h2 className="font-display text-2xl tracking-tight">Validation Report</h2>
              <p className="text-sm text-muted-foreground">{totalCount} check{totalCount !== 1 ? 's' : ''} performed</p>
            </div>
            <Button variant="outline" size="sm" className="border-border text-muted-foreground shadow-sm" onClick={exportReport}>
              <Download className="mr-2 h-4 w-4" />
              Export Report
            </Button>
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(320px,0.85fr)]">
            <Card className="border-border/70 bg-card/90 shadow-sm">
              <CardHeader className="pb-4">
                <CardTitle className="text-sm font-medium text-muted-foreground">Validation Score</CardTitle>
                <CardDescription>Overall health across the current run</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="flex items-end justify-between gap-4">
                  <div>
                    <p className="text-5xl font-semibold tracking-tight text-foreground">{score}%</p>
                    <p className="mt-2 text-sm text-muted-foreground">{overallStatus}</p>
                  </div>
                  <div className="text-right">
                    <StatusPill status={failedCount > 0 ? 'failed' : warningCount > 0 ? 'warning' : 'passed'} />
                    <p className="mt-2 text-xs text-muted-foreground">Last run {formatTime(lastValidationTime)}</p>
                  </div>
                </div>
                <Progress value={score} className="h-2" />
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-2xl border border-border bg-background/80 p-3">
                    <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Passed Checks</p>
                    <p className="mt-2 text-2xl font-semibold text-emerald-600 dark:text-emerald-400">{passedCount}</p>
                  </div>
                  <div className="rounded-2xl border border-border bg-background/80 p-3">
                    <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Warnings</p>
                    <p className="mt-2 text-2xl font-semibold text-amber-600 dark:text-amber-400">{warningCount}</p>
                  </div>
                  <div className="rounded-2xl border border-border bg-background/80 p-3">
                    <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">Errors</p>
                    <p className="mt-2 text-2xl font-semibold text-rose-600 dark:text-rose-400">{failedCount}</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="border-border/70 bg-card/90 shadow-sm">
              <CardHeader className="pb-4">
                <CardTitle className="text-sm font-medium text-muted-foreground">Distribution</CardTitle>
                <CardDescription>Passed, warning, and failed checks in this run</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <DonutChart passed={passedCount} warning={warningCount} failed={failedCount} />
                <div className="space-y-3">
                  {[
                    { label: 'Passed', value: passedCount, tone: 'bg-emerald-500' },
                    { label: 'Warnings', value: warningCount, tone: 'bg-amber-500' },
                    { label: 'Errors', value: failedCount, tone: 'bg-rose-500' },
                  ].map((entry) => {
                    const total = Math.max(totalCount, 1)
                    const pct = Math.round((entry.value / total) * 100)
                    return (
                      <div key={entry.label} className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">{entry.label}</span>
                          <span className="font-mono text-muted-foreground">{entry.value} · {pct}%</span>
                        </div>
                        <div className="h-2 rounded-full bg-muted/60">
                          <div className={`h-2 rounded-full ${entry.tone}`} style={{ width: `${Math.max(pct, entry.value > 0 ? 6 : 0)}%` }} />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <Card className="border-border/70 bg-card/85 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground">Overall Status</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2">
                  {failedCount > 0 ? <ShieldAlert className="h-5 w-5 text-rose-500" /> : warningCount > 0 ? <CircleAlert className="h-5 w-5 text-amber-500" /> : <BadgeCheck className="h-5 w-5 text-emerald-500" />}
                  <p className="text-lg font-semibold text-foreground">{overallStatus}</p>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">Status reflects the current validation run.</p>
              </CardContent>
            </Card>

            <Card className="border-border/70 bg-card/85 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground">Last Validation Time</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2 text-foreground">
                  <Clock3 className="h-4 w-4 text-muted-foreground" />
                  <p className="text-base font-medium">{formatTime(lastValidationTime)}</p>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">{relativeTime(lastValidationTime)}</p>
              </CardContent>
            </Card>

            <Card className="border-border/70 bg-card/85 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground">Progress</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-lg font-semibold text-foreground">{score}% complete</p>
                <Progress value={score} className="mt-3 h-2" />
                <p className="mt-2 text-sm text-muted-foreground">Validation completion for this run.</p>
              </CardContent>
            </Card>

            <Card className="border-border/70 bg-card/85 shadow-sm">
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium text-muted-foreground">Category Coverage</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-lg font-semibold text-foreground">{visibleSections.length} sections</p>
                <p className="mt-2 text-sm text-muted-foreground">Electrical, thermal, power, signal integrity, manufacturing, compliance.</p>
              </CardContent>
            </Card>
          </div>

          <div className="space-y-4">
            {visibleSections.map((category) => (
              <SectionCard key={category} category={category} issues={grouped[category]} />
            ))}
          </div>

          {validation.summary && (
            <Card className={`border shadow-sm ${failedCount > 0 ? 'border-rose-500/20 bg-rose-500/5 dark:bg-rose-400/10' : 'border-emerald-500/20 bg-emerald-500/5 dark:bg-emerald-400/10'}`}>
              <CardContent className="p-4">
                <p className="text-sm leading-6 text-foreground">{validation.summary}</p>
              </CardContent>
            </Card>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
