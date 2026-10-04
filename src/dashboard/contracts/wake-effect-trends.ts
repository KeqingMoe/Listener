import type { Availability, Range } from './contracts.ts';

/** One message-triggered logical wake, not a model request or a session slice. */
export type WakeEffectOutcome =
  'confirmed' | 'pending' | 'unconfirmed' | 'interrupted';

export interface WakeEffectTrendPoint {
  /** Stable, authorized [groupId, logicalTurnId] tuple. No message content. */
  key: string;
  receivedAt: number;
  firstEffectWaitMs: number | null;
  outcome: WakeEffectOutcome;
}

export interface WakeEffectTrendsResponse {
  range: Range;
  availability: Availability;
  bucketMs: number;
  /** Null when the collector has not created a valid recording source. */
  collectionStartedAt: number | null;
  /** Bounded, unsampled wake observations; unconfirmed waits are null, never zero. */
  points: WakeEffectTrendPoint[];
}
