'use client';

import type { CustomCellRendererProps } from 'ag-grid-react';
import type { GridRow } from './DisputeGrid';

type Props = Partial<CustomCellRendererProps<GridRow>> & {
  score?: number | null;
};

export default function StrengthBarCell(props: Props) {
  if (props.node?.rowPinned) return null;
  const raw = props.score ?? (typeof props.value === 'number' ? props.value : props.data?.strength_score ?? null);

  if (raw === null || raw === undefined || !Number.isFinite(raw)) {
    return (
      <div className="flex h-full items-center text-xs text-stone-400" title="No agent run has scored this dispute yet">
        Not scored
      </div>
    );
  }

  const score = Math.max(0, Math.min(100, Math.round(raw)));

  return (
    <div
      className="flex h-full items-center gap-2"
      title={`Evidence strength ${score}/100 from the published rubric. Not a trained win probability.`}
    >
      <div
        className="h-2 w-full max-w-[96px] overflow-hidden rounded-full bg-stone-200"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={score}
        aria-label="Evidence strength"
      >
        <div className="h-full rounded-full bg-teal-700 transition-[width]" style={{ width: `${score}%` }} />
      </div>
      <span className="w-7 text-right text-xs font-semibold tabular-nums text-stone-800">{score}</span>
    </div>
  );
}

export { StrengthBarCell };