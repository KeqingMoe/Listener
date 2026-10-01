import type { JavascriptJobLinkLimitation } from '../../../../contracts/javascript-jobs';

/** 只描述检索证据的限制，不把全群历史覆盖上限说成本任务丢记录。 */
const labels: Record<string, string> = {
  tool_result_limit:
    '所选范围内的调用结果日志超过 2000 条，仅检查最近 2000 条；较早的提交或查询可能未被覆盖。',
  tool_intent_limit:
    '所选范围内的调用开始日志超过 2000 条，仅检查最近 2000 条；较早的调用可能未被覆盖。',
  notification_journal_limit:
    '所选范围内的通知投影日志超过 2000 条，仅检查最近 2000 条。',
  inbox_limit:
    '通知收件箱只检查最近 500 条历史记录（已匹配的通知另按 ID 核对）；这是历史覆盖限制，不表示本任务的记录缺失。',
  byte_limit:
    '关联检索达到 8 MiB 读取预算，剩余候选未检查；可以缩小顶部时间范围。',
  record_size_limit:
    '部分候选记录超过单条读取上限，未解读其正文；不表示本任务执行失败。',
  candidate_record_unreadable:
    '部分候选历史记录无法核对或解读，不能保证已查遍；尚不能断定这些记录属于本任务。',
  linked_record_missing:
    '已匹配到本任务的关联证据，但对应记录或结果正文缺失，无法补全该环节。',
  identifier_redacted: '部分关联标识已脱敏或格式异常，无法提供可靠跳转。',
  wake_lookup_unavailable: '唤醒定位索引不可用，部分记录暂不能提供唤醒跳转。',
  wake_lookup_limit: '对应唤醒的定位检索达到上限，未确认可跳转的唤醒记录。',
  anchor_unmatched:
    '未能核对当前调用与这个任务 ID 的对应关系；没有据此补造提交记录。',
  output_limit:
    '关联记录超过展示上限，当前调用优先保留，其余仅保留最近记录（最多共 200 条）。',
} satisfies Record<JavascriptJobLinkLimitation, string>;

export function jobLinkLimitations(
  codes: readonly string[] | undefined,
  truncated: boolean,
): string[] {
  if (codes?.length) {
    return [...new Set(codes)].map((code) =>
      Object.hasOwn(labels, code)
        ? labels[code]!
        : '检索遇到未识别的覆盖限制，不能保证已查遍关联记录。',
    );
  }
  return truncated
    ? ['此接口未提供具体限制原因，检索覆盖范围尚无法确认；这不是任务失败状态。']
    : [];
}
