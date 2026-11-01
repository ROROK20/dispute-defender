export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading disputes…</span>
      <div className="dd-skeleton mb-2 h-7 w-56" />
      <div className="dd-skeleton mb-8 h-4 w-80" />
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="dd-skeleton h-20" />
        ))}
      </div>
      <div className="rounded-[var(--radius-card)] border border-line bg-surface p-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="dd-skeleton mb-3 h-8 w-full last:mb-0" />
        ))}
      </div>
    </div>
  );
}