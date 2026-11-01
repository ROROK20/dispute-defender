'use client';

import clsx from 'clsx';

export interface CitationChipProps {
  sourceKey: string;
  title?: string | null;
  active?: boolean;
  missing?: boolean;
  onClick?: (sourceKey: string) => void;
}

export function CitationChip({ sourceKey, title, active = false, missing = false, onClick }: CitationChipProps) {
  return (
    <button
      type="button"
      onClick={() => onClick?.(sourceKey)}
      title={missing ? `${sourceKey} is not a source in this run` : (title ?? `Open source ${sourceKey}`)}
      aria-label={`Source ${sourceKey}${title ? `: ${title}` : ''}`}
      className={clsx(
        'mx-0.5 inline-flex items-center rounded px-1.5 py-px align-baseline font-mono text-[11px] font-semibold leading-4 transition-colors',
        missing
          ? 'border border-red-300 bg-red-50 text-red-700'
          : active
            ? 'bg-teal-700 text-white'
            : 'bg-teal-50 text-teal-800 ring-1 ring-inset ring-teal-200 hover:bg-teal-100',
      )}
    >
      {sourceKey}
    </button>
  );
}

export default CitationChip;