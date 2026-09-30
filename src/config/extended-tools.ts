export const EXTENDED_TOOL_NAMES = [
  'get_group_info',
  'get_group_honor',
  'get_group_mutes',
  'read_group_notices',
  'read_group_essence',
  'poke_member',
  'group_sign',
  'set_group_name',
  'set_group_title',
  'set_group_whole_mute',
  'kick_member',
  'set_group_admin',
  'set_group_essence',
  'remove_group_essence',
  'publish_group_notice',
  'delete_group_notice',
  'leave_group',
  'send_group_image',
  'forward_message',
  'send_group_forward',
  'transcribe_voice',
  'create_reminder',
  'list_reminders',
  'update_reminder',
  'cancel_reminder',
  'get_group_ai_voices',
  'send_group_ai_voice',
  'get_group_file_space',
  'list_group_files',
  'read_group_text_file',
  'upload_group_file',
  'create_group_folder',
  'delete_group_file',
  'delete_group_folder',
  'list_group_requests',
  'respond_group_request',
  'list_custom_faces',
  'view_custom_face',
  'send_custom_face',
  'add_custom_face',
  'delete_custom_face',
  'set_custom_face_description',
  'execute_javascript',
  'query_javascript_jobs',
  'cancel_javascript_job',
  'web_search',
  'web_fetch',
  'create_artifact',
  'create_image',
  'list_artifacts',
] as const;

export type ExtendedToolName = (typeof EXTENDED_TOOL_NAMES)[number];

/** 在QQ中没有可见效果、也不需要确认模式的工具（artifact类工具只写bot本地、带TTL的存储）。 */
export const EXTENDED_READ_ONLY_TOOLS: readonly ExtendedToolName[] = [
  'query_javascript_jobs',
  'create_artifact',
  'create_image',
  'list_artifacts',
  'web_search',
  'web_fetch',
  'get_group_info',
  'get_group_honor',
  'get_group_mutes',
  'read_group_notices',
  'read_group_essence',
  'list_reminders',
  'transcribe_voice',
  'get_group_ai_voices',
  'get_group_file_space',
  'list_group_files',
  'read_group_text_file',
  'list_group_requests',
  'list_custom_faces',
  'view_custom_face',
];

type ExtendedToolMode = 'off' | 'confirm' | 'direct';

export type ExtendedToolsConfig = Partial<
  Record<ExtendedToolName, ExtendedToolMode>
>;

/** 未配置的能力一律视为关闭，模型臆造的工具调用同样不会启用。 */
export function enabledExtendedTools(
  config?: ExtendedToolsConfig,
): ExtendedToolName[] {
  return EXTENDED_TOOL_NAMES.filter(
    (name) => config?.[name] === 'direct' || config?.[name] === 'confirm',
  );
}
