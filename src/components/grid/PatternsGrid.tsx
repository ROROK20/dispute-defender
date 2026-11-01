'use client';

import { useCallback, useMemo, useState } from 'react';
import { AgGridReact, type CustomCellRendererProps } from 'ag-grid-react';
import {
  AllCommunityModule,
  ModuleRegistry,
  type ColDef,
  type GetRowIdParams,
  type GridApi,
  type GridReadyEvent,
  type RowClickedEvent,
} from 'ag-grid-community';
import clsx from 'clsx';
import { gridTheme } from './gridTheme';
import { reasonLabel, reasonShort } from './ReasonCell';
import { parseQuotes, themeLabel, type Pattern } from '../patterns/PatternCard';

// Idempotent; this page may render without DisputeGrid having been imported.
ModuleRegistry.registerModules([AllCommunityModule]);

function HeadlineCell(props: CustomCellRendererProps<Pattern>) {
  const p = props.data;
  if (!p) return null;
  return (
    <div className="flex flex-col gap-1 py-2 leading-snug">
      <span className="text-sm font-semibold text-stone-900">{p.headline}</span>
      {Boolean(p.includes_fixture) && (
        <span className="w-fit rounded bg-stone-100 px-1.5 py-px text-[10px] font-medium text-stone-600 ring-1 ring-stone-200">
          Includes fixture history
        </span>
      )}
    </div>
  );
}

function ShareCell(props: CustomCellRendererProps<Pattern>) {
  const p = props.data;
  if (!p) return null;
  const total = Math.max(p.dispute_count, 0);
  const matching = Math.max(Math.min(p.matching_count, total), 0);
  const pct = total > 0 ? Math.round((matching / total) * 100) : 0;
  return (
    <div className="flex h-full flex-col justify-center gap-1">
      <span className="text-xs tabular-nums text-stone-800">
        <span className="font-semibold">{matching}</span> of {total}
      </span>
      <div className="h-1.5 w-full max-w-[90px] overflow-hidden rounded-full bg-stone-200" aria-hidden>
        <div className="h-full rounded-full bg-teal-700" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ReasonShortCell(props: CustomCellRendererProps<Pattern>) {
  const reason = props.data?.reason;
  return (
    <div className="flex h-full items-center gap-1.5" title={reasonLabel(reason)}>
      <span className="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-stone-600">
        {reasonShort(reason)}
      </span>
      <span className="truncate text-xs text-stone-700">{reasonLabel(reason)}</span>
    </div>
  );
}

function ThemeCell(props: CustomCellRendererProps<Pattern>) {
  const theme = props.data?.theme;
  if (!theme) return null;
  return (
    <div className="flex h-full items-center">
      <span className="rounded-full bg-teal-50 px-2 py-0.5 text-xs font-medium text-teal-800">{themeLabel(theme)}</span>
    </div>
  );
}

type Props = {
  patterns: Pattern[];
  onSelect?: (pattern: Pattern) => void;
  selectedId?: string | null;
  className?: string;
  height?: string;
};

export default function PatternsGrid({ patterns, onSelect, selectedId, className, height = '420px' }: Props) {
  const [quickFilter, setQuickFilter] = useState('');
  const [api, setApi] = useState<GridApi<Pattern> | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const columnDefs = useMemo<ColDef<Pattern>[]>(
    () => [
      { field: 'headline', headerName: 'Pattern', cellRenderer: HeadlineCell, wrapText: true, autoHeight: true, flex: 2.2, minWidth: 260 },
      { field: 'sku', headerName: 'SKU', minWidth: 100, cellClass: 'font-mono text-xs' },
      {
        field: 'reason',
        headerName: 'Reason',
        cellRenderer: ReasonShortCell,
        getQuickFilterText: (p) => `${p.data?.reason ?? ''} ${reasonLabel(p.data?.reason)}`,
        minWidth: 170,
      },
      {
        field: 'theme',
        headerName: 'Theme',
        cellRenderer: ThemeCell,
        getQuickFilterText: (p) => themeLabel(p.data?.theme ?? ''),
        minWidth: 140,
      },
      {
        colId: 'share',
        headerName: 'Matching',
        headerTooltip: 'Disputes with at least one buyer message tagged with this theme, counted by code.',
        valueGetter: (p) => (p.data && p.data.dispute_count > 0 ? p.data.matching_count / p.data.dispute_count : 0),
        cellRenderer: ShareCell,
        sort: 'desc',
        minWidth: 120,
      },
      { field: 'action', headerName: 'Prevention action', wrapText: true, autoHeight: true, flex: 1.8, minWidth: 220, cellClass: 'py-2 text-sm leading-snug' },
      {
        colId: 'quotes',
        headerName: 'Quotes',
        valueGetter: (p) => (p.data ? parseQuotes(p.data).length : 0),
        type: 'rightAligned',
        minWidth: 90,
      },
    ],
    [],
  );

  const defaultColDef = useMemo<ColDef<Pattern>>(() => ({ sortable: true, resizable: true, suppressHeaderMenuButton: true }), []);
  const getRowId = useCallback((p: GetRowIdParams<Pattern>) => p.data.id, []);
  const onGridReady = useCallback((e: GridReadyEvent<Pattern>) => setApi(e.api), []);
  const onRowClicked = useCallback(
    (e: RowClickedEvent<Pattern>) => {
      if (e.data && onSelect) onSelect(e.data);
    },
    [onSelect],
  );

  const exportCsv = useCallback(() => {
    if (!api) return;
    try {
      setExportError(null);
      api.exportDataAsCsv({ fileName: `dispute-patterns-${new Date().toISOString().slice(0, 10)}.csv` });
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'CSV export failed.');
    }
  }, [api]);

  if (patterns.length === 0) {
    return (
      <div className={clsx('rounded-xl border border-dashed border-stone-300 bg-white px-6 py-12 text-center', className)}>
        <p className="text-base font-semibold text-stone-900">No patterns yet</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-stone-600">
          Patterns appear when two or more disputes share a SKU and reason code. Recompute after new disputes arrive.
        </p>
      </div>
    );
  }

  return (
    <section className={clsx('flex flex-col gap-3', className)}>
      <div className="flex flex-wrap items-center gap-2">
        <label className="min-w-0 flex-1 sm:max-w-xs">
          <span className="sr-only">Filter patterns</span>
          <input
            type="search"
            value={quickFilter}
            onChange={(e) => setQuickFilter(e.target.value)}
            placeholder="Filter by SKU, theme, action…"
            className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20"
          />
        </label>
        <button
          type="button"
          onClick={exportCsv}
          disabled={!api}
          className="ml-auto rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 hover:border-teal-700 hover:text-teal-700 disabled:opacity-50"
        >
          Export CSV
        </button>
      </div>
      {exportError && <p className="text-sm text-red-700">CSV export failed: {exportError}</p>}
      <div className="w-full overflow-hidden" style={{ height }}>
        <AgGridReact<Pattern>
          theme={gridTheme}
          rowData={patterns}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          getRowId={getRowId}
          quickFilterText={quickFilter}
          onGridReady={onGridReady}
          onRowClicked={onRowClicked}
          rowClassRules={{ 'bg-teal-50': (p) => Boolean(selectedId && p.data?.id === selectedId) }}
          rowStyle={onSelect ? { cursor: 'pointer' } : undefined}
          suppressCellFocus
          overlayNoRowsTemplate="<span class='text-sm text-stone-500'>No patterns match this filter.</span>"
        />
      </div>
    </section>
  );
}

export { PatternsGrid };