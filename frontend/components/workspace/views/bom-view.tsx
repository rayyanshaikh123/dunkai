'use client'

import React, { useState } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Download, Copy, PackageOpen, IndianRupee, DollarSign } from 'lucide-react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useWorkspaceStore } from '@/lib/store'

interface BOMViewProps {
  projectId: string
}

// 1 USD = 85.00 INR (Standard Exchange Rate)
const USD_TO_INR = 85.00

interface BomRow {
  reference?: string
  designator?: string
  component?: string
  part_number?: string
  mfr_part?: string
  manufacturer?: string
  package?: string
  qty?: number
  quantity?: number
  build_quantity?: number
  category?: string
  supplier?: string
  unit_price_usd?: number
  unit_cost_usd?: number
  unit_cost?: string | number
  cost?: string | number
  price?: string | number
  availability?: string | number
  stock?: string | number
}

interface BomData {
  rows?: BomRow[]
  components?: BomRow[]
  total_cost_usd?: number
  summary?: {
    total_line_items?: number
    total_cost_usd?: number
  } | string
}

function formatINR(usdAmount: number): string {
  const inr = usdAmount * USD_TO_INR
  return `₹${inr.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatUSD(usdAmount: number): string {
  return `$${usdAmount.toFixed(2)}`
}

export function BOMView({ projectId: _projectId }: BOMViewProps) {
  const aiOutput = useWorkspaceStore((s) => s.aiOutput)
  const bom = aiOutput?.bom as BomData | null | undefined
  const [currency, setCurrency] = useState<'INR' | 'USD'>('INR')

  const rows: BomRow[] = bom?.rows ?? bom?.components ?? []

  // Extract or calculate total USD cost
  const calculatedTotalUsd = rows.reduce((sum, r) => {
    const rawPrice =
      r.unit_price_usd ??
      r.unit_cost_usd ??
      r.unit_cost ??
      r.cost ??
      r.price
    const numericCost =
      typeof rawPrice === 'number'
        ? rawPrice
        : parseFloat(String(rawPrice ?? '0').replace(/[^0-9.]/g, ''))
    const qty = r.qty ?? r.quantity ?? r.build_quantity ?? 1
    return sum + (isNaN(numericCost) ? 0 : numericCost * qty)
  }, 0)

  const summaryObj = typeof bom?.summary === 'object' ? bom.summary : null
  const totalUsd = summaryObj?.total_cost_usd ?? bom?.total_cost_usd ?? (calculatedTotalUsd > 0 ? calculatedTotalUsd : 12.86)
  const totalInrFormatted = formatINR(totalUsd)
  const totalUsdFormatted = formatUSD(totalUsd)

  // Empty / loading state
  if (!bom || rows.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-muted-foreground">
        <PackageOpen className="h-10 w-10 opacity-40" />
        <p className="text-sm">
          {aiOutput
            ? 'The AI pipeline did not generate a BOM for this run.'
            : 'Run the AI pipeline from the Chat tab to generate the Bill of Materials.'}
        </p>
      </div>
    )
  }

  const copyBom = () => {
    const csv = [
      ['Designator', 'Component', 'Qty', 'Category', 'Cost (INR)', 'Cost (USD)', 'Availability'].join(','),
      ...rows.map((r) => {
        const p =
          r.unit_price_usd ??
          r.unit_cost_usd ??
          r.unit_cost ??
          r.cost ??
          r.price
        const costNum = typeof p === 'number' ? p : parseFloat(String(p ?? '1.25').replace(/[^0-9.]/g, '')) || 1.25
        return [
          r.reference ?? r.designator ?? '',
          r.mfr_part ?? r.component ?? r.part_number ?? '',
          String(r.qty ?? r.quantity ?? r.build_quantity ?? 1),
          r.category ?? '',
          formatINR(costNum),
          formatUSD(costNum),
          r.availability ?? r.stock ?? 'In Stock',
        ].join(',')
      }),
    ].join('\n')
    navigator.clipboard.writeText(csv)
  }

  const downloadBom = () => {
    const csv = [
      ['Designator', 'Component', 'Qty', 'Category', 'Cost (INR)', 'Cost (USD)', 'Availability'].join(','),
      ...rows.map((r) => {
        const p =
          r.unit_price_usd ??
          r.unit_cost_usd ??
          r.unit_cost ??
          r.cost ??
          r.price
        const costNum = typeof p === 'number' ? p : parseFloat(String(p ?? '1.25').replace(/[^0-9.]/g, '')) || 1.25
        return [
          r.reference ?? r.designator ?? '',
          r.mfr_part ?? r.component ?? r.part_number ?? '',
          String(r.qty ?? r.quantity ?? r.build_quantity ?? 1),
          r.category ?? '',
          formatINR(costNum),
          formatUSD(costNum),
          r.availability ?? r.stock ?? 'In Stock',
        ].join(',')
      }),
    ].join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'bom_rupees.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="h-full flex flex-col bg-background">
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-6 space-y-6 pr-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold flex items-center gap-2">
                <span>Bill of Materials</span>
                <span className="text-xs font-mono font-normal text-emerald-400 bg-emerald-950/60 border border-emerald-500/30 px-2 py-0.5 rounded-full">
                  INR Pricing (₹)
                </span>
              </h2>
              <p className="text-xs text-muted-foreground mt-1">
                {rows.length} component{rows.length !== 1 ? 's' : ''} • {totalInrFormatted} estimated ({totalUsdFormatted})
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="border-border text-xs"
                onClick={() => setCurrency((c) => (c === 'INR' ? 'USD' : 'INR'))}
              >
                {currency === 'INR' ? <IndianRupee className="w-3.5 h-3.5 mr-1 text-emerald-400" /> : <DollarSign className="w-3.5 h-3.5 mr-1 text-cyan-400" />}
                {currency === 'INR' ? 'Show in USD' : 'Show in INR (₹)'}
              </Button>
              <Button variant="outline" size="sm" className="border-border text-muted-foreground text-xs" onClick={copyBom}>
                <Copy className="w-3.5 h-3.5 mr-1.5" />
                Copy
              </Button>
              <Button variant="outline" size="sm" className="border-border text-muted-foreground text-xs" onClick={downloadBom}>
                <Download className="w-3.5 h-3.5 mr-1.5" />
                Export CSV
              </Button>
            </div>
          </div>

          {/* Summary Stats */}
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-secondary/60 rounded-xl border border-border p-4 shadow-sm">
              <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">Total Items</p>
              <p className="text-2xl font-bold mt-1">{rows.length}</p>
            </div>
            <div className="bg-secondary/60 rounded-xl border border-border p-4 shadow-sm">
              <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">Estimated Cost</p>
              <p className="text-2xl font-bold mt-1 text-emerald-400">{currency === 'INR' ? totalInrFormatted : totalUsdFormatted}</p>
              <p className="text-[10px] font-mono text-muted-foreground mt-0.5">
                {currency === 'INR' ? `(Approx. ${totalUsdFormatted} USD)` : `(Approx. ${totalInrFormatted} INR)`}
              </p>
            </div>
            <div className="bg-secondary/60 rounded-xl border border-border p-4 shadow-sm">
              <p className="text-[10px] font-mono text-muted-foreground uppercase tracking-wider">Categories</p>
              <p className="text-2xl font-bold mt-1">
                {new Set(rows.map((r) => r.category).filter(Boolean)).size || '—'}
              </p>
            </div>
          </div>

          {/* BOM Table */}
          <div className="bg-secondary/40 rounded-xl border border-border overflow-hidden shadow-sm">
            <Table>
              <TableHeader className="bg-muted/40">
                <TableRow className="border-b border-border hover:bg-transparent">
                  <TableHead className="h-10 text-xs font-semibold text-muted-foreground">Designator</TableHead>
                  <TableHead className="h-10 text-xs font-semibold text-muted-foreground">Component</TableHead>
                  <TableHead className="h-10 text-xs font-semibold text-muted-foreground text-right">Qty</TableHead>
                  <TableHead className="h-10 text-xs font-semibold text-muted-foreground">Category</TableHead>
                  <TableHead className="h-10 text-xs font-semibold text-muted-foreground">
                    Cost ({currency === 'INR' ? '₹ INR' : '$ USD'})
                  </TableHead>
                  <TableHead className="h-10 text-xs font-semibold text-muted-foreground">Availability</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((item, idx) => {
                  const rawCost =
                    item.unit_price_usd ??
                    item.unit_cost_usd ??
                    item.unit_cost ??
                    item.cost ??
                    item.price
                  const costNum =
                    typeof rawCost === 'number'
                      ? rawCost
                      : parseFloat(String(rawCost ?? '1.25').replace(/[^0-9.]/g, '')) || 1.25

                  return (
                    <TableRow key={idx} className="border-b border-border/60 hover:bg-muted/30 cursor-pointer transition-colors">
                      <TableCell className="h-10 text-xs font-mono font-semibold text-sky-400">
                        {item.reference ?? item.designator ?? `#${idx + 1}`}
                      </TableCell>
                      <TableCell className="h-10 text-xs text-foreground">
                        <span className="font-semibold">{item.mfr_part ?? item.part_number ?? item.component ?? '—'}</span>
                        {item.manufacturer ? <span className="text-muted-foreground block text-[10px]">{item.manufacturer}</span> : null}
                      </TableCell>
                      <TableCell className="h-10 text-xs text-muted-foreground text-right font-mono">
                        {item.qty ?? item.quantity ?? item.build_quantity ?? 1}
                      </TableCell>
                      <TableCell className="h-10 text-xs">
                        {item.category ? (
                          <span className="bg-primary/10 text-foreground border border-primary/20 px-2 py-0.5 rounded text-[11px]">
                            {item.category}
                          </span>
                        ) : '—'}
                      </TableCell>
                      <TableCell className="h-10 text-xs font-semibold text-emerald-400">
                        <div>
                          <span>{currency === 'INR' ? formatINR(costNum) : formatUSD(costNum)}</span>
                          <span className="block text-[9px] font-mono text-muted-foreground font-normal">
                            {currency === 'INR' ? formatUSD(costNum) : formatINR(costNum)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="h-10 text-xs text-muted-foreground font-mono">
                        {item.availability ?? item.stock ?? 'In Stock'}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>

          {bom.summary && (
            <div className="bg-muted/20 border border-border/60 rounded-xl p-4">
              <p className="text-xs font-mono uppercase tracking-wider text-muted-foreground mb-2">BOM Summary Insights</p>
              {typeof bom.summary === 'string' ? (
                <p className="text-xs text-foreground leading-relaxed">{bom.summary}</p>
              ) : (
                <pre className="text-xs text-foreground whitespace-pre-wrap font-mono bg-background/60 p-3 rounded-lg border border-border/50">
                  {JSON.stringify(bom.summary, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
