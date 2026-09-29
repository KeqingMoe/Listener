import { setTimeout as sleep } from 'node:timers/promises';

/** Side-effect pacing constants: a 20-call burst, then one call per second, never closer than 100 ms. */
export const SIDE_EFFECT_PACING = { capacity: 20, refillMs: 1000, minIntervalMs: 100 } as const;

export interface PacerClock { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> }
const systemClock: PacerClock = { now: () => Date.now(), sleep: (ms, signal) => sleep(ms, undefined, { signal }) };

/** FIFO token bucket shared by model and sandbox side effects of one group. Waiting, not rejecting. */
export class SideEffectPacer {
  private tokens: number = SIDE_EFFECT_PACING.capacity;
  private updated: number;
  private last = -Infinity;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly clock: PacerClock = systemClock) { this.updated = clock.now(); }
  /** Resolves when the caller may perform one side effect; rejects if the signal aborts while queued. */
  take(signal: AbortSignal): Promise<void> {
    const turn = this.queue.then(() => this.acquire(signal));
    this.queue = turn.catch(() => {});
    return turn;
  }
  private async acquire(signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) throw signal.reason ?? new Error('cancelled');
      const now = this.clock.now();
      this.tokens = Math.min(SIDE_EFFECT_PACING.capacity, this.tokens + (now - this.updated) / SIDE_EFFECT_PACING.refillMs);
      this.updated = now;
      const spacing = Math.max(0, this.last + SIDE_EFFECT_PACING.minIntervalMs - now);
      if (this.tokens >= 1 && spacing === 0) { this.tokens -= 1; this.last = now; return; }
      const refill = this.tokens >= 1 ? 0 : Math.ceil((1 - this.tokens) * SIDE_EFFECT_PACING.refillMs);
      await this.clock.sleep(Math.max(spacing, refill, 1), signal);
    }
  }
}
