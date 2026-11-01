'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AgGridReact, type CustomCellRendererProps } from 'ag-grid-react';
import {
  AllCommunityModule,
  ModuleRegistry,
  type ColDef,
  type GetRowIdParams,
  type GridApi,
  type GridReadyEvent,
  type IsFullWidthRowParams,
  type PostSortRowsParams,
  type RowHeightParams,
} from 'ag-grid-community';
import clsx from 'clsx';
import { gridTheme } from './gridTheme';
import AmountCell, { formatCents } from './AmountCell';
import DeadlineCell from './DeadlineCell';
import StatusPill, { statusDisplay } from './StatusPill';
import StrengthBarCell from './StrengthBarCell';
import ReasonCell, { reasonLabel } from './ReasonCell';
import RecommendationCell, { recommendationLabel } from './RecommendationCell';
import GroupHeaderRow from './GroupHeaderRow';
import TraceDetailRow from './TraceDetailRow';
import { useNow } from '../../hooks/useNow';

ModuleRegistry.registerModules([AllCommunityModule]);

export type LatestRun = {
  id: string;
  status: 'queued' | 'running' | 'draft_ready' | 'failed' | 'submitted' | 'conceded';
  draft_ready_ms: number | null;
  submitted_ms: number | null;
};

export type DisputeRow = {
  id: string;
  source: 'paypal_sandbox' | 'fixture';
  reason: string;
  status: string;
  stage: string | null;
  amount_cents: number;
  currency: string;
  sku: string | null;
  sku_name: string | null;
  buyer_name: string | null;
  seller_response_due_at: string | null;
  strength_score: number | null;
  recommendation: 'FIGHT' | 'ACCEPT_CLAIM' | 'MAKE_OFFER' | null;
  outcome?: string | null;
  latest_run: LatestRun | null;
};

export type GridRow = Partial<DisputeRow> & {
  __rowId: string;
  __kind?: 'group' | 'detail';
  __expanded?: boolean;
  groupLabel?: string;
  groupCount?: number;
  groupTotalCents?: number;
  groupDueSoon?: number;
  parentId?: string;
  runId?: string | null;
  dueSoonCount?: number;
};

type GroupBy = 'none' | 'reason' | 'sku' | 'status' | 'recommendation';

const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: 'none', label: 'No grouping' },
  { value: 'reason', label: 'Reason code' },
  { value: 'sku', label: 'SKU' },
  { value: 'status', label: 'Status' },
  { value: 'recommendation', label: 'Recommendation' },
];

const DUE_SOON_MS = 48 * 3_600_000;
const REFRESH_MS = 15_000;

type GridContext = { toggle: (id: string) => void };

function isActive(d: DisputeRow): boolean {
  return d.status !== 'RESOLVED';
}

function isDueSoon(d: DisputeRow, now: number): boolean {
  if (!isActive(d) || !d.seller_response_due_at) return false;
  const due = Date.parse(d.seller_response_due_at);
  return Number.isFinite(due) && due > now && due - now < DUE_SOON_MS;
}

function groupKey(d: DisputeRow, groupBy: GroupBy): { key: string; label: string } {
  switch (groupBy) {
    case 'reason':
      return { key: d.reason, label: reasonLabel(d.reason) };
    case 'sku':
      return {
        key: d.sku ?? '__none',
        label: d.sku ? `${d.sku}${d.sku_name ? ` · ${d.sku_name}` : ''}` : 'No SKU',
      };
    case 'status': {
      const s = statusDisplay(d.status, d.outcome ?? null, d.latest_run?.status ?? null);
      return { key: s.label, label: s.label };
    }
    case 'recommendation':
      return { key: d.recommendation ?? '__none', label: d.recommendation ? recommendationLabel(d.recommendation) : 'Not analyzed' };
    default:
      return { key: 'all', label: 'All' };
  }
}

function disputeToRow(d: DisputeRow, expanded: Set<string>): GridRow {
  return { ...d, __rowId: d.id, __expanded: expanded.has(d.id) };
}

function detailRow(d: DisputeRow): GridRow {
  return {
    __rowId: `detail:${d.id}`,
    __kind: 'detail',
    parentId: d.id,
    runId: d.latest_run?.id ?? null,
    latest_run: d.latest_run,
    source: d.source,
  };
}

function dueTime(d: DisputeRow): number {
  const t = d.seller_response_due_at ? Date.parse(d.seller_response_due_at) : NaN;
  return Number.isFinite(t) ? t : Number.MAX_SAFE_INTEGER;
}

export function buildRows(disputes: DisputeRow[], groupBy: GroupBy, expanded: Set<string>, now: number): GridRow[] {
  const rows: GridRow[] = [];
  const pushDispute = (d: DisputeRow) => {
    rows.push(disputeToRow(d, expanded));
    if (expanded.has(d.id)) rows.push(detailRow(d));
  };

  if (groupBy === 'none') {
    disputes.forEach(pushDispute);
    return rows;
  }

  const groups = new Map<string, { label: string; items: DisputeRow[] }>();
  for (const d of disputes) {
    const { key, label } = groupKey(d, groupBy);
    const g = groups.get(key);
    if (g) g.items.push(d);
    else groups.set(key, { label, items: [d] });
  }

  const ordered = [...groups.entries()].sort((a, b) => {
    const ta = a[1].items.reduce((s, d) => s + d.amount_cents, 0);
    const tb = b[1].items.reduce((s, d) => s + d.amount_cents, 0);
    return tb - ta || a[1].label.localeCompare(b[1].label);
  });

  for (const [key, g] of ordered) {
    rows.push({
      __rowId: `group:${groupBy}:${key}`,
      __kind: 'group',
      groupLabel: g.label,
      groupCount: g.items.length,
      groupTotalCents: g.items.reduce((s, d) => s + d.amount_cents, 0),
      groupDueSoon: g.items.filter((d) => isDueSoon(d, now)).length,
    });
    [...g.items].sort((a, b) => dueTime(a) - dueTime(b)).forEach(pushDispute);
  }
  return rows;
}

function ExpandCell(props: CustomCellRendererProps<GridRow, unknown, GridContext>) {
  const data = props.data;
  if (!data || data.__kind || props.node.rowPinned || !data.id) return null;
  const id = data.id;
  return (
    <div className="flex h-full items-center">
      <button
        type="button"
        aria-expanded={Boolean(data.__expanded)}
        aria-label={data.__expanded ? `Hide agent trace for ${id}` : `Show agent trace for ${id}`}
        onClick={(e) => {
          e.stopPropagation();
          props.context?.toggle(id);
        }}
        className="flex h-7 w-7 items-center justify-center rounded-md border border-stone-200 bg-white text-stone-600 hover:border-teal-700 hover:text-teal-700"
      >
        <svg
          viewBox="0 0 20 20"
          aria-hidden
          className={clsx('h-4 w-4 transition-transform', data.__expanded && 'rotate-90')}
        >
          <path d="M7 5l6 5-6 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}

function IdCell(props: CustomCellRendererProps<GridRow>) {
  const data = props.data;
  if (props.node.rowPinned) {
    return <div className="flex h-full items-center font-semibold text-stone-900">Totals</div>;
  }
  if (!data?.id) return null;
  return (
    <div className="flex h-full min-w-0 flex-col justify-center leading-tight">
      <span className="flex min-w-0 items-center gap-1.5">
        <Link
          href={`/disputes/${encodeURIComponent(data.id)}`}
          className="truncate font-mono text-xs font-semibold text-teal-700 hover:underline"
        >
          {data.id}
        </Link>
        {data.source === 'fixture' && (
          <span className="shrink-0 rounded bg-stone-100 px-1.5 py-px text-[10px] font-medium text-stone-600 ring-1 ring-stone-200">
            Fixture history
          </span>
        )}
      </span>
      <span className="truncate text-xs text-stone-500">{data.buyer_name ?? 'Unknown buyer'}</span>
    </div>
  );
}

function SkuCell(props: CustomCellRendererProps<GridRow>) {
  const data = props.data;
  if (props.node.rowPinned || !data) return null;
  if (!data.sku) return <div className="flex h-full items-center text-xs text-stone-400">—</div>;
  return (
    <div className="flex h-full min-w-0 flex-col justify-center leading-tight">
      <span className="font-mono text-xs text-stone-700">{data.sku}</span>
      {data.sku_name && <span className="truncate text-xs text-stone-500">{data.sku_name}</span>}
    </div>
  );
}

function FullWidthRenderer(props: CustomCellRendererProps<GridRow>) {
  if (props.data?.__kind === 'group') return <GroupHeaderRow {...props} />;
  return <TraceDetailRow {...props} />;
}

function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string; code?: string } };
    return body.error?.message ?? body.error?.code ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

type DisputeGridProps = {
  initialDisputes?: DisputeRow[];
  className?: string;
  /** Height of the grid viewport (CSS). */
  height?: string;
};

export default function DisputeGrid({ initialDisputes, className, height = '70vh' }: DisputeGridProps) {
  const [disputes, setDisputes] = useState<DisputeRow[] | null>(initialDisputes ?? null);
  const [loading, setLoading] = useState(!initialDisputes);
  const [error, setError] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [quickFilter, setQuickFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [api, setApi] = useState<GridApi<GridRow> | null>(null);
  const now = useNow(60_000);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (showSpinner: boolean) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (showSpinner) setLoading(true);
    try {
      const res = await fetch('/api/disputes', { cache: 'no-store', signal: controller.signal });
      if (!res.ok) throw new Error(await readError(res));
      const body = (await res.json()) as { disputes?: DisputeRow[] };
      setDisputes(Array.isArray(body.disputes) ? body.disputes : []);
      setError(null);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : 'Could not load disputes.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(!initialDisputes);
    const timer = setInterval(() => void load(false), REFRESH_MS);
    const onRefresh = () => void load(false);
    window.addEventListener('disputes:refresh', onRefresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('disputes:refresh', onRefresh);
      abortRef.current?.abort();
    };
  }, [load, initialDisputes]);

  const toggleRef = useRef<(id: string) => void>(() => undefined);
  toggleRef.current = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const context = useMemo<GridContext>(() => ({ toggle: (id: string) => toggleRef.current(id) }), []);

  const rowData = useMemo(
    () => (disputes ? buildRows(disputes, groupBy, expanded, now) : []),
    [disputes, groupBy, expanded, now],
  );

  const pinnedBottomRowData = useMemo<GridRow[]>(() => {
    if (!disputes || disputes.length === 0) return [];
    const active = disputes.filter(isActive);
    return [
      {
        __rowId: 'totals',
        amount_cents: active.reduce((s, d) => s + d.amount_cents, 0),
        currency: active[0]?.currency ?? 'USD',
        dueSoonCount: active.filter((d) => isDueSoon(d, now)).length,
      },
    ];
  }, [disputes, now]);

  const sortable = groupBy === 'none';

  const columnDefs = useMemo<ColDef<GridRow>[]>(
    () => [
      {
        colId: 'expand',
        headerName: '',
        width: 56,
        minWidth: 56,
        maxWidth: 56,
        sortable: false,
        resizable: false,
        suppressMovable: true,
        cellRenderer: ExpandCell,
        getQuickFilterText: () => '',
      },
      {
        colId: 'id',
        headerName: 'Dispute',
        valueGetter: (p) => p.data?.id ?? p.data?.parentId ?? p.data?.groupLabel ?? '',
        getQuickFilterText: (p) =>
          [p.data?.id, p.data?.parentId, p.data?.groupLabel, p.data?.buyer_name].filter(Boolean).join(' '),
        cellRenderer: IdCell,
        minWidth: 200,
        flex: 1.3,
      },
      {
        field: 'reason',
        headerName: 'Reason',
        cellRenderer: ReasonCell,
        getQuickFilterText: (p) => `${p.data?.reason ?? ''} ${reasonLabel(p.data?.reason)}`,
        minWidth: 180,
        flex: 1.2,
      },
      {
        field: 'sku',
        headerName: 'SKU',
        cellRenderer: SkuCell,
        getQuickFilterText: (p) => `${p.data?.sku ?? ''} ${p.data?.sku_name ?? ''}`,
        minWidth: 140,
        flex: 1,
      },
      {
        field: 'status',
        headerName: 'Status',
        cellRenderer: StatusPill,
        getQuickFilterText: (p) =>
          `${p.data?.status ?? ''} ${statusDisplay(p.data?.status, p.data?.outcome ?? null, p.data?.latest_run?.status ?? null).label}`,
        minWidth: 150,
      },
      {
        field: 'amount_cents',
        headerName: 'Amount',
        type: 'rightAligned',
        cellRenderer: AmountCell,
        valueFormatter: (p) => formatCents(p.value as number | null, p.data?.currency ?? 'USD'),
        minWidth: 120,
      },
      {
        field: 'seller_response_due_at',
        headerName: 'Deadline',
        cellRenderer: DeadlineCell,
        comparator: (a: string | null, b: string | null) => {
          const ta = a ? Date.parse(a) : Number.MAX_SAFE_INTEGER;
          const tb = b ? Date.parse(b) : Number.MAX_SAFE_INTEGER;
          return ta - tb;
        },
        sort: sortable ? 'asc' : undefined,
        getQuickFilterText: () => '',
        minWidth: 140,
      },
      {
        field: 'strength_score',
        headerName: 'Strength',
        headerTooltip: 'Evidence strength score from the published rubric. Not a trained win probability.',
        cellRenderer: StrengthBarCell,
        minWidth: 150,
      },
      {
        field: 'recommendation',
        headerName: 'Recommendation',
        cellRenderer: RecommendationCell,
        getQuickFilterText: (p) => recommendationLabel(p.data?.recommendation),
        minWidth: 150,
      },
      {
        colId: 'draft_time',
        headerName: 'Draft ready in',
        headerTooltip: 'Measured: draft_ready_at − webhook received_at for the latest run.',
        valueGetter: (p) => p.data?.latest_run?.draft_ready_ms ?? null,
        valueFormatter: (p) => (p.node?.rowPinned || p.data?.__kind ? '' : formatMs(p.value as number | null)),
        cellClass: 'tabular-nums text-stone-600',
        getQuickFilterText: () => '',
        minWidth: 120,
      },
    ],
    [sortable],
  );

  const defaultColDef = useMemo<ColDef<GridRow>>(
    () => ({ sortable, resizable: true, suppressHeaderMenuButton: true }),
    [sortable],
  );

  const isFullWidthRow = useCallback(
    (p: IsFullWidthRowParams<GridRow>) => Boolean(p.rowNode.data?.__kind),
    [],
  );

  const getRowHeight = useCallback((p: RowHeightParams<GridRow>) => {
    if (p.data?.__kind === 'group') return 44;
    if (p.data?.__kind === 'detail') return 340;
    return undefined;
  }, []);

  const getRowId = useCallback((p: GetRowIdParams<GridRow>) => p.data.__rowId, []);

  // Keep each expanded trace row directly under its dispute after a column sort.
  const postSortRows = useCallback((params: PostSortRowsParams<GridRow>) => {
    const nodes = params.nodes;
    const details = new Map<string, (typeof nodes)[number]>();
    const rest: typeof nodes = [];
    for (const n of nodes) {
      if (n.data?.__kind === 'detail' && n.data.parentId) details.set(n.data.parentId, n);
      else rest.push(n);
    }
    if (details.size === 0) return;
    const out: typeof nodes = [];
    for (const n of rest) {
      out.push(n);
      const id = !n.data?.__kind ? n.data?.id : undefined;
      const d = id ? details.get(id) : undefined;
      if (d) out.push(d);
    }
    nodes.splice(0, nodes.length, ...out);
  }, []);

  const onGridReady = useCallback((e: GridReadyEvent<GridRow>) => setApi(e.api), []);

  const exportCsv = useCallback(() => {
    if (!api) return;
    try {
      api.exportDataAsCsv({
        fileName: `disputes-${new Date().toISOString().slice(0, 10)}.csv`,
        columnKeys: ['id', 'reason', 'sku', 'status', 'amount_cents', 'seller_response_due_at', 'strength_score', 'recommendation', 'draft_time'],
        skipPinnedBottom: true,
        shouldRowBeSkipped: (p) => Boolean(p.node.data?.__kind),
        processCellCallback: (p) => {
          if (p.column.getColId() === 'amount_cents' && typeof p.value === 'number') return (p.value / 100).toFixed(2);
          return p.value === null || p.value === undefined ? '' : String(p.value);
        },
      });
    } catch (err) {
      setError(err instanceof Error ? `CSV export failed: ${err.message}` : 'CSV export failed.');
    }
  }, [api]);

  const empty = !loading && !error && disputes !== null && disputes.length === 0;

  return (
    <section className={clsx('flex flex-col gap-3', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1 sm:max-w-xs">
          <span className="sr-only">Filter disputes</span>
          <input
            type="search"
            value={quickFilter}
            onChange={(e) => setQuickFilter(e.target.value)}
            placeholder="Filter by id, buyer, SKU, reason…"
            className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-stone-600">
          <span>Group by</span>
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value as GroupBy)}
            className="rounded-md border border-stone-300 bg-white px-2 py-2 text-sm outline-none focus:border-teal-700"
          >
            {GROUP_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load(false)}
            className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 hover:border-teal-700 hover:text-teal-700"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={exportCsv}
            disabled={!api || !disputes?.length}
            className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 hover:border-teal-700 hover:text-teal-700 disabled:opacity-50"
          >
            Export CSV
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          <span>Could not load disputes: {error}</span>
          <button type="button" onClick={() => void load(true)} className="font-semibold underline">
            Retry
          </button>
        </div>
      )}

      {loading && disputes === null ? (
        <div className="space-y-2 rounded-xl border border-stone-200 bg-white p-4" aria-busy aria-label="Loading disputes">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-10 animate-pulse rounded bg-stone-100" />
          ))}
        </div>
      ) : empty ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-stone-300 bg-white px-6 py-16 text-center">
          <p className="text-base font-semibold text-stone-900">No disputes yet</p>
          <p className="max-w-md text-sm text-stone-600">
            When a buyer opens a dispute in the PayPal sandbox, the webhook or the 30-second poller brings it here and the
            agent starts on it. You can also trigger a staged sandbox dispute.
          </p>
        </div>
      ) : (
        <div className="w-full overflow-hidden" style={{ height }}>
          <AgGridReact<GridRow>
            theme={gridTheme}
            rowData={rowData}
            columnDefs={columnDefs}
            defaultColDef={defaultColDef}
            context={context}
            getRowId={getRowId}
            isFullWidthRow={isFullWidthRow}
            fullWidthCellRenderer={FullWidthRenderer}
            embedFullWidthRows
            getRowHeight={getRowHeight}
            postSortRows={postSortRows}
            quickFilterText={quickFilter}
            pinnedBottomRowData={pinnedBottomRowData}
            onGridReady={onGridReady}
            suppressCellFocus
            animateRows={false}
            tooltipShowDelay={300}
            overlayNoRowsTemplate="<span class='text-sm text-stone-500'>No disputes match this filter.</span>"
          />
        </div>
      )}
    </section>
  );
}

export { DisputeGrid };