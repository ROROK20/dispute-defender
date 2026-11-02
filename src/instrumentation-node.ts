import { failOrphanedRuns } from './lib/repo/runs';
import { startPoller } from './lib/sync';

/**
 * Node.js-only boot work, imported from instrumentation.ts behind the
 * NEXT_RUNTIME check so the edge bundle never pulls in better-sqlite3.
 * Releases runs a dead process left queued or running, then starts the
 * dispute poller (C4), which guards itself against a second start.
 */
try {
  const released = failOrphanedRuns('Released at server start: the process running it stopped.');
  if (released > 0) console.info(`[boot] released ${released} orphaned run(s)`);
} catch (err) {
  console.error(`[boot] could not release orphaned runs: ${(err as Error).message}`);
}

try {
  startPoller();
} catch (err) {
  console.error(`[poller] failed to start: ${(err as Error).message}`);
}
