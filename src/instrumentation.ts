/**
 * Next.js instrumentation hook. On the Node.js server runtime it starts the
 * dispute poller (C4) once per process, so disputes whose webhook was slow or
 * lost still get a run.
 */

type PollerGlobal = typeof globalThis & { __ddPollerStarted?: boolean; __ddPollerTimer?: NodeJS.Timeout };

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const g = globalThis as PollerGlobal;
  if (g.__ddPollerStarted) return;
  g.__ddPollerStarted = true;

  try {
    const mod = (await import('./lib/sync')) as Record<string, unknown>;

    const starter = ['startPoller', 'startPolling', 'startSyncPoller']
      .map((n) => mod[n])
      .find((f): f is () => unknown => typeof f === 'function');
    if (starter) {
      await starter();
      return;
    }

    const once = ['syncDisputes', 'syncOnce', 'runSync', 'pollOnce']
      .map((n) => mod[n])
      .find((f): f is () => Promise<unknown> => typeof f === 'function');
    if (!once) {
      console.warn('[poller] src/lib/sync.ts exports no poller or sync function; poller not started');
      return;
    }

    const interval = Number(process.env.POLL_INTERVAL_MS) > 0 ? Number(process.env.POLL_INTERVAL_MS) : 30_000;
    let busy = false;
    const tick = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        await once();
      } catch (err) {
        console.error(`[poller] sync failed: ${(err as Error).message}`);
      } finally {
        busy = false;
      }
    };
    g.__ddPollerTimer = setInterval(() => void tick(), interval);
    g.__ddPollerTimer.unref?.();
    void tick();
  } catch (err) {
    g.__ddPollerStarted = false;
    console.error(`[poller] failed to start: ${(err as Error).message}`);
  }
}