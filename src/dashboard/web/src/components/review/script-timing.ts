import type { ReviewTool } from '../../../../contracts/review';

type TimingTool = Pick<
  ReviewTool,
  | 'name'
  | 'arguments'
  | 'state'
  | 'outcome'
  | 'status'
  | 'startedAt'
  | 'finishedAt'
  | 'result'
>;

function parameters(tool: TimingTool) {
  if (
    tool.name !== 'execute_javascript' ||
    !tool.arguments ||
    typeof tool.arguments !== 'object' ||
    Array.isArray(tool.arguments)
  ) {
    return null;
  }
  return tool.arguments as Record<string, unknown>;
}

function validWait(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 2147483647
  );
}

function foreground(tool: TimingTool) {
  return (
    tool.state === 'started' &&
    tool.outcome === 'started' &&
    tool.finishedAt == null &&
    tool.status == null &&
    tool.result == null
  );
}

/** 只有尚未返回的前台调用需要时钟；任务完成、取消或转后台后不再计时。 */
export function isScriptWaiting(tool: TimingTool): boolean {
  const args = parameters(tool);
  return (
    !!args &&
    (args.mode === 'sync' || args.mode === 'auto') &&
    validWait(args.wait_ms) &&
    foreground(tool) &&
    typeof tool.startedAt === 'number' &&
    Number.isFinite(tool.startedAt) &&
    tool.startedAt >= 0
  );
}

export interface ScriptTiming {
  setting: string;
  progress: string;
  title: string;
}

/** wait_ms是前台等待时限，不是实际耗时；账本开始时间与沙箱定时器起点略有差异。 */
export function scriptTiming(
  tool: TimingTool,
  now: number,
): ScriptTiming | null {
  const args = parameters(tool);
  if (
    !args ||
    typeof args.mode !== 'string' ||
    !['sync', 'auto', 'async'].includes(args.mode)
  ) {
    return null;
  }
  if (args.mode === 'async') {
    return {
      setting: '立即返回',
      progress: '',
      title: '异步提交后立即返回，不设置前台等待时限。',
    };
  }
  const title =
    'wait_ms包含排队与启动。倒计时按调用开始时间和服务端响应时间估算，仅供参考；是否终止或转后台以服务端结果为准。';
  if (!validWait(args.wait_ms)) {
    return {
      setting: Object.hasOwn(args, 'wait_ms')
        ? '等待时限无效'
        : '等待时限未记录',
      progress: '',
      title:
        'sync/auto必须提供1..2147483647毫秒的整数wait_ms，没有默认值；不根据耗时或其他字段猜测。',
    };
  }
  const wait =
    args.wait_ms < 1000 ? `${args.wait_ms} 毫秒` : `${args.wait_ms / 1000} 秒`;
  const setting =
    args.mode === 'sync'
      ? `最多等待 ${wait}，超时终止`
      : `最多等待 ${wait}，未完成则转后台`;
  let progress = '';
  if (
    tool.state === 'pending' &&
    tool.finishedAt == null &&
    tool.result == null
  ) {
    progress = '尚未开始计时';
  } else if (foreground(tool)) {
    if (!isScriptWaiting(tool) || !Number.isFinite(now)) {
      progress = '开始时间未记录，无法倒计时';
    } else if (tool.startedAt! > now + 1000) {
      progress = '开始时间晚于估计当前时间，等待校准';
    } else {
      const remaining = args.wait_ms - Math.max(0, now - tool.startedAt!);
      progress =
        remaining <= 0
          ? '已到预计时限，等待状态更新'
          : `约 ${Math.ceil(remaining / 1000)} 秒后${args.mode === 'auto' ? '转后台' : '超时终止'}`;
    }
  }
  return { setting, progress, title };
}
