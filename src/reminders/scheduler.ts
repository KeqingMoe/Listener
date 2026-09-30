import {
  type ReminderStore,
  type Reminder,
  type DeliveryOutcome,
} from './store.ts';

export interface ReminderSchedulerOptions {
  store: ReminderStore;
  currentAccount: () => string | undefined;
  eligible: (groupId: string) => boolean;
  dispatch: (
    reminder: Reminder,
    beforeDispatchClaim: () => boolean,
  ) => Promise<DeliveryOutcome>;
  now?: () => number;
  intervalMs?: number;
}

export class ReminderScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private paused = false;
  private generation = 0;
  private readonly now: () => number;
  private readonly intervalMs: number;
  constructor(private readonly options: ReminderSchedulerOptions) {
    this.now = options.now ?? Date.now;
    this.intervalMs = options.intervalMs ?? 1000;
    if (
      !Number.isSafeInteger(this.intervalMs) ||
      this.intervalMs < 1 ||
      this.intervalMs > 2147483647
    ) {
      throw new Error('Invalid reminder scheduler interval');
    }
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.paused = false;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, this.intervalMs);
    this.timer.unref();
    void this.tick().catch(() => {});
  }

  async stop(): Promise<void> {
    this.paused = true;
    this.generation++;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.running;
  }

  tick(): Promise<void> {
    if (this.paused) {
      return Promise.resolve();
    }
    if (this.running) {
      return this.running;
    }
    const generation = this.generation;
    this.running = this.run(generation).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(generation: number): Promise<void> {
    const { store, currentAccount, eligible, dispatch } = this.options;
    const selfId = currentAccount();
    if (!selfId) {
      return;
    }
    const now = this.now();
    store.expire(now, selfId);
    const candidates: Reminder[] = [];
    for (let offset = 0; candidates.length < 64; offset += 64) {
      const page = store.due(selfId, now, 64, offset);
      candidates.push(
        ...page
          .filter((r) => eligible(r.groupId))
          .slice(0, 64 - candidates.length),
      );
      if (page.length < 64) {
        break;
      }
    }
    for (const reminder of candidates) {
      if (
        this.paused ||
        generation !== this.generation ||
        currentAccount() !== selfId
      ) {
        return;
      }
      if (!eligible(reminder.groupId)) {
        continue;
      }
      let claimed = false,
        callbackUsed = false,
        active = true;
      const claim = (): boolean => {
        if (!active || callbackUsed) {
          return false;
        }
        callbackUsed = true;
        if (
          this.paused ||
          generation !== this.generation ||
          currentAccount() !== selfId ||
          !eligible(reminder.groupId)
        ) {
          return false;
        }
        claimed = store.claim(
          reminder.id,
          reminder.revision,
          selfId,
          reminder.groupId,
          this.now(),
        );
        return claimed;
      };
      let outcome: DeliveryOutcome;
      try {
        outcome = await dispatch(reminder, claim);
      } catch {
        outcome = { state: 'unknown', reason: 'dispatch_unknown' };
      } finally {
        active = false;
      }
      if (!claimed) {
        continue;
      }
      const s = {
        id: reminder.id,
        selfId,
        groupId: reminder.groupId,
        expectedRevision: reminder.revision + 1,
      };
      try {
        store.settle(s, outcome, this.now());
      } catch {
        store.settle(
          s,
          { state: 'unknown', reason: 'dispatch_unknown' },
          this.now(),
        );
      }
    }
  }
}
