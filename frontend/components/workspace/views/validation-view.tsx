'use client'

import React, { useMemo } from 'react'
import {
  BadgeCheck,
  CircleAlert,
  CircleDashed,
  Clock3,
  Download,
  FileWarning,
  Layers,
  ShieldAlert,
  ShieldCheck,
  Waypoints,
} from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useWorkspaceStore, type BoardArtifact } from '@/lib/store'

/**
 * Validation.
 *
 * Two checks, kept apart on purpose
 * --------------------------------
 * HANDOFF is dunkai's own check, run BEFORE anything is generated, and it asks
 * "is this a well-formed handoff document?" — known interfaces, legal roles, a
 * filled BOM, every ref resolving. BOARD is dunkai-designer's, run AFTER
 * generation, and asks "did this actually route, and can it be fabricated?".
 *
 * They are not two halves of one score and are not averaged into one. A
 * well-formed handoff is explicitly NOT a claim that the board can be built —
 * `_validate_handoff` says so in its docstring, and CircuitState keeps
 * `handoff_validation` under a different key from `validation` precisely so
 * that reading a buildability verdict off it fails loudly instead of quietly
 * returning something that means something else. Blending them into "78%
 * valid" would rebuild exactly the confusion those two decisions prevent: it
 * would let one unrouted port dilute a clean netlist, and a clean netlist
 * mask an unroutable board.
 */

interface ValidationViewProps {
  projectId: string
}

interface HandoffIssue {
  severity?: string
  code?: string
  message?: string
}

interface HandoffData {
  /** Schema 2.0 verdict. */
  well_formed?: boolean
  /** Schema 1.0 verdict. Only one of the two is ever present. */
  passed?: boolean
  schema_version?: string
  issue_count?: number
  issues?: HandoffIssue[]
  checks_run?: string[]
  scope?: string
}

const CHECK_LABELS: Record<string, string> = {
  interface_known: 'Every net names a known interface',
  role_valid_for_interface: 'Every member role is legal for its interface',
  role_compatibility_on_net: 'Roles on a net can share one wire',
  component_references_resolve: 'Every referenced component exists',
  bom_completeness: 'Every reference has a part selected',
  package_present: 'Every component carries a package string',
  symbol_availability: 'A schematic symbol was found',
  footprint_availability: 'A PCB footprint was resolved',
  pinout_availability: 'A pinout was available',
  net_connectivity: 'Net connections resolve to declared refs',
}

const humanise = (value: string) =>
  CHECK_LABELS[value] ?? value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

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

function Verdict({ tone, label }: { tone: 'good' | 'warn' | 'bad' | 'idle'; label: string }) {
  const config = {
    good: { cls: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300', icon: <BadgeCheck className="h-3.5 w-3.5" /> },
    warn: { cls: 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300', icon: <CircleAlert className="h-3.5 w-3.5" /> },
    bad: { cls: 'border-rose-500/25 bg-rose-500/10 text-rose-700 dark:text-rose-300', icon: <ShieldAlert className="h-3.5 w-3.5" /> },
    idle: { cls: 'border-border bg-secondary/50 text-muted-foreground', icon: <CircleDashed className="h-3.5 w-3.5" /> },
  }[tone]

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] ${config.cls}`}>
      {config.icon}
      {label}
    </span>
  )
}

function Stat({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-background/80 p-3">
      <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className={`mt-1.5 text-2xl font-semibold ${tone ?? 'text-foreground'}`}>{value}</p>
    </div>
  )
}

/** Section 1 — dunkai's pre-generation check on the handoff document. */
function HandoffSection({ handoff, isV2 }: { handoff: HandoffData | null; isV2: boolean }) {
  if (!handoff) {
    return (
      <Card className="border-border/70 bg-card/85 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="h-4 w-4 text-muted-foreground" />
            Handoff
          </CardTitle>
          <CardDescription>Is the design a well-formed handoff document?</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <CircleDashed className="h-4 w-4" />
            Not run yet — start the pipeline from the Chat tab.
          </div>
        </CardContent>
      </Card>
    )
  }

  const issues = handoff.issues ?? []
  const errors = issues.filter((i) => i.severity === 'error')
  const warnings = issues.filter((i) => i.severity === 'warning')
  // v2 reports `well_formed`; v1 reports `passed`. Only one is ever set, and
  // reading the wrong one off the wrong schema yields undefined rather than a
  // wrong answer — which is the point of them being separate fields.
  const ok = isV2 ? handoff.well_formed === true : handoff.passed === true
  const checks = handoff.checks_run ?? []

  return (
    <Card className="border-border/70 bg-card/85 shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Layers className="h-4 w-4 text-muted-foreground" />
              Handoff
            </CardTitle>
            <CardDescription className="mt-1">
              {isV2
                ? 'Is the design a well-formed handoff document? Checked before generation.'
                : 'Legacy schema 1.0 buildability check.'}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {handoff.schema_version && (
              <Badge variant="outline" className="rounded-full font-mono text-[10px]">
                schema {handoff.schema_version}
              </Badge>
            )}
            <Verdict
              tone={ok ? 'good' : 'bad'}
              label={isV2 ? (ok ? 'Well-formed' : 'Malformed') : ok ? 'Passed' : 'Failed'}
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Checks run" value={checks.length || '—'} />
          <Stat
            label="Errors"
            value={errors.length}
            tone={errors.length ? 'text-rose-600 dark:text-rose-400' : 'text-foreground'}
          />
          <Stat
            label="Warnings"
            value={warnings.length}
            tone={warnings.length ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'}
          />
        </div>

        {checks.length > 0 && (
          <div className="rounded-2xl border border-border bg-background/70 p-3">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
              What was checked
            </p>
            <ul className="grid gap-1.5 sm:grid-cols-2">
              {checks.map((check) => {
                // A check with no issue carrying its name passed. This is the
                // only way to show a PASS at all: the validator emits issues
                // only for failures, so counting "passed checks" from the
                // issue list alone always yielded zero.
                const failed = errors.some((e) => (e.code ?? '').toLowerCase().includes(check.split('_')[0]))
                return (
                  <li key={check} className="flex items-start gap-2 text-xs">
                    {failed ? (
                      <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-500" />
                    ) : (
                      <BadgeCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    )}
                    <span className="text-muted-foreground">{humanise(check)}</span>
                  </li>
                )
              })}
            </ul>
          </div>
        )}

        {issues.length > 0 && (
          <div className="space-y-2">
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
              Issues ({issues.length})
            </p>
            {issues.map((issue, index) => (
              <div
                key={`${issue.code}-${index}`}
                className={`rounded-xl border p-3 ${
                  issue.severity === 'error'
                    ? 'border-rose-500/20 bg-rose-500/5 dark:bg-rose-400/10'
                    : 'border-amber-500/20 bg-amber-500/5 dark:bg-amber-400/10'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="rounded-full font-mono text-[10px]">
                    {issue.code ?? issue.severity ?? 'issue'}
                  </Badge>
                </div>
                <p className="mt-1.5 text-sm leading-6 text-foreground">{issue.message}</p>
              </div>
            ))}
          </div>
        )}

        {issues.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No issues. {checks.length} check{checks.length !== 1 ? 's' : ''} found nothing to report.
          </p>
        )}

        {handoff.scope && (
          <p className="rounded-xl border border-border bg-secondary/40 p-3 text-xs leading-5 text-muted-foreground">
            {handoff.scope}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

/** Section 2 — the designer's post-generation check on the routed board. */
function BoardSection({ board }: { board: BoardArtifact | null }) {
  if (!board) {
    return (
      <Card className="border-border/70 bg-card/85 shadow-sm">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Waypoints className="h-4 w-4 text-muted-foreground" />
            Board (DRC)
          </CardTitle>
          <CardDescription>Did the board route, and can it be fabricated?</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <CircleDashed className="h-4 w-4" />
            No board generated yet — run Generate PCB from the BOM or PCB tab.
          </div>
        </CardContent>
      </Card>
    )
  }

  const stats = board.stats ?? {}
  const errors = stats.errors ?? 0
  const warnings = stats.warnings ?? 0
  const unresolved = stats.unresolvedComponents ?? 0
  const placeholders = stats.placeholderPinComponents ?? 0
  const substituted = stats.substitutedComponents ?? 0

  return (
    <Card className="border-border/70 bg-card/85 shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Waypoints className="h-4 w-4 text-muted-foreground" />
              Board (DRC)
            </CardTitle>
            <CardDescription className="mt-1">
              Did the board route, and can it be fabricated? Checked after generation.
            </CardDescription>
          </div>
          <Verdict
            tone={errors > 0 ? 'bad' : warnings > 0 ? 'warn' : 'good'}
            label={errors > 0 ? `${errors} DRC error${errors !== 1 ? 's' : ''}` : 'DRC clean'}
          />
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="DRC errors"
            value={errors}
            tone={errors ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}
          />
          <Stat
            label="Warnings"
            value={warnings}
            tone={warnings ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'}
          />
          <Stat label="Routed traces" value={stats.traces ?? '—'} />
          <Stat label="Components" value={stats.components ?? '—'} />
        </div>

        {(stats.errorTypes?.length ?? 0) > 0 && (
          <div className="rounded-2xl border border-rose-500/20 bg-rose-500/5 p-3 dark:bg-rose-400/10">
            <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
              Error types
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {stats.errorTypes!.map((type) => (
                <Badge key={type} variant="outline" className="rounded-full font-mono text-[10px]">
                  {type}
                </Badge>
              ))}
            </div>
          </div>
        )}

        <div className="rounded-2xl border border-border bg-background/70 p-3">
          <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
            Component resolution
          </p>
          <div className="grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <span className="text-muted-foreground">
              Resolved: <span className="font-medium text-foreground">{stats.resolvedComponents ?? '—'}</span>
            </span>
            <span className={unresolved ? 'text-rose-600 dark:text-rose-400' : 'text-muted-foreground'}>
              Unresolved: <span className="font-medium">{unresolved}</span>
            </span>
            <span className={placeholders ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}>
              Placeholder pins: <span className="font-medium">{placeholders}</span>
            </span>
            <span className={substituted ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}>
              Substituted: <span className="font-medium">{substituted}</span>
            </span>
          </div>
          {placeholders > 0 && (
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              A part with placeholder pins has unnamed pins, so it cannot be wired by signal name.
            </p>
          )}
        </div>

        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Clock3 className="h-3.5 w-3.5" />
          Generated {formatTime(board.generated_at)}
          {board.design_name ? ` · ${board.design_name}` : ''}
        </p>
      </CardContent>
    </Card>
  )
}

export function ValidationView({ projectId: _projectId }: ValidationViewProps) {
  const aiOutput = useWorkspaceStore((s) => s.aiOutput)

  const { handoff, isV2, board } = useMemo(() => {
    const v2 = (aiOutput?.handoff_validation as HandoffData | null) ?? null
    const v1 = (aiOutput?.validation as HandoffData | null) ?? null
    return {
      handoff: v2 ?? v1,
      isV2: Boolean(v2),
      board: aiOutput?.board ?? null,
    }
  }, [aiOutput])

  if (!aiOutput) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
        <ShieldCheck className="h-10 w-10 opacity-40" />
        <p className="text-sm">Run the AI pipeline from the Chat tab to generate the Validation Report.</p>
      </div>
    )
  }

  const exportReport = () => {
    const lines: string[] = ['# Validation report', '']

    lines.push('## Handoff (pre-generation)')
    if (handoff) {
      const ok = isV2 ? handoff.well_formed : handoff.passed
      lines.push(`Verdict: ${ok ? (isV2 ? 'well-formed' : 'passed') : 'needs review'}`)
      lines.push(`Schema: ${handoff.schema_version ?? 'unknown'}`)
      lines.push(`Checks run: ${(handoff.checks_run ?? []).join(', ') || 'none reported'}`)
      for (const issue of handoff.issues ?? []) {
        lines.push(`  [${issue.severity}] ${issue.code}: ${issue.message}`)
      }
      if ((handoff.issues ?? []).length === 0) lines.push('  no issues')
    } else {
      lines.push('not run')
    }

    lines.push('', '## Board DRC (post-generation)')
    if (board) {
      const s = board.stats ?? {}
      lines.push(`DRC errors: ${s.errors ?? 0}`)
      lines.push(`Warnings: ${s.warnings ?? 0}`)
      lines.push(`Routed traces: ${s.traces ?? 0}`)
      lines.push(`Components: ${s.components ?? 0}`)
      if (s.errorTypes?.length) lines.push(`Error types: ${s.errorTypes.join(', ')}`)
      lines.push(
        `Resolution: ${s.resolvedComponents ?? 0} resolved, ${s.unresolvedComponents ?? 0} unresolved, ` +
          `${s.placeholderPinComponents ?? 0} with placeholder pins, ${s.substitutedComponents ?? 0} substituted`
      )
    } else {
      lines.push('no board generated')
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'validation-report.txt'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-5 p-6 pr-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-1">
              <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
                Validation dashboard
              </p>
              <h2 className="font-display text-2xl tracking-tight">Validation</h2>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Two separate checks. The handoff check asks whether the design is a well-formed
                document; the board check asks whether what was generated from it can be built.
                Neither answers the other, so they are not combined into one score.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="border-border text-muted-foreground shadow-sm"
              onClick={exportReport}
            >
              <Download className="mr-2 h-4 w-4" />
              Export Report
            </Button>
          </div>

          <HandoffSection handoff={handoff} isV2={isV2} />
          <BoardSection board={board} />

          {handoff && !board && (
            <p className="flex items-start gap-2 rounded-xl border border-border bg-secondary/40 p-3 text-xs leading-5 text-muted-foreground">
              <FileWarning className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              A well-formed handoff is not a claim that the board can be built. Buildability is
              decided by the board check above, which needs a generated board.
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
