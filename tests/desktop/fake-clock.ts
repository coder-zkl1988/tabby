/**
 * Test-only clock driver for the launchd code paths that wait on real timers.
 *
 * bootstrapWithLaunchd sleeps 600ms after the orphan sweep and 2000ms waiting
 * for openclaw to bind its port, and waitForExit polls launchctl every 200ms
 * until its own deadline. Those waits are there to give the OS time to settle,
 * and nothing the unit tests assert on happens during them — paying them for
 * real cost the suite ~100s of wall clock. The real waits stay covered by
 * tests/desktop/launchd-integration.test.ts, which drives launchctl on macOS.
 */
import { vi } from "vitest";

/**
 * Run `start()` with fake timers installed, advance the clock until the promise
 * it returns settles, then restore real timers.
 *
 * Install around the call rather than in a hook so that dynamic imports and the
 * surrounding hooks keep the real clock.
 */
export async function onFakeClock<T>(start: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    return await settleOnFakeClock(start());
  } finally {
    vi.useRealTimers();
  }
}

/**
 * Advance an already-installed fake clock until `pending` settles.
 *
 * Steps to the next scheduled timer rather than flushing everything pending, so
 * a poll that is meant to reach its own deadline still gets there one interval
 * at a time instead of every future timer firing at once.
 */
export async function settleOnFakeClock<T>(pending: Promise<T>): Promise<T> {
  let settled = false;
  const tracked = pending.finally(() => {
    settled = true;
  });
  // Re-awaited below. This only stops a rejection from being reported as
  // unhandled while the loop is still advancing the clock.
  void tracked.catch(() => {});
  for (let step = 0; step < 2000 && !settled; step++) {
    if (vi.getTimerCount() > 0) {
      await vi.advanceTimersToNextTimerAsync();
    } else {
      // Nothing scheduled yet — yield a real turn so the chain can reach its
      // next timer.
      await vi.advanceTimersByTimeAsync(0);
    }
  }
  return await tracked;
}
