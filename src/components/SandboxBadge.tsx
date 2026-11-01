import clsx from 'clsx';

export interface SandboxBadgeProps {
  env?: string;
  label?: string;
  className?: string;
}

export function SandboxBadge({ env = 'sandbox', label, className }: SandboxBadgeProps) {
  const isSandbox = env !== 'live';
  return (
    <span
      title={isSandbox ? 'PayPal sandbox: no real money moves. Store and buyers are fictional.' : 'PayPal live environment'}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        isSandbox ? 'border-slate-300 bg-slate-100 text-slate-700' : 'border-red-300 bg-red-50 text-red-700',
        className,
      )}
    >
      <span aria-hidden className={clsx('h-1.5 w-1.5 rounded-full', isSandbox ? 'bg-teal-600' : 'bg-red-600')} />
      {label ?? (isSandbox ? 'Sandbox demo data' : 'LIVE')}
    </span>
  );
}

export function FixtureBadge({ className }: { className?: string }) {
  return (
    <span
      title="Loaded from data/fixtures/historical-disputes.json. Read-only: never sent to PayPal."
      className={clsx(
        'inline-flex items-center rounded-full border border-slate-300 bg-white px-2 py-0.5 text-xs font-medium text-slate-600',
        className,
      )}
    >
      Fixture history
    </span>
  );
}

export default SandboxBadge;