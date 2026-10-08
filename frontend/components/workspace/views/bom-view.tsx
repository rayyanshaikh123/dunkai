'use client';

import React, { useEffect, useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import {
  Download,
  Copy,
  PackageOpen,
  CircuitBoard,
  Loader2,
  AlertTriangle,
  ArrowRight,
  IndianRupee,
  DollarSign,
} from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useWorkspaceStore } from '@/lib/store';
import { useBoardGeneration } from '@/hooks/use-board-generation';
import { billingApi } from '@/lib/api';

interface BOMViewProps {
  projectId: string;
}

/**
 * Indicative only, and deliberately a named constant rather than a live rate:
 * nothing in the pipeline fetches FX, so this converts a USD figure for reading
 * convenience and must never be presented as a quoted price.
 */
const USD_TO_INR = 85.0;

// ---- Types that mirror the Python BOM output ----
interface BomRow {
  reference?: string;
  designator?: string;
  component?: string;
  part_number?: string;
  manufacturer?: string;
  package?: string;
  qty?: number;
  quantity?: number;
  category?: string;
  supplier?: string;
  unit_cost?: string | number;
  cost?: string | number;
  price?: string | number;
  availability?: string | number;
  // The names the component agent actually writes (BOM_COLUMNS in
  // ai_engine/agents/component_agent/bom.py). The four guessed spellings above
  // never matched a real row, so every cost cell read '—' and the total read
  // $0.00 on runs that had prices all along.
  unit_price_usd?: number | string;
  unit_cost_usd?: number | string;
  extended_price_usd?: number | string;
  build_quantity?: number;
  mfr_part?: string;
  lcsc?: string;
  stock?: string | number;
  status?: string;
}

interface BomData {
  rows?: BomRow[];
  components?: BomRow[];
  total_cost?: string | number;
  total_cost_usd?: number;
  summary?:
    | {
        total_line_items?: number;
        total_cost_usd?: number;
        unfilled_references?: string[];
      }
    | string;
}

/** First of the real names, then the older guesses, so both shapes render. */
const unitPrice = (r: BomRow) => r.unit_price_usd ?? r.unit_cost_usd ?? r.unit_cost ?? r.cost ?? r.price;
const quantityOf = (r: BomRow) => r.build_quantity ?? r.qty ?? r.quantity ?? 1;

/**
 * A row's unit price in USD, or null when the row carries no usable price.
 *
 * Returning null rather than a stand-in is the whole point. An earlier revision
 * defaulted an unpriced part to $1.25 and an unknown stock field to "In Stock",
 * which put invented numbers into a CSV that someone can order parts from. An
 * unpriced part reads '—' and is excluded from the total.
 */
const unitPriceUsd = (r: BomRow): number | null => {
  const raw = unitPrice(r);
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const extendedPriceUsd = (r: BomRow): number | null => {
  const raw = r.extended_price_usd;
  if (raw != null && raw !== '') {
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw).replace(/[^0-9.]/g, ''));
    if (Number.isFinite(n)) return n;
  }
  const unit = unitPriceUsd(r);
  return unit === null ? null : unit * quantityOf(r);
};

const formatINR = (usd: number) =>
  `₹${(usd * USD_TO_INR).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const formatUSD = (usd: number) => `$${usd.toFixed(2)}`;

export function BOMView({ projectId }: BOMViewProps) {
  const aiOutput = useWorkspaceStore((s) => s.aiOutput);
  const setActiveTab = useWorkspaceStore((s) => s.setActiveTab);
  const activeChatId = useWorkspaceStore((s) => s.activeChatId);
  const bom = aiOutput?.bom as BomData | null | undefined;
  const [currency, setCurrency] = useState<'INR' | 'USD'>('USD');
  const [billingEnabled, setBillingEnabled] = useState(false);
  useEffect(() => {
    billingApi.plans().then((plans) => setBillingEnabled(plans.billingEnabled)).catch(() => {});
  }, []);

  // Component selection finishes here, so this is where the board gets built.
  // The model used here is the Settings default ("Default agent/model for PCB
  // generation"); this button only re-runs with it.
  const { generate, canGenerate, componentCount, job, board } = useBoardGeneration(projectId, activeChatId);

  const startGeneration = () => {
    // Switch to the PCB tab so the run is visible: that view renders the live
    // per-stage log, and a long job with no visible progress reads as a hang.
    setActiveTab('pcb');
    generate();
  };

  // Normalise rows from whatever key the Python agent used
  const rows: BomRow[] = bom?.rows ?? bom?.components ?? [];

  const summaryObj = typeof bom?.summary === 'object' && bom.summary !== null ? bom.summary : null;

  /**
   * Total in USD, or null when nothing in the BOM carries a price.
   *
   * The agent already totals this in summary.total_cost_usd; prefer its number
   * over re-deriving one, so this tab and the build report cannot disagree.
   * Falls through to summing the rows, and yields null — rendered '—' — rather
   * than $0.00 when no row was priced, so "free" and "unknown" stay distinct.
   */
  const totalUsd: number | null = (() => {
    if (typeof summaryObj?.total_cost_usd === 'number') return summaryObj.total_cost_usd;
    if (typeof bom?.total_cost_usd === 'number') return bom.total_cost_usd;
    if (typeof bom?.total_cost === 'number') return bom.total_cost;
    if (typeof bom?.total_cost === 'string') {
      const n = parseFloat(bom.total_cost.replace(/[^0-9.]/g, ''));
      if (Number.isFinite(n)) return n;
    }
    let sum = 0;
    let anyPriced = false;
    for (const r of rows) {
      const extended = extendedPriceUsd(r);
      if (extended === null) continue;
      anyPriced = true;
      sum += extended;
    }
    return anyPriced ? sum : null;
  })();

  const money = (usd: number) => (currency === 'INR' ? formatINR(usd) : formatUSD(usd));
  const totalFormatted = totalUsd === null ? null : money(totalUsd);

  // ---- Empty / loading state ----
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
    );
  }

  /** Both currencies are exported, so the file does not depend on the toggle. */
  const buildCsv = () =>
    [
      ['Designator', 'Component', 'Qty', 'Category', 'Unit Cost (USD)', 'Unit Cost (INR)', 'Availability'].join(','),
      ...rows.map((r) => {
        const unit = unitPriceUsd(r);
        return [
          r.reference ?? r.designator ?? '',
          r.mfr_part ?? r.component ?? r.part_number ?? '',
          String(quantityOf(r)),
          r.category ?? '',
          unit === null ? '' : unit.toFixed(2),
          unit === null ? '' : (unit * USD_TO_INR).toFixed(2),
          String(r.availability ?? r.stock ?? ''),
        ].join(',');
      }),
    ].join('\n');

  const copyBom = () => {
    navigator.clipboard.writeText(buildCsv());
  };

  const downloadBom = () => {
    const blob = new Blob([buildCsv()], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bom.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-full flex flex-col bg-background">
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-6 space-y-6 pr-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Bill of Materials</h2>
              <p className="text-xs text-muted-foreground mt-1">
                {rows.length} component{rows.length !== 1 ? 's' : ''}
                {totalFormatted ? ` • ${totalFormatted} estimated` : ''}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="border-border text-muted-foreground"
                onClick={() => setCurrency((c) => (c === 'USD' ? 'INR' : 'USD'))}
                title={
                  currency === 'USD'
                    ? `Show indicative INR at ${USD_TO_INR}/USD`
                    : 'Show the source USD prices'
                }
              >
                {currency === 'USD' ? (
                  <DollarSign className="w-4 h-4 mr-2" />
                ) : (
                  <IndianRupee className="w-4 h-4 mr-2" />
                )}
                {currency}
              </Button>
              <Button variant="outline" size="sm" className="border-border text-muted-foreground" onClick={copyBom}>
                <Copy className="w-4 h-4 mr-2" />
                Copy
              </Button>
              <Button variant="outline" size="sm" className="border-border text-muted-foreground" onClick={downloadBom}>
                <Download className="w-4 h-4 mr-2" />
                Export
              </Button>
              {board ? (
                <Button size="sm" onClick={() => setActiveTab('pcb')}>
                  View PCB
                  <ArrowRight className="w-4 h-4 ml-2" />
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={startGeneration}
                  disabled={!canGenerate}
                  title={
                    componentCount === 0
                      ? 'The pipeline has not produced a PCB handoff for this BOM yet'
                      : 'Generate the schematic, PCB layout and 3D view'
                  }
                >
                  {job.status === 'running' ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <CircuitBoard className="w-4 h-4 mr-2" />
                  )}
                  {job.status === 'running' ? 'Generating…' : billingEnabled ? 'Generate PCB · up to 101 credits' : 'Generate PCB'}
                </Button>
              )}
            </div>
          </div>

          {job.status === 'error' && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="min-w-0">
                <p className="text-xs text-foreground">Board generation failed.</p>
                <p className="mt-0.5 break-words font-mono text-[10px] text-muted-foreground">{job.error}</p>
              </div>
            </div>
          )}

          {componentCount === 0 && job.status === 'idle' && (
            <p className="rounded-lg border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
              The pipeline has not produced a PCB handoff for this BOM yet, so the board cannot be generated.
              Re-run the pipeline from the Chat tab.
            </p>
          )}

          {/* Summary Stats */}
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-secondary rounded-lg border border-border p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Total Items</p>
              <p className="text-2xl font-bold mt-1">{rows.length}</p>
            </div>
            <div className="bg-secondary rounded-lg border border-border p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">
                Estimated Cost ({currency})
              </p>
              <p className="text-2xl font-bold mt-1">{totalFormatted ?? '—'}</p>
            </div>
            <div className="bg-secondary rounded-lg border border-border p-4">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Categories</p>
              <p className="text-2xl font-bold mt-1">
                {new Set(rows.map((r) => r.category).filter(Boolean)).size || '—'}
              </p>
            </div>
          </div>

          {/* BOM Table */}
          <div className="bg-secondary rounded-lg border border-border overflow-hidden">
            <Table>
              <TableHeader className="bg-primary/5">
                <TableRow className="border-b border-border hover:bg-transparent">
                  <TableHead className="h-10 text-xs font-semibold text-muted-foreground">Designator</TableHead>
                  <TableHead className="h-10 text-xs font-semibold text-muted-foreground">Component</TableHead>
                  <TableHead className="h-10 text-xs font-semibold text-muted-foreground text-right">Qty</TableHead>
                  <TableHead className="h-10 text-xs font-semibold text-muted-foreground">Category</TableHead>
                  <TableHead className="h-10 text-xs font-semibold text-muted-foreground">Cost ({currency})</TableHead>
                  <TableHead className="h-10 text-xs font-semibold text-muted-foreground">Availability</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((item, idx) => {
                  const unit = unitPriceUsd(item);
                  return (
                    <TableRow key={idx} className="border-b border-border hover:bg-primary/5 cursor-pointer transition-colors">
                      <TableCell className="h-10 text-xs font-mono text-accent">
                        {item.reference ?? item.designator ?? `#${idx + 1}`}
                      </TableCell>
                      <TableCell className="h-10 text-xs text-foreground">
                        {item.mfr_part ?? item.part_number ?? item.component ?? '—'}
                        {item.manufacturer ? <span className="text-muted-foreground block text-[10px]">{item.manufacturer}</span> : null}
                      </TableCell>
                      <TableCell className="h-10 text-xs text-muted-foreground text-right">
                        {quantityOf(item)}
                      </TableCell>
                      <TableCell className="h-10 text-xs">
                        {item.category ? (
                          <span className="bg-primary/10 text-accent px-2 py-1 rounded text-xs">{item.category}</span>
                        ) : '—'}
                      </TableCell>
                      <TableCell className="h-10 text-xs font-semibold text-foreground">
                        {unit === null ? '—' : money(unit)}
                      </TableCell>
                      <TableCell className="h-10 text-xs text-accent">
                        {item.availability ?? item.stock ?? '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {typeof bom.summary === 'string' && bom.summary && (
            <div className="bg-accent/10 border border-accent/20 rounded-lg p-4">
              <p className="text-xs text-foreground">{bom.summary}</p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
