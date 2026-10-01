/** Display-only epoch clock. HTTP Date has second precision, not deadline accuracy. */
export function createServerClock(
  monotonicNow: () => number = () => performance.now(),
  wallNow: () => number = () => Date.now(),
) {
  let anchor: { epoch: number; monotonic: number } | undefined;
  function now() {
    return anchor
      ? anchor.epoch + Math.max(0, monotonicNow() - anchor.monotonic)
      : wallNow();
  }
  function calibrate(date: string | null, receivedAt = monotonicNow()) {
    if (!date || !Number.isFinite(receivedAt)) {
      return;
    }
    const epoch = Date.parse(date);
    // Reject permissive Date.parse inputs (numbers, local dates, invalid days).
    if (!Number.isFinite(epoch) || new Date(epoch).toUTCString() !== date) {
      return;
    }
    // Midpoint of the header's one-second bucket; transport delay is unknown.
    // Once calibrated, repeated/late responses must not rewind the display.
    const previous = anchor
      ? anchor.epoch + Math.max(0, receivedAt - anchor.monotonic)
      : -Infinity;
    anchor = { epoch: Math.max(previous, epoch + 500), monotonic: receivedAt };
  }
  return { now, calibrate };
}

export const serverClock = createServerClock();
