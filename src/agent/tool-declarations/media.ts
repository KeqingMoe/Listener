import type { DeclarationTable } from './types.ts';

const ARTIFACT_ID = `/** 产物ID，取自 create_artifact、create_image 或 list_artifacts 的结果。 */
type ArtifactId = string;`;
const FILE_HANDLE = `/** 取自 list_group_files 的 file_handle，15分钟内有效。 */
type FileHandle = string;`;
const FOLDER_HANDLE = `/** 取自 list_group_files 的 folder_handle，15分钟内有效。 */
type FolderHandle = string;`;
const REQUEST_HANDLE = `/** 取自 list_group_requests 的 request_handle，到 request_handle_expires_at 失效。 */
type RequestHandle = string;`;
const CHARACTER_ID = `/** 取自 get_group_ai_voices 的 character_id。 */
type CharacterId = string;`;
const GROUP_FILE_ITEM = `type GroupFileItem =
  | { kind: 'folder'; name: string; folder_handle: FolderHandle; reported_file_count?: number; creator_id?: UserId }
  | { kind: 'file'; name: string; file_handle: FileHandle; size_bytes?: number; uploader_id?: UserId; uploaded_at?: UnixSeconds };`;

/** 图片与转发、语音、群文件、入群申请。 */
export const MEDIA_DECLARATIONS: DeclarationTable = {
  send_group_image: {
    summary: '把一张图片作为单条消息发到本群。',
    ts: `/**
 * image_id 和 artifact_id 恰好给一个。
 * image_id 须来自本群已知消息或其直接引用；artifact_id 须是本群未过期的 png/jpeg/webp/gif 产物。
 */
function send_group_image(_: { image_id: ImageId } | { artifact_id: ArtifactId }):
  | { status: 'executed'; message_id: MessageId; local_projection_failed?: true }
  | ConfirmationRequired
  | Unknown
  | Failure;`,
    types: { ArtifactId: ARTIFACT_ID },
  },
  forward_message: {
    summary: '在本群转发一条本群消息。',
    ts: `/** 消息须是本群已知消息或其直接引用。成功时不返回新消息ID。 */
function forward_message(_: { message_id: MessageId }):
  | { status: 'executed'; message_id: null; source_count: 1 }
  | ConfirmationRequired
  | Unknown
  | Failure;`,
  },
  send_group_forward: {
    summary: '把多条本群消息按顺序合并转发到本群。',
    ts: `/**
 * 按给定顺序合并转发本群已知消息或其直接引用，1～128条，可重复。
 * 不保证每条都被保留。
 */
function send_group_forward(_: { message_ids: MessageId[] }):
  | { status: 'executed'; message_id: MessageId; requested_source_count: number; source_completeness: 'not_verified'; local_projection_failed?: true }
  | ConfirmationRequired
  | Unknown
  | Failure;`,
  },
  transcribe_voice: {
    summary: '把本群一条语音消息转成文字。',
    ts: `/**
 * 转写含 record 片段的本群已知消息或其直接引用，多段只转第一段。
 * 识别可能不准；truncated=true 表示因输出上限被截断。
 */
function transcribe_voice(_: { message_id: MessageId }):
  | { status: 'ok'; message_id: MessageId; text: string; truncated?: true; reason?: 'output_limit' }
  | Failure;`,
  },
  get_group_ai_voices: {
    summary: '分页查询本群可用的AI语音声线。',
    ts: `/**
 * limit≥1，offset≥0（默认0）。has_more=true 时用 next_offset 继续。
 * 空列表只代表这次结果；reason='output_limit' 表示因输出上限少返回了。
 */
function get_group_ai_voices(_: { limit: number; offset?: number }):
  | {
      status: 'ok';
      voices: { type: string; character_id: CharacterId; character_name: string }[];
      requested: number;
      returned: number;
      offset: number;
      total_available: number;
      next_offset: number | null;
      has_more: boolean;
      truncated: boolean;
      reason?: 'limit' | 'output_limit';
    }
  | Failure;`,
    types: { CharacterId: CHARACTER_ID },
  },
  send_group_ai_voice: {
    summary: '用AI语音声线把一段文字作为语音发到本群。',
    ts: `/**
 * character_id 须是本群当前可用声线，否则 voice_unavailable。
 * text 原样朗读，不能全是空白，UTF-8 最多8192字节。不返回消息ID。
 */
function send_group_ai_voice(_: { character_id: CharacterId; text: string }):
  | (Submitted & { message_id: null })
  | ConfirmationRequired
  | Unknown
  | Failure;`,
    types: { CharacterId: CHARACTER_ID },
  },
  get_group_file_space: {
    summary: '查询本群文件空间。',
    ts: `/** 容量和用量可能是占位值（如0用量），不能当作精确剩余空间。 */
function get_group_file_space(_: {}):
  | { status: 'ok'; file_count: number; limit_count: number; used_space: number; total_space: number; provider_values_unverified: true }
  | Failure;`,
  },
  list_group_files: {
    summary: '分页列出本群文件和目录。',
    ts: `/**
 * 列出根目录或某目录下的项并签发句柄。limit≥1，offset≥0。
 * 最多1000项，列表不保证完整，变化时分页会漂移；next_offset 非 null 时可继续。
 * 子目录里 subfolders_reported=false 表示不保证列出下级目录。
 */
function list_group_files(_: { limit: number; offset?: number; folder_handle?: FolderHandle }):
  | {
      status: 'ok';
      items: GroupFileItem[];
      requested: number;
      returned: number;
      offset: number;
      next_offset: number | null;
      truncated: boolean;
      reason: 'output_limit' | 'source_limit' | 'upstream_completeness_unknown';
      complete: false;
      subfolders_reported?: false;
      handle_expires_in_seconds: number;
    }
  | Failure;`,
    types: {
      FileHandle: FILE_HANDLE,
      FolderHandle: FOLDER_HANDLE,
      GroupFileItem: GROUP_FILE_ITEM,
    },
  },
  read_group_text_file: {
    summary: '读取本群一个文本群文件的内容。',
    ts: `/**
 * max_bytes 为1～262144；文件超过 max_bytes 时拒绝（resource_limit）。输出另限约22KB，截断时 truncated=true、complete=false。
 * 只支持列表中大小已知的 txt/md/markdown/json/jsonl/ndjson/csv/tsv/log/yaml/yml/xml/ini/toml/conf/cfg/rst 文件。
 */
function read_group_text_file(_: { file_handle: FileHandle; max_bytes: number }):
  | {
      status: 'ok';
      file_handle: FileHandle;
      name: string;
      content: string;
      source_bytes: number;
      listed_size_bytes: number;
      returned_bytes: number;
      truncated: boolean;
      complete: boolean;
    }
  | Failure;`,
    types: { FileHandle: FILE_HANDLE },
  },
  upload_group_file: {
    summary: '把一个产物上传为本群群文件。',
    ts: `/**
 * 上传本群未过期的产物，文件名取产物 name（不合法时 invalid_file_name）。不给 folder_handle 时传到根目录。
 * resource_id_available=false 只表示没拿到新文件ID，上传已成功。
 */
function upload_group_file(_: { artifact_id: ArtifactId; folder_handle?: FolderHandle }):
  | { status: 'ok'; uploaded: true; resource_id_available: boolean; effect_confirmed: true }
  | ConfirmationRequired
  | Unknown
  | Failure;`,
    types: { ArtifactId: ARTIFACT_ID, FolderHandle: FOLDER_HANDLE },
  },
  create_group_folder: {
    summary: '在本群文件根目录新建目录。',
    ts: `/**
 * name 1～120字符，首尾不能是空白或“.”，不能含 / \\ : 和控制字符。
 * 成功后需重新 list_group_files 才能拿到句柄。
 */
function create_group_folder(_: { name: string }):
  | (Submitted & { refresh_list: true })
  | ConfirmationRequired
  | Unknown
  | Failure;`,
  },
  delete_group_file: {
    summary: '删除本群一个群文件。',
    ts: `/**
 * 非管理员或群主只能删自己上传的文件，否则 insufficient_permission。
 * 同一目标有已提交或结果未知的操作时返回 target_* 错误。
 */
function delete_group_file(_: { file_handle: FileHandle }):
  | (Submitted & { api_reported_success: boolean; refresh_list: true })
  | ConfirmationRequired
  | Unknown
  | Failure;`,
    types: { FileHandle: FILE_HANDLE },
  },
  delete_group_folder: {
    summary: '删除本群一个群文件目录。',
    ts: `/**
 * 删除目录及其内容，需管理员或群主，否则 insufficient_permission。
 * 目标或其内有已提交或结果未知的操作时返回 target_* 错误。
 */
function delete_group_folder(_: { folder_handle: FolderHandle }):
  | { status: 'ok'; deleted: true; effect_confirmed: true }
  | ConfirmationRequired
  | Unknown
  | Failure;`,
    types: { FolderHandle: FOLDER_HANDLE },
  },
  list_group_requests: {
    summary: '分页读取本群待处理的入群申请。',
    ts: `/**
 * 只含直接入群申请。需管理员或群主，否则 permission_denied。limit≥1，offset≥0；has_more=true 时用 next_offset 继续。
 * 只扫描最近1000条通知，没列出不代表不存在。
 * previous_outcome 表示你此前处理过，为 submitted 或 unknown 时不要再处理。
 */
function list_group_requests(_: { limit: number; offset?: number }):
  | {
      status: 'ok';
      items: {
        request_handle: RequestHandle;
        request_handle_expires_at: UnixSeconds;
        applicant_id: UserId;
        applicant_nickname?: string;
        /** 申请附言。 */
        message?: string;
        content_truncated?: true;
        previous_outcome?: 'submitted' | 'unknown' | 'identity_conflict';
      }[];
      requested: number;
      returned: number;
      offset: number;
      total: number;
      next_offset: number | null;
      has_more: boolean;
      truncated: boolean;
      reason: 'limit' | 'output_limit' | 'handle_capacity' | 'end_of_observed_requests';
    }
  | Failure;`,
    types: { RequestHandle: REQUEST_HANDLE },
  },
  respond_group_request: {
    summary: '同意或拒绝本群一条入群申请。',
    ts: `/**
 * 同意时 reason 须为空串；拒绝时 reason 原样发给申请人，UTF-8 最多512字节。
 * 成功只表示已提交，不代表已入群；同一申请不要再次处理。
 */
function respond_group_request(_: { request_handle: RequestHandle; approve: boolean; reason: string }):
  | Submitted
  | ConfirmationRequired
  | Unknown
  | Failure;`,
    types: { RequestHandle: REQUEST_HANDLE },
  },
};
