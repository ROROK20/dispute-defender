import clsx from 'clsx';

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={clsx('animate-pulse rounded bg-slate-200', className ?? 'h-4 w-full')} />;
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={clsx('space-y-2', className)} role="status" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={clsx('h-3.5', i === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}

export function SkeletonRows({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={clsx('overflow-hidden rounded-lg border border-slate-200 bg-white', className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-4 border-b border-slate-100 px-4 py-3 last:border-b-0">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonCard({ className }: { className?: string }) {
  return (
    <div className={clsx('rounded-lg border border-slate-200 bg-white p-4', className)}>
      <Skeleton className="mb-3 h-5 w-1/3" />
      <SkeletonText lines={4} />
    </div>
  );
}

export default Skeleton;