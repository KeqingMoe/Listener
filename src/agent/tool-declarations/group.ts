import type { DeclarationTable } from './types.ts';

const GROUP_PAGE = `/**
 * 分页结果，每次调用重新拉取，集合可能变化。继续翻页传 offset=next_offset，null 表示没有更多。
 * reason：output_limit 表示输出预算用尽，可减小 limit 续读；content_limit 表示有条目内容被截断。
 */
type GroupPage = {
  status: 'ok';
  group_id: string;
  queried_at: number;
  requested: number;
  returned: number;
  offset: number;
  next_offset: number | null;
  has_more: boolean;
  total: number;
  truncated: boolean;
  reason: 'limit' | 'output_limit' | 'content_limit' | 'end_of_response';
};`;

const types = { GroupPage: GROUP_PAGE };

/** 群资料读取与群管理写操作。 */
export const GROUP_DECLARATIONS: DeclarationTable = {
  get_group_info: {
    summary: '读取本群基本资料和人数。',
    ts: `/** group_all_shut：-1 全员禁言开启，0 关闭；字段缺失表示上游未给出。 */
function get_group_info({}: {}): {
  status: 'ok';
  group_id: string;
  queried_at: number;
  info: { group_id: string; group_name?: string; group_remark?: string; member_count?: number; max_member_count?: number; group_all_shut?: -1 | 0 };
} | Failure;`,
  },
  get_group_honor: {
    summary: '读取本群某类群荣誉名单。',
    ts: `/**
 * type=talkative 时另给当前龙王 current_talkative。
 * 空列表不保证真的没有；strong_newbie 上游固定返回空。
 */
function get_group_honor({}: {
  type: HonorType;
  limit: number;
  offset?: number;
}): (GroupPage & { type: HonorType; current_talkative?: HonorEntry; items: HonorEntry[] }) | Failure;`,
    types: {
      ...types,
      HonorType: `type HonorType = 'talkative' | 'performer' | 'legend' | 'strong_newbie' | 'emotion';`,
      HonorEntry: `type HonorEntry = { user_id?: UserId; nickname?: string; description?: string; day_count?: number; content_truncated?: true };`,
    },
  },
  get_group_mutes: {
    summary: '读取本群禁言名单。',
    ts: `/**
 * 空列表不保证无人被禁言。
 * upstream_shut_up_time 是上游原值，含义未核实；fields_unknown 表示该行无可识别字段。
 */
function get_group_mutes({}: { limit: number; offset?: number }): (GroupPage & {
  items: { user_id?: UserId; nickname?: string; card?: string; upstream_shut_up_time?: number; upstream_is_deleted?: boolean; fields_unknown?: true; content_truncated?: true }[];
}) | Failure;`,
    types,
  },
  read_group_notices: {
    summary: '读取本群公告。',
    ts: `/**
 * 上游只返回最近约20条，不是全部。notice_id 可用于 delete_group_notice。
 * text 最多4000字，超出时 content_truncated=true；图片不展开，只给数量。
 */
function read_group_notices({}: { limit: number; offset?: number }): (GroupPage & {
  items: { notice_id?: string; sender_id?: UserId; publish_time?: UnixSeconds; read_num?: number; text?: string; image_count?: number; images_omitted?: boolean; content_truncated?: true }[];
}) | Failure;`,
    types,
  },
  read_group_essence: {
    summary: '读取本群精华消息列表。',
    ts: `/**
 * 上游失败时可能为空或不完整。
 * 这里的 message_id 可能是合成的，不能用于引用、撤回或 remove_group_essence。
 * text 只含文字片段（最多4000字），nontext_segments_omitted 是略去的非文字片段数。
 */
function read_group_essence({}: { limit: number; offset?: number }): (GroupPage & {
  items: {
    message_id?: string;
    message_id_verified: false;
    sender_id?: UserId;
    sender_nick?: string;
    operator_id?: UserId;
    operator_nick?: string;
    operator_time?: UnixSeconds;
    text?: string;
    nontext_segments_omitted?: number;
    content_unavailable?: true;
    content_truncated?: true;
  }[];
}) | Failure;`,
    types,
  },
  poke_member: {
    summary: '戳一戳本群成员。',
    ts: `/** 每次调用戳一下，要戳多次就分别调用。QQ不提供送达确认，不知道对方是否收到。 */
function poke_member({}: { user_id: UserId }): Submitted | ConfirmationRequired | Unknown | Failure;`,
  },
  group_sign: {
    summary: '以Bot账号在本群签到。',
    ts: `function group_sign({}: {}): Submitted | ConfirmationRequired | Unknown | Failure;`,
  },
  set_group_name: {
    summary: '修改本群名称。',
    ts: `/** 需Bot是管理员或群主。name 1–60字，非纯空白，不含换行或制表符。 */
function set_group_name({}: { name: string }): { status: 'executed' } | ConfirmationRequired | Unknown | Failure;`,
  },
  set_group_title: {
    summary: '设置或移除本群成员的专属头衔。',
    ts: `/** title 为空字符串表示移除。需Bot是群主。title 最多60字，不含换行或制表符。 */
function set_group_title({}: { user_id: UserId; title: string }): Submitted | ConfirmationRequired | Unknown | Failure;`,
  },
  set_group_whole_mute: {
    summary: '开启或关闭本群全员禁言。',
    ts: `/** 需Bot是管理员或群主。 */
function set_group_whole_mute({}: { enable: boolean }): { status: 'executed' } | ConfirmationRequired | Unknown | Failure;`,
  },
  kick_member: {
    summary: '把成员移出本群。',
    ts: `/**
 * reject_add_request=true 同时拒绝其再次申请。
 * 需Bot是管理员或群主；不能踢群主，Bot是管理员时只能踢普通成员。
 */
function kick_member({}: { user_id: UserId; reject_add_request: boolean }): Submitted | ConfirmationRequired | Unknown | Failure;`,
  },
  set_group_admin: {
    summary: '任免本群管理员。',
    ts: `/** 需Bot是群主，目标不能是群主。 */
function set_group_admin({}: { user_id: UserId; enable: boolean }): Submitted | ConfirmationRequired | Unknown | Failure;`,
  },
  set_group_essence: {
    summary: '把一条本群消息设为精华。',
    ts: `/**
 * 需Bot是管理员或群主。
 * message_id 须是最近可见的本群消息或其直接引用的消息；不接受转发内部的ID。
 * 结果未核实前不要重发或反向操作。
 */
function set_group_essence({}: { message_id: MessageId }): Submitted | ConfirmationRequired | Unknown | Failure;`,
  },
  remove_group_essence: {
    summary: '移除一条本群消息的精华。',
    ts: `/**
 * 需Bot是管理员或群主。message_id 规则同 set_group_essence，不能用 read_group_essence 的 ID。
 * 结果未核实前不要重发或反向操作。
 */
function remove_group_essence({}: { message_id: MessageId }): Submitted | ConfirmationRequired | Unknown | Failure;`,
  },
  publish_group_notice: {
    summary: '在本群发布纯文字公告。',
    ts: `/** 需Bot是管理员或群主。text 非纯空白，UTF-8 最多16384字节。 */
function publish_group_notice({}: { text: string }): { status: 'executed' } | ConfirmationRequired | Unknown | Failure;`,
  },
  delete_group_notice: {
    summary: '删除本群一条公告。',
    ts: `/**
 * 需Bot是管理员或群主。notice_id 取自 read_group_notices，且须仍在当前列表中。
 * 删除未核实，不要重发。
 */
function delete_group_notice({}: { notice_id: string }): Submitted | ConfirmationRequired | Unknown | Failure;`,
  },
  leave_group: {
    summary: '让Bot退出本群。',
    ts: `/** 之后可能无法再访问本群；提交后本次唤醒内其他群管理写操作都会被拒绝。 */
function leave_group({}: {}): Submitted | ConfirmationRequired | Unknown | Failure;`,
  },
};
