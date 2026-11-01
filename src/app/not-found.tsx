import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-center px-4 py-20 text-center">
      <p className="mb-2 font-mono text-sm text-ink-faint">404</p>
      <h1 className="mb-2 text-xl font-semibold">We couldn&apos;t find that page</h1>
      <p className="mb-6 text-sm text-ink-muted">
        The dispute may not be synced yet. The poller pulls new sandbox disputes every 30 seconds.
      </p>
      <Link href="/" className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover">
        Back to inbox
      </Link>
    </div>
  );
}