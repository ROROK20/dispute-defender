/**
 * Next.js instrumentation hook. On the Node.js server runtime it runs the
 * boot work in instrumentation-node.ts: release orphaned runs, start the
 * dispute poller (C4) so disputes whose webhook was slow or lost still get
 * a run. The `=== 'nodejs'` block form lets Next drop the import from the
 * edge bundle, which cannot load better-sqlite3.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
