import clsx from 'clsx';

export interface EvOption {
  action: string;
  expected_cost_cents: number;
  formula: string;
  label?: string | null;
  note?: string | null;
}

export interface EvData {
  inputs?: Record<string, unknown>;
  options: EvOption[];
  recommended: string;
}

export function parseEv(v: EvData | string | null | undefined): EvData | null {
  if (!v) return null;
  if (typeof v === 'string') {
    try {
      const parsed = JSON.parse(v) as EvData;
      return Array.isArray(parsed.options) ? parsed : null;
    } catch {
      return null;
    }
  }
  return Array.isArray(v.options) ? v : null;
}

export const ACTION_LABEL: Record<string, string> = {
  FIGHT: 'Fight (submit evidence)',
  ACCEPT_CLAIM: 'Accept claim & refund',
  MAKE_OFFER: 'Make partial offer',
};

function normalizeAction(a: string): string {
  return a.toUpperCase();
}

function money(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

const INPUT_LABEL: Record<string, string> = {
  A: 'A · disputed amount',
  F: 'F · dispute fee',
  T: 'T · your time cost',
  C: 'C · item COGS',
  s: 's · strength used as a rough win proxy, not a trained probability',
  o: 'o · offer fraction',
};

function renderInput(v: unknown): string {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === 'string' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

export function ExpectedValueMath({ ev, className }: { ev: EvData | string | null | undefined; className?: string }) {
  const data = parseEv(ev);
  if (!data) {
    return (
      <section className={clsx('rounded-lg border border-slate-200 bg-white p-4', className)}>
        <h2 className="text-sm font-semibold text-slate-900">Expected cost</h2>
        <p className="mt-1 text-sm text-slate-500">Computed after the evidence is scored.</p>
      </section>
    );
  }
  const recommended = normalizeAction(data.recommended);
  const options = [...data.options].sort((a, b) => a.expected_cost_cents - b.expected_cost_cents);

  return (
    <section className={clsx('rounded-lg border border-slate-200 bg-white p-4', className)} aria-label="Expected cost math">
      <h2 className="text-sm font-semibold text-slate-900">Expected cost of each option</h2>
      <p className="mt-0.5 text-xs text-slate-500">Plain arithmetic. Lowest expected cost is recommended. The model cannot override it.</p>
      <ul className="mt-3 space-y-2">
        {options.map((o) => {
          const action = normalizeAction(o.action);
          const isRec = action === recommended;
          return (
            <li
              key={o.action}
              className={clsx('rounded-md border p-3', isRec ? 'border-teal-300 bg-teal-50' : 'border-slate-200')}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-slate-900">
                  {ACTION_LABEL[action] ?? o.action}
                  {isRec ? (
                    <span className="ml-2 rounded-full bg-teal-700 px-2 py-0.5 text-[10px] font-semibold uppercase text-white">
                      Recommended
                    </span>
                  ) : null}
                </span>
                <span className="font-mono text-sm font-semibold tabular-nums text-slate-900">{money(o.expected_cost_cents)}</span>
              </div>
              <code className="mt-1 block break-words font-mono text-xs text-slate-700">{o.formula}</code>
              {o.label || o.note ? <p className="mt-1 text-[11px] text-slate-500">{o.label ?? o.note}</p> : null}
            </li>
          );
        })}
      </ul>
      {data.inputs && Object.keys(data.inputs).length > 0 ? (
        <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 border-t border-slate-100 pt-3 text-xs sm:grid-cols-2">
          {Object.entries(data.inputs).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2">
              <dt className="text-slate-500">{INPUT_LABEL[k] ?? k}</dt>
              <dd className="font-mono tabular-nums text-slate-800">{renderInput(v)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </section>
  );
}

export default ExpectedValueMath;