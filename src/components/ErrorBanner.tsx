'use client';

import clsx from 'clsx';

export interface ErrorBannerProps {
  title?: string;
  message: string;
  code?: string | null;
  debugId?: string | null;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

export function ErrorBanner({
  title = 'Something went wrong',
  message,
  code,
  debugId,
  onRetry,
  retryLabel = 'Retry',
  className,
}: ErrorBannerProps) {
  return (
    <div role="alert" className={clsx('rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold">{title}</p>
          <p className="mt-1 break-words">{message}</p>
          {code || debugId ? (
            <p className="mt-2 font-mono text-xs text-red-700">
              {code ? <span>code {code}</span> : null}
              {code && debugId ? ' · ' : null}
              {debugId ? <span>paypal-debug-id {debugId}</span> : null}
            </p>
          ) : null}
        </div>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-100"
          >
            {retryLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export default ErrorBanner;