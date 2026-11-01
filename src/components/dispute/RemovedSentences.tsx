'use client';

import { useState } from 'react';

export interface RemovedSentence {
  id: string;
  text: string;
  reason: string;
  token?: string | null;
}

const REASON_TEXT: Record<string, string> = {
  NO_CITATION: 'no citation',
  UNKNOWN_SOURCE: 'cites a source that does not exist in this run',
  UNGROUNDED_TOKEN: 'contains a fact not found in its cited sources',
};

export function RemovedSentences({ removed, defaultOpen = false }: { removed: RemovedSentence[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  if (removed.length === 0) return null;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-left text-sm font-medium text-slate-700"
      >
        <span>
          Removed, unsupported <span className="ml-1 rounded-full bg-red-50 px-2 text-xs text-red-700">{removed.length}</span>
        </span>
        <span aria-hidden className="text-slate-400">
          {open ? '−' : '+'}
        </span>
      </button>
      <p className="mt-0.5 text-xs text-slate-500">
        These sentences failed the citation check after repair and will not be submitted.
      </p>
      {open ? (
        <ul className="mt-2 space-y-2">
          {removed.map((r) => (
            <li key={r.id} className="rounded-md border border-red-100 bg-red-50/60 p-2.5">
              <p className="text-sm text-slate-500 line-through decoration-red-400">{r.text}</p>
              <p className="mt-1 text-xs text-red-700">
                <span className="font-mono">{r.id}</span>: {REASON_TEXT[r.reason] ?? r.reason}
                {r.token ? (
                  <>
                    {' '}
                    (<code className="rounded bg-white px-1">{r.token}</code>)
                  </>
                ) : null}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default RemovedSentences;