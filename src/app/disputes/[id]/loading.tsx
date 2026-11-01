export default function DisputeLoading() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading dispute…</span>
      <div className="dd-skeleton mb-2 h-4 w-24" />
      <div className="dd-skeleton mb-2 h-8 w-72" />
      <div className="dd-skeleton mb-6 h-4 w-96 max-w-full" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_380px]">
        <div className="space-y-4">
          <div className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
            {Array.from({ length: 7 }).map((_, i) => (
              <div key={i} className="dd-skeleton mb-3 h-5 w-full last:mb-0" />
            ))}
          </div>
          <div className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="dd-skeleton mb-3 h-4 w-full last:mb-0" />
            ))}
          </div>
        </div>
        <div className="space-y-4">
          <div className="dd-skeleton h-28 w-full" />
          <div className="dd-skeleton h-56 w-full" />
        </div>
      </div>
    </div>
  );
}