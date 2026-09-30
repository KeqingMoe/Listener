import type { DeclarationTable } from './types.ts';

const MODERATION_RESULT = `/**
 * 本次唤醒内参数相同的重复调用返回上次结果并带 duplicate。
 * 操作他人需 Bot 是管理员，目标不能是群主；Bot 不是群主时目标也不能是管理员。
 * 错误码：permission_denied（权限不足）、verification_failed（目标不在本群等）、invalid_arguments。
 */
type ModerationResult = ({ status: 'executed' } | ConfirmationRequired | Unknown | Failure) & { duplicate?: true };`;

/** 禁言、解禁、撤回、改群名片。 */
export const MANAGEMENT_DECLARATIONS: DeclarationTable = {
  mute_member: {
    summary: '禁言本群一名成员。',
    ts: ({ definition }) => {
      const properties = definition.function.parameters.properties as Record<
        string,
        { maximum?: number }
      >;
      const maximum = properties.seconds?.maximum;
      return `/**
 * 禁言 seconds 秒（1 到 ${String(maximum)}）。需 Bot 是管理员。解禁用 unmute_member。
 * 本次唤醒内对某人禁言或解禁结果为 unknown 后，再对此人禁言/解禁都直接返回 unknown。
 */
function mute_member(_: { user_id: UserId; seconds: number }): ModerationResult;`;
    },
    types: { ModerationResult: MODERATION_RESULT },
  },
  unmute_member: {
    summary: '解除本群一名成员的禁言。',
    ts: `/** 权限要求和 unknown 规则同 mute_member。 */
function unmute_member(_: { user_id: UserId }): ModerationResult;`,
    types: { ModerationResult: MODERATION_RESULT },
  },
  recall_message: {
    summary: '撤回一条本群消息。',
    ts: `/**
 * message_id 须取自最近上下文里的消息或其引用的消息，否则返回 message_not_in_context。
 * 撤回自己的消息无需管理员；消息过期等情况 QQ 仍可能拒绝。
 */
function recall_message(_: { message_id: MessageId }): ModerationResult;`,
    types: { ModerationResult: MODERATION_RESULT },
  },
  set_member_card: {
    summary: '修改本群一名成员的群名片。',
    ts: `/**
 * card 为 1 到 60 个字符，不能含控制字符、格式字符或换行类分隔符。改自己的无需管理员。
 * 本次唤醒内对此人改名片结果为 unknown 后，再调用直接返回 unknown。
 */
function set_member_card(_: { user_id: UserId; card: string }): ModerationResult;`,
    types: { ModerationResult: MODERATION_RESULT },
  },
};
