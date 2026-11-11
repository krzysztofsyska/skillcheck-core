/**
 * Polling of a bulk batch's progress, as seen by the progress page.
 *
 * One request at a time; a null/rejected read counts as a failure and keeps the last result (marked stale
 * after STALE_AFTER failures in a row); a success clears the mark. A completed batch stops the polling.
 * `stop()` cancels the timer and makes any answer still in flight be ignored, so an old batch never writes
 * into the state of a new one. Interval is unchanged from the previous inline loop (1.5 s first, then 4 s).
 */
export const STALE_AFTER = 3;
export const FIRST_DELAY_MS = 1500;
export const POLL_INTERVAL_MS = 4000;

export type PollerOptions<T> = {
  read: () => Promise<T | null | undefined>;
  onData: (next: T) => void;
  onStale: (stale: boolean) => void;
  isCompleted: (data: T) => boolean;
};

export function createProgressPoller<T>(opts: PollerOptions<T>) {
  let stopped = false, inFlight = false, failures = 0, stale = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const setStale = (value: boolean) => { if (stale !== value) { stale = value; opts.onStale(value); } };
  const schedule = (ms: number) => { if (!stopped) timer = setTimeout(() => { void tick(); }, ms); };

  async function tick(): Promise<void> {
    timer = null;
    if (stopped || inFlight) return;
    inFlight = true;
    let next: T | null = null;
    try { next = (await opts.read()) ?? null; } catch { next = null; }
    inFlight = false;
    if (stopped) return;
    if (next) {
      failures = 0;
      setStale(false);
      opts.onData(next);
      if (opts.isCompleted(next)) { stopped = true; return; }
    } else if (++failures >= STALE_AFTER) setStale(true);
    schedule(POLL_INTERVAL_MS);
  }

  return {
    start() { if (!stopped && !timer && !inFlight) schedule(FIRST_DELAY_MS); },
    /** Manual retry: reads now unless a request is already in flight. */
    retry() { if (stopped || inFlight) return; if (timer) clearTimeout(timer); void tick(); },
    stop() { stopped = true; if (timer) clearTimeout(timer); timer = null; },
  };
}
