'use client';

import { useEffect } from 'react';
import Link from 'next/link';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[ui] unhandled error', error);
  }, [error]);

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-center px-4 py-20 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-lost-soft text-lost" aria-hidden>
        !
      </div>
      <h1 className="mb-2 text-xl font-semibold">Something broke on this page</h1>
      <p className="mb-1 text-sm text-ink-muted">
        Nothing was sent to PayPal. Submissions only happen when you press Approve, and this error stopped before that.
      </p>
      <p className="mb-6 break-all font-mono text-xs text-ink-faint">
        {error.message || 'Unknown error'}
        {error.digest ? ` · ref ${error.digest}` : ''}
      </p>
      <div className="flex gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
        >
          Try again
        </button>
        <Link href="/" className="rounded-md border border-line bg-surface px-4 py-2 text-sm font-medium hover:bg-canvas">
          Back to inbox
        </Link>
      </div>
    </div>
  );
}