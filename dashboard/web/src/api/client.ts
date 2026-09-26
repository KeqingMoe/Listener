export async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    signal,
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  });
  if (!response.ok) {
    const messages: Record<number, string> = {
      400: "筛选参数无效，请重新选择。",
      403: "当前访问未获授权。",
      404: "记录不存在或已超出保留期限。",
      503: "数据源暂不可用或查询范围过大，请缩小时间范围或稍后重试。",
    };
    throw new Error(
      messages[response.status] ??
        `请求失败（${response.status}），请稍后重试。`,
    );
  }
  return response.json() as Promise<T>;
}
export const number = (value: number | null | undefined) =>
  value == null ? "未知" : new Intl.NumberFormat("zh-CN").format(value);
export const percent = (value: number | null | undefined) =>
  value == null ? "未知" : `${(value * 100).toFixed(1)}%`;
export const duration = (value: number | null | undefined) =>
  value == null
    ? "未知"
    : value < 1000
      ? `${Math.round(value)} ms`
      : `${(value / 1000).toFixed(2)} s`;
export const time = (value: number | null | undefined) =>
  value == null
    ? "未知"
    : new Date(value).toLocaleString("zh-CN", { hour12: false });
export const status = (value: string | null) =>
  value === null
    ? "未知"
    : ((
        {
          success: "成功",
          error: "失败",
          unknown: "结果不明",
          finished: "已完成",
          pending: "待执行",
          started: "执行中",
          skipped: "已跳过",
          replied: "已回复",
          silent: "主动结束",
          cancelled: "已取消",
          model_failed: "模型失败",
          delivery_unknown: "发送结果不明",
          tool_budget_exhausted: "工具预算耗尽",
          prose_suppressed: "未发送正文",
          ok: "成功",
          completed: "已结束",
          finish: "主动结束",
          response_state_expired: "续接状态过期",
          wake_timeout: "唤醒超时",
          budget_exhausted: "预算耗尽",
          staged: "已暂存",
          executed: "已执行",
          confirmed: "已确认",
          pending_confirmation: "等待确认",
          failed: "执行失败",
          operation_submitted: "操作已提交",
          message_submitted: "消息已提交",
          reaction_submitted: "回应已提交",
          reaction_unknown: "回应结果不明",
          reacted: "已添加回应",
          reaction_failed: "回应失败",
          partial_reply_cancelled: "部分回复后取消",
          partial_reaction_cancelled: "部分回应后取消",
          partial_management_cancelled: "部分管理操作后取消",
        } as Record<string, string>
      )[value] ?? value);
