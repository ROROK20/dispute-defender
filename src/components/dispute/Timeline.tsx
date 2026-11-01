import clsx from 'clsx';

export interface TimelineItem {
  at: string;
  label: string;
  detail?: string | null;
  tone?: 'default' | 'accent' | 'good' | 'bad' | 'warn';
  future?: boolean;
}

type Loose = Record<string, unknown> | null | undefined;

export interface TimelineProps {
  items?: TimelineItem[];
  dispute?: Loose;
  order?: Loose;
  run?: Loose;
  decisions?: Loose[];
  className?: string;
}

function str(obj: Loose, key: string): string | null {
  if (!obj) return null;
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function buildTimelineItems({ dispute, order, run, decisions }: Omit<TimelineProps, 'items' | 'className'>): TimelineItem[] {
  const items: TimelineItem[] = [];
  const captured = str(order, 'captured_at');
  if (captured) items.push({ at: captured, label: 'Payment captured', detail: str(order, 'capture_id') });
  const tracking = str(order, 'tracking_number');
  if (tracking && captured) {
    items.push({
      at: captured,
      label: 'Tracking attached in PayPal',
      detail: `${str(order, 'carrier') ?? 'Carrier'} ${tracking}${str(order, 'tracker_status') ? ` · ${str(order, 'tracker_status')}` : ''}`,
    });
  }
  const opened = str(dispute, 'pp_created_at');
  if (opened) items.push({ at: opened, label: 'Buyer opened dispute', tone: 'warn', detail: str(dispute, 'reason') });
  const clock = str(run, 'clock_started_at');
  if (clock) items.push({ at: clock, label: 'Trigger event received', tone: 'accent' });
  const draft = str(run, 'draft_ready_at');
  if (draft) items.push({ at: draft, label: 'Draft ready for approval', tone: 'accent' });
  for (const d of decisions ?? []) {
    const at = str(d, 'created_at');
    if (!at) continue;
    const action = (str(d, 'action') ?? 'decision').replace(/_/g, ' ');
    const result = str(d, 'result');
    items.push({
      at,
      label: `Seller approved: ${action}`,
      detail: result,
      tone: result === 'success' ? 'good' : result === 'failed' ? 'bad' : 'default',
    });
  }
  const finished = str(run, 'finished_at');
  if (finished) items.push({ at: finished, label: 'PayPal accepted the action', tone: 'good' });
  const outcome = str(dispute, 'outcome');
  const updated = str(dispute, 'pp_updated_at');
  if (outcome && updated) {
    items.push({
      at: updated,
      label: `Resolved: ${outcome.replace(/_/g, ' ').toLowerCase()}`,
      tone: outcome.includes('SELLER') ? 'good' : 'bad',
    });
  }
  const due = str(dispute, 'seller_response_due_at');
  if (due) {
    const future = new Date(due).getTime() > Date.now();
    items.push({ at: due, label: 'Seller response deadline', tone: future ? 'warn' : 'default', future });
  }
  return items
    .filter((i) => !Number.isNaN(new Date(i.at).getTime()))
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

const DOT: Record<NonNullable<TimelineItem['tone']>, string> = {
  default: 'bg-slate-400',
  accent: 'bg-teal-600',
  good: 'bg-green-600',
  bad: 'bg-red-600',
  warn: 'bg-amber-500',
};

function fmt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    hour12: false,
  }) + ' UTC';
}

export function Timeline({ items, dispute, order, run, decisions, className }: TimelineProps) {
  const list = items ?? buildTimelineItems({ dispute, order, run, decisions });
  return (
    <section className={clsx('rounded-lg border border-slate-200 bg-white p-4', className)} aria-label="Timeline">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">Timeline</h2>
      {list.length === 0 ? (
        <p className="text-sm text-slate-500">No dated events yet.</p>
      ) : (
        <ol className="relative space-y-3 before:absolute before:bottom-1 before:left-[4px] before:top-1 before:w-px before:bg-slate-200">
          {list.map((item, i) => (
            <li key={`${item.at}-${i}`} className={clsx('relative pl-6', item.future && 'opacity-80')}>
              <span
                aria-hidden
                className={clsx(
                  'absolute left-0 top-1.5 h-2.5 w-2.5 rounded-full ring-4 ring-white',
                  DOT[item.tone ?? 'default'],
                  item.future && 'ring-amber-100',
                )}
              />
              <div className="text-sm text-slate-900">{item.label}</div>
              <div className="font-mono text-[11px] text-slate-500">
                {fmt(item.at)}
                {item.future ? ' · upcoming' : ''}
              </div>
              {item.detail ? <div className="break-words text-xs text-slate-600">{item.detail}</div> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default Timeline;