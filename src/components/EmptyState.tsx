import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, action, icon, className }: EmptyStateProps) {
  return (
    <div
      className={clsx(
        'flex flex-col items-center justify-center rounded-lg border border-dashed border-slate-300 bg-white px-6 py-12 text-center',
        className,
      )}
    >
      <div aria-hidden className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-teal-50 text-teal-700">
        {icon ?? (
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M4 7h16M4 12h16M4 17h10" strokeLinecap="round" />
          </svg>
        )}
      </div>
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      {description ? <div className="mt-1 max-w-md text-sm text-slate-600">{description}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export default EmptyState;