import type { ReviewTool } from '../../../../contracts/review.ts';
import { toolOutcome } from '../../../../contracts/outcomes.ts';

type Evidence = {
  text: string;
  tone: 'neutral' | 'warning' | 'error';
  title: string;
};

/** 只解释本次可观测的返回；不改动原始 JSON，也不从请求参数推断效果。 */
export function toolEvidence(tool: ReviewTool): Evidence {
  const result =
    tool.result !== null &&
    typeof tool.result === 'object' &&
    !Array.isArray(tool.result)
      ? (tool.result as Record<string, unknown>)
      : null;
  const status = result?.status;
  const duplicate = result?.duplicate === true || status === 'duplicate';
  const evidence = (
    text: string,
    tone: Evidence['tone'],
    title: string,
  ): Evidence => ({
    text: duplicate ? `复用/重复结果 · ${text}` : text,
    tone: duplicate && tone === 'neutral' ? 'warning' : tone,
    title: `${title}${
      duplicate
        ? ' 返回带重复标记，不证明发生了新的执行，也不证明没有副作用。'
        : ''
    } 原始 JSON 保留供核对。`,
  });

  // 账本恢复/中断状态不能被遗留的成功返回覆盖。
  if (tool.state === 'unknown') {
    return evidence(
      '账本结果未知',
      'warning',
      '账本未确认本次调用的最终结果；已有返回也不能消除这一不确定性。',
    );
  }
  if (tool.state === 'skipped' || tool.outcome === 'skipped') {
    return evidence(
      '调用已跳过',
      'neutral',
      '账本标记跳过，不据此判断其他调用或已有副作用是否撤销。',
    );
  }
  if (tool.result == null) {
    if (tool.state === 'pending') {
      return evidence('尚未执行', 'neutral', '账本仍为待执行，尚无工具返回。');
    }
    if (tool.state === 'started') {
      return evidence(
        '执行中，尚未返回',
        'neutral',
        '账本已记录开始，但尚无工具返回，不能判断执行结果。',
      );
    }
    return evidence(
      '结果未记录',
      'warning',
      '没有可观测的返回值；handled 或状态元数据不等于成功证据。',
    );
  }

  const outcome = toolOutcome(result ?? {});
  if (
    status === 'cancelled' ||
    outcome === 'cancelled' ||
    tool.outcome === 'cancelled'
  ) {
    return evidence(
      '调用已取消，副作用未确认',
      'warning',
      '取消标记不证明操作未生效，也不证明已有副作用已撤销。',
    );
  }
  if (status === 'skipped') {
    return evidence(
      '调用已跳过',
      'neutral',
      '返回标记跳过，不推断副作用已撤销。',
    );
  }
  if (status === 'error') {
    const category =
      tool.outcome === 'rejected' || tool.outcome === 'deferred'
        ? tool.outcome
        : outcome;
    return evidence(
      category === 'rejected'
        ? '工具返回拒绝'
        : category === 'deferred'
          ? '调用暂缓'
          : '工具返回错误',
      category === 'deferred' ? 'warning' : 'error',
      '返回未确认成功；错误或拒绝不证明已有副作用已撤销。',
    );
  }
  // common.Submitted 的 status 是 ok，必须先于通用成功分支判断。
  if (status === 'unknown' || result?.effect_unknown === true) {
    return evidence(
      '结果未知，外部效果未确认',
      'warning',
      result?.retry_allowed === false
        ? '可能已生效但未确认；返回明确不允许重试，不能据此重放或反向操作。'
        : '没有确认外部效果，不能把未知当作失败或成功。',
    );
  }
  if (status === 'submitted' || result?.submitted === true) {
    return evidence(
      '已提交，外部结果未确认',
      'warning',
      '返回仅证明提交被接受，不证明送达或外部效果已实现。',
    );
  }
  if (status === 'confirmation_required') {
    return evidence('待确认', 'warning', '返回要求确认，不代表操作已执行。');
  }
  if (status === 'staged') {
    return evidence(
      '已暂存，待后续处理',
      'warning',
      '暂存不代表操作已执行或生效。',
    );
  }
  if (status === 'pending') {
    if (tool.name === 'execute_javascript') {
      return typeof result?.job_id === 'string' && result.job_id.length > 0
        ? evidence(
            '已返回后台句柄，任务未确认完成',
            'warning',
            '前台调用已返回 pending；后台任务可能排队或运行，本摘要不关联后续结果。',
          )
        : evidence(
            '状态未识别',
            'warning',
            '返回 pending 但缺少后台句柄，不能确认任务完成。',
          );
    }
    return evidence(
      '结果待定',
      'warning',
      '工具返回 pending，不代表操作完成。',
    );
  }
  if (status === 'duplicate') {
    return evidence('不确认新的执行', 'warning', '返回仅标记为重复结果。');
  }
  if (result?.cancelled_after_dispatch === true) {
    return evidence(
      '派发后标记取消，副作用未确认撤销',
      'warning',
      '取消发生在派发之后；不能由取消标记推断已有返回或外部效果被撤销。',
    );
  }
  if (
    (status === 'ok' || status === 'executed' || status === 'success') &&
    tool.state === 'finished' &&
    tool.outcome === 'handled'
  ) {
    return duplicate
      ? evidence(
          '不确认新的执行',
          'warning',
          '复用的返回不证明本次重新执行成功。',
        )
      : evidence(
          '工具返回成功',
          'neutral',
          '仅顶层返回状态明确成功，不泛指已发送、外部操作已执行或内部步骤全部成功。',
        );
  }
  return evidence(
    '状态未识别',
    'warning',
    '返回缺少已知状态，或返回与账本状态不足以确认结果；不从参数或其他字段猜测成功。',
  );
}
