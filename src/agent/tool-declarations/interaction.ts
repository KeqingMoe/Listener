import type { DeclarationTable } from './types.ts';

/** 查看图片、读取合并转发、表情回应与关注计划。 */
export const INTERACTION_DECLARATIONS: DeclarationTable = {
  view_images: {
    summary: '查看本群近期消息里的图片或图片产物。',
    ts: `/**
 * 查看本群近期消息（或其直接引用）里的图片，或本群未过期的图片产物；动图只给首帧。
 * 图片在下一轮送达：同一次响应里的 send_message、finish、react_message、manage_attention 等会被拒绝（reason_code='image_first'），看完下一轮再操作。
 * 本轮已加载过的ID直接算作 loaded。
 */
function view_images(_: { image_ids: (ImageId | ArtifactId)[] }):
  | {
      status: 'ok' | 'partial' | 'error';
      loaded_ids: string[];
      failed_ids: string[];
      /** 有图加载失败为 'image_unavailable'，其他为参数等错误。 */
      error?: string;
      /** 只在沙箱代码中出现（此时不送图片）：按行排列的 RGBA 像素，长度 width*height*4。 */
      images?: { image_id?: string; width: number; height: number; pixels: Uint8Array }[];
    }
  | Failure;`,
    types: {
      ArtifactId: `/** 产物ID，取自 create_artifact、create_image 或 list_artifacts 的结果。 */
type ArtifactId = string;`,
    },
  },
  read_forward: {
    summary: '分页读取合并转发。',
    ts: `/**
 * start 从1开始，limit 为正整数；被截断时按 next_start 继续。本轮所有转发共用输出预算，用尽返回 budget_exhausted。
 * 嵌套转发以 forward 片段给出新 forward_id（本轮有效），需另行读取，最多3层。
 * 转发内图片不可查看，引用不是真实群消息ID；claimed_sender 只是声称的发送者。
 */
function read_forward(_: { forward_id: ForwardId; start: number; limit: number }):
  | {
      status: 'ok';
      forward_id: ForwardId;
      total: number;
      requested: number;
      returned: number;
      returned_start: number | null;
      returned_end: number | null;
      next_start: number | null;
      has_more: boolean;
      truncated: boolean;
      /** limit：还有后续；end_of_resource：已到末尾；resource_limit：因输出上限截断。 */
      reason?: 'limit' | 'end_of_resource' | 'resource_limit';
      /** 内容被截断的消息序号。 */
      partial_message_indices: number[];
      messages: ForwardNode[];
    }
  | (Failure & { total?: number; returned?: 0 });`,
    types: {
      ForwardNode: `/** 转发中的一条消息，index 从1开始。 */
type ForwardNode = {
  index: number;
  claimed_sender: { user_id?: UserId; nickname: string };
  time: UnixSeconds;
  /** 旧文本表示，不能据此推断原生片段。 */
  representation?: 'legacy_text';
  segments: Segment[];
  segments_omitted?: number;
  content_truncated?: true;
  forwards?: { id: ForwardId; count?: number; countSource?: 'hint' | 'verified' }[];
};`,
    },
  },
  react_message: {
    summary: '对本群消息添加或取消本账号的表情回应。',
    ts: `/**
 * 不发消息，通常不必再说话；只回应时最后调用 finish。
 * message_id 取自本轮读到的消息或其引用；emoji_id 来自目录，QQ不保证接受每个ID。
 * 本轮重复同一动作返回原结果并带 duplicate=true；出现 unknown 后该消息该表情不再提交任何动作，requested_action 标出被拦下的动作。
 */
function react_message(_: { message_id: MessageId; emoji_id: EmojiId; action: 'add' | 'remove' }): (
  | (Submitted & { message_id: MessageId; emoji_id: EmojiId; action: 'add' | 'remove' })
  | (Unknown & { message_id: MessageId; emoji_id: EmojiId; action: 'add' | 'remove' })
  | Failure
) & { duplicate?: true; requested_action?: 'add' | 'remove' };`,
    types: {
      EmojiId: `/** 表情回应ID，见附录“表情回应”。 */
type EmojiId = string;`,
    },
  },
  get_reaction_users: {
    summary: '分页读取本群消息上某个表情回应的回应者。',
    ts: `/**
 * 每页最多20人，limit 更大时带 reason='upstream_page'。
 * 翻页：其余参数原样保留，加上 next_cursor 作为 cursor（本轮有效，limit 可改）。重复同一查询带 duplicate=true。
 * emoji_id、emoji_type 取自消息的反应快照（'1' QQ表情，'2' Unicode emoji），不限于回应目录。
 * user_id 用于核对某人：target_found=true 即可停止；读完仍未见为 false，否则为 null。
 * 本账号 react_message 该消息该表情后游标失效，需从第一页重查。名单是当前状态，不证明过去谁点过。
 */
function get_reaction_users(_: {
  message_id: MessageId;
  emoji_id: string;
  emoji_type: '1' | '2';
  limit: number;
  user_id?: UserId;
  cursor?: string;
}): {
  /** ok：已完整读完；partial：还有后续或本页不完整。 */
  status: 'ok' | 'partial' | 'error';
  error?: string;
  message_id?: MessageId;
  emoji_id?: string;
  emoji_type?: '1' | '2';
  users?: { user_id: UserId; nickname: string }[];
  requested?: number;
  returned?: number;
  truncated?: boolean;
  /** 本查询链累计见到的不同用户数。 */
  seen_users?: number;
  complete?: boolean;
  has_more?: boolean | null;
  next_cursor?: string;
  /** 毫秒时间戳。 */
  observed_at?: number;
  target_user_id?: UserId;
  target_found?: boolean | null;
  reason?: string;
  omitted?: number;
  duplicate?: true;
};`,
  },
  manage_attention: {
    summary: '暂存本群关注计划的创建、更新或取消。',
    ts: ({ config }) => `/**
 * 登记“何时再来看本群”的计划，不发消息。须在 finish 之前调用；只有本轮以 finish 正常结束才提交，失败、超时或取消都不提交。
 * create 新增计划并返回 plan_id；update 按 plan_id 整体替换；cancel 取消。本群最多 ${config.attention.maxPlans} 个计划，超出返回 plan_limit。
 * any_of 任一满足即唤醒一次并消费该计划，命中情况见 wake.trigger.plan_hits。
 * 时限和条件从提交时起算，只看之后的消息；到点无未读消息不唤醒。
 */
function manage_attention(
  _:
    | { operation: 'create'; any_of: AttentionCondition[]; expires_in_seconds: number; purpose?: string }
    | { operation: 'update'; plan_id: string; any_of: AttentionCondition[]; expires_in_seconds: number; purpose?: string }
    | { operation: 'cancel'; plan_id: string },
): { status: 'staged'; operation: 'create' | 'update' | 'cancel'; plan_id: string } | Failure;`,
    types: {
      AttentionCondition: `/**
 * any_of 1到8个；expires_in_seconds 1到86400；purpose 最多160字，仅作标签。
 * member_message：user_ids 1到16个、不重复、不含本账号，任一人发言即满足；要分别等人就分别建计划。
 * after：[最短, 最长] 秒，最长须小于 expires_in_seconds，提交时随机取一次。
 * activity：window_seconds（1到3600）内至少 min_messages 条（1到512），来自至少 min_senders 人（1到64，默认1）。
 */
type AttentionCondition =
  | { type: 'next_message' }
  | { type: 'member_message'; user_ids: UserId[] }
  | { type: 'after'; delay_seconds: [number, number] }
  | { type: 'activity'; window_seconds: number; min_messages: number; min_senders?: number };`,
    },
  },
};
