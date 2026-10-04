/** Host receipt captured once at the bot ingress, never taken from a provider timestamp. */
export interface MessageReceipt {
  readonly receivedAt: number;
  readonly receivedMonotonic: number;
}

/** Private host metadata: never accepted from model arguments or guest tool parameters. */
export interface EventOrigin {
  readonly selfId: string;
  readonly groupId: string;
  readonly turnId: string;
  readonly receipt: MessageReceipt;
}

export const VISIBLE_EFFECT_KINDS = [
  'message_sent',
  'message_recalled',
  'member_moderated',
  'group_state_changed',
  'group_file_changed',
] as const;

export type VisibleEffectKind = (typeof VISIBLE_EFFECT_KINDS)[number];

/** A new dispatched operation with business confirmation, not merely a successful submission. */
export interface ConfirmedVisibleEffect {
  readonly kind: VisibleEffectKind;
  readonly confirmedAt: number;
  readonly confirmedMonotonic: number;
}

export interface VisibleEffectObserver {
  confirm(origin: EventOrigin, event: ConfirmedVisibleEffect): void;
}

/** Observation cannot alter permissions, dispatch, cancellation, retries, or the tool result. */
export function observeVisibleEffect(
  observer: VisibleEffectObserver | undefined,
  origin: EventOrigin | undefined,
  kind: VisibleEffectKind,
): void {
  if (!observer || !origin) {
    return;
  }
  try {
    observer.confirm(origin, {
      kind,
      confirmedAt: Date.now(),
      confirmedMonotonic: performance.now(),
    });
  } catch {
    // Diagnostics are optional, including third-party observer implementations.
  }
}
