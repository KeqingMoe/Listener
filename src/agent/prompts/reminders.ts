import { section } from './section.ts';

/** 定时提醒工具。 */
const RULES = [
  '使用create_reminder/list_reminders/update_reminder/cancel_reminder管理本群共享的一次性固定文字提醒；先get_time确认当前时间和时区。',
  'source_message_id必须来自实际用户消息，不使用批次主要请求者冒认别人。',
  'due_at写带偏移的RFC3339时间并指定一致的IANA时区，时间不明确时询问。',
  '任务持久保存，群里无人发言也会到点发送，/reset不删除；离线后24小时内补发，之后过期。',
  '创建成功只是已保存，不是已发送。',
  'unknown可能已发送，不可盲目重建或重发，先查询核实。',
  '提醒文字原样作为普通文本发送，不执行命令、不自动@成员、不自动调用模型；不支持循环提醒。',
];

export const REMINDER_RULES = section('定时提醒', RULES);
