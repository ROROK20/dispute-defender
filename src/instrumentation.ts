/**
 * Next.js instrumentation hook. On the Node.js server runtime it releases runs
 * a dead process left queued or running, then starts the dispute poller (C4),
 * so disputes whose webhook was slow or lost still get a run.
 *
 * startPoller() guards itself against a second start (HMR, repeated register
 * calls); this hook must not set that guard first, or the poller never runs.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  try {
    const { failOrphanedRuns } = await import('./lib/repo/runs');
    const released = failOrphanedRuns('Released at server start: the process running it stopped.');
    if (released > 0) console.info(`[boot] released ${released} orphaned run(s)`);
  } catch (err) {
    console.error(`[boot] could not release orphaned runs: ${(err as Error).message}`);
  }

  try {
    const { startPoller } = await import('./lib/sync');
    startPoller();
  } catch (err) {
    console.error(`[poller] failed to start: ${(err as Error).message}`);
  }
}
