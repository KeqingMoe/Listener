export const EXTENDED_TOOL_NAMES = [
  "get_group_info",
  "get_group_honor",
  "get_group_mutes",
  "read_group_notices",
  "read_group_essence",
  "poke_member",
  "group_sign",
  "set_group_name",
  "set_group_title",
  "set_group_whole_mute",
  "kick_member",
  "set_group_admin",
  "set_group_essence",
  "remove_group_essence",
  "publish_group_notice",
  "delete_group_notice",
  "leave_group",
  "send_group_image",
  "forward_message",
  "send_group_forward",
  "transcribe_voice",
  "get_group_ai_voices",
  "send_group_ai_voice",
  "get_group_file_space",
  "list_group_files",
  "read_group_text_file",
  "upload_group_text_file",
  "create_group_folder",
  "delete_group_file",
  "delete_group_folder",
  "list_group_requests",
  "respond_group_request",
  "list_custom_faces",
  "view_custom_face",
  "send_custom_face",
  "add_custom_face",
  "delete_custom_face",
  "set_custom_face_description",
] as const;
export type ExtendedToolName = (typeof EXTENDED_TOOL_NAMES)[number];
export const EXTENDED_READ_ONLY_TOOLS: readonly ExtendedToolName[] = [
  "get_group_info",
  "get_group_honor",
  "get_group_mutes",
  "read_group_notices",
  "read_group_essence",
  "transcribe_voice",
  "get_group_ai_voices",
  "get_group_file_space",
  "list_group_files",
  "read_group_text_file",
  "list_group_requests",
  "list_custom_faces",
  "view_custom_face",
];
export type ExtendedToolMode = "off" | "confirm" | "direct";
export type ExtendedToolsConfig = Partial<
  Record<ExtendedToolName, ExtendedToolMode>
>;

/** Absent capabilities remain disabled, including calls invented by the model. */
export function enabledExtendedTools(
  config?: ExtendedToolsConfig,
): ExtendedToolName[] {
  return EXTENDED_TOOL_NAMES.filter(
    (name) => config?.[name] === "direct" || config?.[name] === "confirm",
  );
}
