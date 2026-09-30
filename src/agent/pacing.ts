import { setTimeout as sleep } from 'node:timers/promises';

/** 副作用限速参数：可突发20次，之后每秒1次，任意两次间隔不少于100ms。 */
export const SIDE_EFFECT_PACING = {
  capacity: 20,
  refillMs: 1000,
  minIntervalMs: 100,
} as const;

export interface PacerClock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

const systemClock: PacerClock = {
  now: () => Date.now(),
  sleep: (ms, signal) => sleep(ms, undefined, { signal }),
};

/** 同一群的模型与沙箱副作用共用的FIFO令牌桶；超额时排队等待而不是拒绝。 */
export class SideEffectPacer {
  private tokens: number = SIDE_EFFECT_PACING.capacity;
  private updated: number;
  private last = -Infinity;
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly clock: PacerClock = systemClock) {
    this.updated = clock.now();
  }

  /** 轮到调用方执行一次副作用时resolve；排队期间signal中止则reject。 */
  take(signal: AbortSignal): Promise<void> {
    const turn = this.queue.then(() => this.acquire(signal));
    this.queue = turn.catch(() => {});
    return turn;
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) {
        throw signal.reason ?? new Error('cancelled');
      }
      const now = this.clock.now();
      this.tokens = Math.min(
        SIDE_EFFECT_PACING.capacity,
        this.tokens + (now - this.updated) / SIDE_EFFECT_PACING.refillMs,
      );
      this.updated = now;
      const spacing = Math.max(
        0,
        this.last + SIDE_EFFECT_PACING.minIntervalMs - now,
      );
      if (this.tokens >= 1 && spacing === 0) {
        this.tokens -= 1;
        this.last = now;
        return;
      }
      const refill =
        this.tokens >= 1
          ? 0
          : Math.ceil((1 - this.tokens) * SIDE_EFFECT_PACING.refillMs);
      await this.clock.sleep(Math.max(spacing, refill, 1), signal);
    }
  }
}
