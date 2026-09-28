import { rejectConfiguration } from '../composables/useAuth';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/${path}`, {
    signal,
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  });
  if (response.status === 401) window.dispatchEvent(new Event('dashboard:unauthorized'));
  if (!response.ok) {
    if (response.status === 503) {
      const body = await response.clone().json().catch(() => ({}));
      if (body.error === 'password_not_configured' || body.error === 'password_invalid_configuration') {
        rejectConfiguration(body.error);
        throw new ApiError(response.status, '拒绝访问：面板密码配置不可用。');
      }
    }
    const messages: Record<number, string> = {
      400: "筛选参数无效，请重新选择。",
      403: "当前访问未获授权。",
      404: "记录不存在或已超出保留期限。",
      503: "数据源暂不可用或查询范围过大，请缩小时间范围或稍后重试。",
    };
    throw new ApiError(
      response.status,
      messages[response.status] ??
        `请求失败（${response.status}），请稍后重试。`,
    );
  }
  return response.json() as Promise<T>;
}
export const number = (value: number | null | undefined) =>
  value == null ? "—" : new Intl.NumberFormat("zh-CN").format(value);
export const percent = (value: number | null | undefined) =>
  value == null ? "—" : `${(value * 100).toFixed(1)}%`;
export const duration = (value: number | null | undefined) =>
  value == null
    ? "—"
    : value < 1000
      ? `${Math.round(value)} ms`
      : `${(value / 1000).toFixed(2)} s`;
export const time = (value: number | null | undefined) =>
  value == null
    ? "—"
    : new Date(value).toLocaleString("zh-CN", { hour12: false });
const diagnosticKeys = {
  request: ["abortSource", "providerCategory", "providerParameter", "failureStage", "requestMode", "requestTimeoutMs"],
  wake: ["duration_ms", "model_rounds", "tool_calls", "sent_messages", "sent_submissions", "management_executed", "management_submitted", "management_unknown", "reactions", "reaction_submitted", "reaction_unknown", "reaction_failures", "tool_calls_limit", "wake_timeout_ms"],
} as const;
// Defense in depth: never stringify an entire API diagnostic payload.
export function diagnosticRows(value: unknown, kind: keyof typeof diagnosticKeys): [string, string][] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return diagnosticKeys[kind].flatMap<[string, string]>((key) => {
    const item = record[key];
    if (typeof item === "number" && Number.isFinite(item)) return [[key, number(item)]];
    if (kind === "request" && typeof item === "string") return [[key, item]];
    return [];
  });
}
export const status = (value: string | null) =>
  value === null
    ? "—"
    : ((
        {
          success: "成功",
          running: "执行中",
          interrupted: "已中断",
          error: "失败",
          unknown: "结果不明",
          finished: "已完成",
          pending: "待执行",
          started: "执行中",
          skipped: "已跳过",
          replied: "已回复",
          silent: "主动结束",
          cancelled: "已取消",
          session_reset: "会话重置/轮换",
          session_rotated: "会话轮换",
          cursor_with_filters: "分页游标不能同时携带查询条件",
          owner_reset: "用户重置会话",
          recovered_after_crash: "崩溃后恢复",
          configuration_changed: "配置变更",
          transient_images_lost: "临时图片内容丢失",
          transcript_resource_boundary: "会话记录资源边界",
          model_failed: "模型失败",
          delivery_unknown: "发送结果不明",
          tool_budget_exhausted: "工具预算耗尽",
          prose_suppressed: "未发送正文",
          ok: "成功",
          completed: "已结束",
          finish: "主动结束",
          response_state_expired: "续接状态过期",
          wake_timeout: "唤醒超时",
          turn_timeout: "整次唤醒达到时间上限",
          request_timeout: "单次模型请求达到时间上限",
          disconnected: "连接断开",
          reset: "用户重置会话",
          shutdown: "服务关闭",
          generation_changed: "任务已失效",
          external_unknown: "外部取消，来源未记录",
          send_failed: "发送异常，结果不明",
          stopped: "连接服务已停止",
          budget_exhausted: "预算耗尽",
          staged: "已暂存",
          executed: "已执行",
          confirmed: "已确认",
          pending_confirmation: "等待确认",
          failed: "失败",
          timeout: "超时",
          handled: "已处理",
          rejected: "已拒绝",
          deferred: "已延后",
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
