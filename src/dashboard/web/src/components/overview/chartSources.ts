import type { RequestTrendPoint } from '../../../../contracts/request-trends';
import type { WakeEffectTrendPoint } from '../../../../contracts/wake-effect-trends';
import type { NumericSample } from './chartMetrics';

export const wakeCategories = [
  { key: 'confirmed', label: '已确认', color: '#25a47a' },
  { key: 'pending', label: '等待确认', color: '#4895ef' },
  { key: 'unconfirmed', label: '未确认', color: '#8995a7' },
  { key: 'interrupted', label: '中断', color: '#a78bfa' },
];

export function wakeSamples(points: WakeEffectTrendPoint[]): NumericSample[] {
  return points.flatMap((point) =>
    point.outcome === 'confirmed' &&
    Number.isFinite(point.receivedAt) &&
    point.firstEffectWaitMs !== null &&
    Number.isFinite(point.firstEffectWaitMs) &&
    point.firstEffectWaitMs >= 0
      ? [
          {
            time: point.receivedAt,
            value: point.firstEffectWaitMs / 1000,
            category: point.outcome,
          },
        ]
      : [],
  );
}

export function reasoningCounts(points: RequestTrendPoint[]) {
  return {
    partial: points.filter((p) => p.reasoningTimingStatus === 'partial').length,
    notObserved: points.filter(
      (p) => p.reasoningTimingStatus === 'not_observed',
    ).length,
    unknown: points.filter((p) => p.reasoningTimingStatus == null).length,
  };
}
