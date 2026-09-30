import { EXTENDED_TOOL_NAMES } from '../contracts/tool-names.ts';

export { EXTENDED_TOOL_NAMES };

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
