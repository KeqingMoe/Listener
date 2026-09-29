import { MAX_MUTE_SECONDS } from '../contracts/tool-limits.js';
import { EXTENDED_TOOL_NAMES, EXTENDED_READ_ONLY_TOOLS } from './extended-tools.js';

export const TOOL_NAMES = [...EXTENDED_TOOL_NAMES, 'mute_member', 'unmute_member', 'recall_message', 'set_member_card', 'get_group_members', 'get_member_info', 'react_message', 'get_reaction_users', 'view_images', 'read_forward', 'manage_attention'] as const;
export type ToolName = typeof TOOL_NAMES[number];
export type ToolMode = 'off' | 'confirm' | 'direct';
export interface ToolPolicy { mode: ToolMode; maxSeconds?: number; maxDownloadMb?: number; maxPlans?: number }
export type ResolvedToolPolicies = {
  [Name in ToolName]: ToolPolicy & (Name extends 'mute_member' ? {maxSeconds:number} : Name extends 'view_images' ? {maxDownloadMb:number} : Name extends 'manage_attention' ? {maxPlans:number} : {});
};
export interface ToolCapability { defaultMode: ToolMode; confirm: boolean; options: Readonly<Record<string, { field: 'maxSeconds'|'maxDownloadMb'|'maxPlans'; default: number; min: number; max: number }>> }
const noConfirmation = new Set<string>([...EXTENDED_READ_ONLY_TOOLS, 'get_group_members', 'get_member_info', 'react_message', 'get_reaction_users', 'view_images', 'read_forward', 'manage_attention', 'create_reminder', 'update_reminder', 'cancel_reminder']);
const directByDefault = new Set<string>([...noConfirmation, 'poke_member', 'group_sign', 'send_group_image', 'forward_message', 'send_group_forward', 'send_group_ai_voice', 'send_custom_face', 'add_custom_face', 'delete_custom_face', 'set_custom_face_description']);
export const TOOL_CAPABILITIES: Readonly<Record<ToolName, ToolCapability>> = Object.fromEntries(TOOL_NAMES.map(name => [name, Object.freeze({
  defaultMode: name === 'leave_group' ? 'off' : directByDefault.has(name) ? 'direct' : 'confirm',
  confirm: !noConfirmation.has(name),
  options: Object.freeze(name === 'mute_member' ? { max_seconds: { field:'maxSeconds', default:MAX_MUTE_SECONDS, min:1, max:MAX_MUTE_SECONDS } } : name === 'view_images' ? { max_download_mb:{field:'maxDownloadMb',default:10,min:1,max:10} } : name === 'manage_attention' ? { max_plans:{field:'maxPlans',default:16,min:1,max:32} } : {}),
})])) as unknown as Readonly<Record<ToolName, ToolCapability>>;
