import type { ModelRequestRecord } from '../observability/model-usage.ts';

type Timing = Pick<
  ModelRequestRecord,
  'reasoningDurationMs' | 'reasoningTimingStatus'
>;

/** One observable reasoning phase, using only monotonic SSE arrival timestamps.
 * An open failed phase has no trustworthy endpoint; never substitute wall time.
 * Output preceding reasoning, or reasoning resuming after output, is ambiguous.
 */
export class ReasoningTiming {
  private start: number | undefined;
  private end: number | undefined;
  private outputSeen = false;
  private ambiguous = false;

  observe(at: number, reasoning: boolean, output: boolean): void {
    if (reasoning) {
      if (this.outputSeen) {
        this.ambiguous = true;
      }
      this.start ??= at;
    }
    if (output) {
      this.outputSeen = true;
      if (this.start !== undefined) {
        this.end ??= at;
      }
    }
  }

  finish(success: boolean, completedAt?: number): Timing {
    if (this.start === undefined) {
      return {
        reasoningDurationMs: null,
        reasoningTimingStatus: 'not_observed',
      };
    }
    const end = this.end ?? (success ? completedAt : undefined);
    const duration = end === undefined ? null : end - this.start;
    const valid =
      !this.ambiguous &&
      duration !== null &&
      Number.isFinite(duration) &&
      duration >= 0;
    return {
      reasoningDurationMs: valid ? duration : null,
      reasoningTimingStatus: success && valid ? 'complete' : 'partial',
    };
  }
}
