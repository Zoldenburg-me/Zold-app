/**
 * The soft limit on calls to Monerium: one queue for every caller in this
 * process (the poller, the reconciler, the activation screen, sends).
 *
 * Monerium publishes no number; its docs say a limit answers 429 with a
 * Retry-After. 40 requests a second ran clean on the sandbox (200 calls in
 * 5 s, all 200, no rate-limit headers, 2026-10-04), so that is the default
 * (MONERIUM_MAX_RPS). It was a 5-second burst on the sandbox: a per-minute
 * window, or production, may still answer 429 below it.
 *
 * A call past the limit waits for the next slot; none is refused. The wait
 * counts against the caller's own timeout signal, so a backlog fails the way
 * a slow Monerium does — the caller's error path, never a fallback.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { MONERIUM } from "../config/monerium.js";

/** Evenly spaced slots at `perSecond`: how long a call made at `now` waits. */
export function slotScheduler(perSecond: number): (now: number) => number {
  const gapMs = 1000 / perSecond;
  let next = 0;
  return (now) => {
    const slot = Math.max(now, next);
    next = slot + gapMs;
    return slot - now;
  };
}

const waitFor = slotScheduler(MONERIUM.maxRequestsPerSecond);

/** fetch, once a slot under the limit is free. */
export async function moneriumFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const delay = waitFor(Date.now());
  if (delay > 0) await sleep(delay, undefined, init.signal ? { signal: init.signal } : undefined);
  return fetch(url, init);
}
