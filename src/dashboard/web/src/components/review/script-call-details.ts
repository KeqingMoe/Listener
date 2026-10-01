type CallItem = {
  seq: number | null;
  tool: string;
  status: string;
  label: string;
  detail: string;
  tone: 'error' | 'warning';
};

type CallDetails = { items: CallItem[]; notices: string[] };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function label(status: string): string {
  switch (status) {
    case 'ok':
      return '工具返回成功';
    case 'error':
      return '工具返回错误';
    case 'unknown':
      return '结果未知';
    case 'confirmation_required':
      return '待确认';
    default:
      return status;
  }
}

/** 仅解释本次返回的内部调用摘要，不推断执行效果或获取额外明细。 */
export function scriptCallDetails(
  name: string,
  result: unknown,
): CallDetails | null {
  const outer = record(result);
  const source =
    name === 'execute_javascript'
      ? outer
      : name === 'query_javascript_jobs'
        ? record(outer?.job)
        : null;
  const raw = source?.tool_calls ?? source?.toolCalls;
  if (raw == null) {
    return null;
  }
  const summary = record(raw);
  if (!summary) {
    return {
      items: [],
      notices: ['内部调用摘要格式异常，无法判断内部调用结果。'],
    };
  }

  const items: CallItem[] = [];
  const notices = new Set<string>();
  const counts = record(summary.counts);
  let nonOkCount = 0;
  let countOverflow = false;
  if (!counts || !Object.keys(counts).length) {
    notices.add('内部调用计数未提供或格式异常，汇总可能不完整。');
  }
  for (const [tool, rawStatuses] of Object.entries(counts ?? {})) {
    const statuses = record(rawStatuses);
    if (!tool.trim() || !statuses || !Object.keys(statuses).length) {
      notices.add('部分内部调用计数格式异常，汇总可能不完整。');
    }
    for (const [status, count] of Object.entries(statuses ?? {})) {
      if (!status.trim() || !nonnegativeInteger(count) || count === 0) {
        notices.add('部分内部调用计数无效，未纳入汇总；不能据此判断没有异常。');
        continue;
      }
      if (status !== 'ok') {
        nonOkCount += count;
        countOverflow ||= !Number.isSafeInteger(nonOkCount);
      }
    }
  }

  const abnormal = summary.abnormal;
  if (!Array.isArray(abnormal)) {
    notices.add('内部非 ok 调用明细未提供或列表格式异常，明细不完整。');
  } else {
    if (abnormal.length > 32) {
      notices.add(
        `本页仅展示前 32 条明细，另有 ${abnormal.length - 32} 条被本页截断。`,
      );
    }
    for (const rawItem of abnormal.slice(0, 32)) {
      const item = record(rawItem);
      if (!item) {
        notices.add('内部调用明细含格式异常条目，明细不完整。');
        continue;
      }
      if (item.status === 'ok') {
        notices.add(
          '非 ok 明细列表混入 ok 条目，已忽略该条目；明细可能不完整。',
        );
        continue;
      }
      const status =
        typeof item.status === 'string' && item.status.trim()
          ? item.status
          : '状态未记录';
      if (status === '状态未记录') {
        notices.add('部分内部调用状态缺失或格式异常，明细不完整。');
      }
      const seq = nonnegativeInteger(item.seq) ? item.seq : null;
      const tool =
        typeof item.tool === 'string' && item.tool.trim()
          ? item.tool
          : '工具名未记录';
      if (seq === null || tool === '工具名未记录') {
        notices.add('部分内部调用序号或工具名缺失或无效，明细不完整。');
      }
      let detail =
        status === 'error'
          ? '工具返回错误，不代表已有副作用已撤销。'
          : status === 'unknown'
            ? '调用结果未知，不能断定未执行，也不能确认成功。'
            : status === 'confirmation_required'
              ? '调用待确认，不应视为失败。'
              : '调用状态未识别，保留原始状态，不能确认成功或失败。';
      if (typeof item.error === 'string' && item.error) {
        detail += `\n${item.error}`;
      } else if (item.error != null && typeof item.error !== 'string') {
        notices.add('部分内部调用错误信息格式异常，明细不完整。');
      }
      items.push({
        seq,
        tool,
        status,
        label: label(status),
        detail,
        tone: status === 'error' ? 'error' : 'warning',
      });
    }
  }

  const omitted = summary.abnormal_omitted;
  if (!nonnegativeInteger(omitted)) {
    notices.add('未返回明细的条数未提供或无效，不能确认明细完整。');
  } else if (omitted > 0) {
    notices.add(`另有 ${omitted} 条内部非 ok 调用未包含在返回中。`);
  }
  if (nonOkCount > 0 && (!Array.isArray(abnormal) || abnormal.length === 0)) {
    notices.add('汇总存在非 ok 调用，但明细未提供。');
  } else if (
    !countOverflow &&
    nonnegativeInteger(omitted) &&
    Array.isArray(abnormal) &&
    nonOkCount !== abnormal.length + omitted
  ) {
    notices.add('汇总计数与非 ok 明细条数不一致，明细可能不完整。');
  }
  if (!items.length && !notices.size && nonOkCount === 0) {
    return null;
  }
  return {
    items,
    notices: [...notices],
  };
}
