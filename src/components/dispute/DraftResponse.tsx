'use client';

import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { CitationChip } from './CitationChip';
import { RemovedSentences, type RemovedSentence } from './RemovedSentences';

export interface DraftSentence {
  id: string;
  text: string;
  source_ids: string[];
}

export interface DraftSourceRef {
  source_key: string;
  title: string;
}

export interface DraftResponseProps {
  sentences: DraftSentence[];
  sources?: DraftSourceRef[];
  removed?: RemovedSentence[];
  editable?: boolean;
  reviewApplied?: boolean;
  citationRounds?: number | null;
  activeSourceKey?: string | null;
  onCitationClick?: (key: string) => void;
  onEditedChange?: (edited: { id: string; text: string }[]) => void;
  className?: string;
}

export function DraftResponse({
  sentences,
  sources = [],
  removed = [],
  editable = false,
  reviewApplied = false,
  citationRounds,
  activeSourceKey,
  onCitationClick,
  onEditedChange,
  className,
}: DraftResponseProps) {
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const titles = useMemo(() => new Map(sources.map((s) => [s.source_key, s.title])), [sources]);

  useEffect(() => {
    setEdits({});
  }, [sentences]);

  useEffect(() => {
    if (!onEditedChange) return;
    const changed = Object.entries(edits)
      .filter(([id, text]) => {
        const original = sentences.find((s) => s.id === id);
        return original && original.text !== text;
      })
      .map(([id, text]) => ({ id, text }));
    onEditedChange(changed);
  }, [edits, sentences, onEditedChange]);

  const editedCount = Object.entries(edits).filter(([id, text]) => sentences.find((s) => s.id === id)?.text !== text).length;

  return (
    <section className={clsx('rounded-lg border border-slate-200 bg-white', className)} aria-label="Draft response">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-slate-900">Draft response</h2>
          <span className="text-xs text-slate-500">{sentences.length} cited sentences</span>
          {reviewApplied ? (
            <span className="rounded-full bg-teal-50 px-2 py-0.5 text-[11px] font-medium text-teal-800">Reviewed wording</span>
          ) : null}
          {typeof citationRounds === 'number' && citationRounds > 0 ? (
            <span className="text-[11px] text-slate-500">
              {citationRounds} repair round{citationRounds === 1 ? '' : 's'}
            </span>
          ) : null}
        </div>
        {editable && sentences.length > 0 ? (
          <div className="flex items-center gap-2">
            {editedCount > 0 ? <span className="text-xs text-amber-700">{editedCount} edited</span> : null}
            {editedCount > 0 ? (
              <button type="button" onClick={() => setEdits({})} className="text-xs text-slate-500 hover:text-slate-900">
                Revert
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setEditing((e) => !e)}
              className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              {editing ? 'Done editing' : 'Edit wording'}
            </button>
          </div>
        ) : null}
      </header>

      <div className="px-4 py-3">
        {sentences.length === 0 ? (
          <p className="text-sm text-slate-500">No draft yet. It appears here when the agent finishes.</p>
        ) : editing ? (
          <ol className="space-y-3">
            {sentences.map((s) => {
              const value = edits[s.id] ?? s.text;
              return (
                <li key={s.id}>
                  <label className="mb-1 flex items-center gap-1 text-[11px] text-slate-500" htmlFor={`sent-${s.id}`}>
                    <span className="font-mono">{s.id}</span> cites
                    {s.source_ids.map((k) => (
                      <CitationChip key={k} sourceKey={k} title={titles.get(k)} missing={!titles.has(k) && sources.length > 0} onClick={onCitationClick} />
                    ))}
                  </label>
                  <textarea
                    id={`sent-${s.id}`}
                    value={value}
                    onChange={(e) => setEdits((prev) => ({ ...prev, [s.id]: e.target.value }))}
                    rows={2}
                    className={clsx(
                      'w-full resize-y rounded-md border px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600',
                      value !== s.text ? 'border-amber-300 bg-amber-50' : 'border-slate-300',
                    )}
                  />
                </li>
              );
            })}
            <p className="text-xs text-slate-500">
              Edited sentences keep their citations and are checked against those sources again before anything is sent.
            </p>
          </ol>
        ) : (
          <div className="space-y-2 text-[15px] leading-relaxed text-slate-800">
            {sentences.map((s) => {
              const text = edits[s.id] ?? s.text;
              return (
                <p key={s.id} className={clsx(text !== s.text && 'rounded bg-amber-50 px-1')}>
                  {text}
                  {s.source_ids.map((k) => (
                    <CitationChip
                      key={k}
                      sourceKey={k}
                      title={titles.get(k)}
                      active={activeSourceKey === k}
                      missing={!titles.has(k) && sources.length > 0}
                      onClick={onCitationClick}
                    />
                  ))}
                </p>
              );
            })}
          </div>
        )}
      </div>

      {removed.length > 0 ? (
        <div className="border-t border-slate-100 px-4 py-3">
          <RemovedSentences removed={removed} />
        </div>
      ) : null}
    </section>
  );
}

export default DraftResponse;