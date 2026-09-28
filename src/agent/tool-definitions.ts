import { applyToolPolicies, optionalToolEnabled } from '../config/runtime.js';
import { resolveGroupId } from '../contracts/identity.js';
import { type ToolDefinition } from '../contracts/tools.js';
import { type JsonObject } from '../contracts/json.js';
import { buildModerationTools } from '../tools/management/moderation.js';
import type { ListenerConfig } from '../config/listener.js';
import { GROUP_TOOLS, SEND_MESSAGE_TOOL } from '../tools/messaging/tools.js';
import { VIEW_IMAGES_TOOL } from '../tools/images/tools.js';
import { READ_FORWARD_TOOL } from '../tools/forwards/tools.js';
import { FACE_LAYOUT_GUIDANCE } from '../tools/faces/tools.js';
import { MANAGE_ATTENTION_TOOL } from './attention.js';
import { createReactionTool } from '../tools/reactions/tools.js';
import { GET_REACTION_USERS_TOOL } from '../tools/reactions/users.js';
import { buildWorldTools } from '../tools/world/tools.js';
import { buildExtendedToolDefinitions } from '../tools/extended.js';

const objectSchema = (properties: JsonObject, required: string[]) => ({ type: 'object', properties, required, additionalProperties: false });
export const CHAT_TOOLS: ToolDefinition[] = [
  SEND_MESSAGE_TOOL,
  { type: 'function', function: { name: 'finish', description: '明确结束本次唤醒。未发消息时保持沉默，已发送或操作后表示完成；其后的所有工具调用不执行。', parameters: objectSchema({}, []) } },
  ...GROUP_TOOLS,
];
export function buildToolDefinitions(config: ListenerConfig, worldEnabled=false): ToolDefinition[] {
  config=applyToolPolicies(config);
  const tools = structuredClone(CHAT_TOOLS.filter(tool => tool.function.name==='get_group_members'?optionalToolEnabled(config,'get_group_members',config.tools?.members!==false):tool.function.name==='get_member_info'?optionalToolEnabled(config,'get_member_info',config.tools?.members!==false):true));
  const send = tools.find(tool => tool.function.name === 'send_message')!;
  const params = send.function.parameters as any;
  if (config.tools?.mention === false) {
    params.properties.segments.items.oneOf = params.properties.segments.items.oneOf.filter((schema: any) => schema.properties.type.const !== 'at');
    send.function.description = '向当前群发送文字和QQ原生表情，可混排或纯表情；提及成员能力已关闭，不允许at片段。表情仅使用目录id，不开放连击或指定动画结果，不另设表情数量配额。' + FACE_LAYOUT_GUIDANCE;
  }
  if (config.images?.enabled) {
    const imageTool = structuredClone(VIEW_IMAGES_TOOL);
    tools.push(imageTool);
  }
  if (config.forward?.enabled) {
    const forwardTool=structuredClone(READ_FORWARD_TOOL);
    tools.push(forwardTool);
  }
  if (config.tools?.reactions) tools.push(createReactionTool());
  if (optionalToolEnabled(config,'get_reaction_users',config.tools?.reactions===true)) tools.push(structuredClone(GET_REACTION_USERS_TOOL));
  if (config.attention?.enabled) tools.push(structuredClone(MANAGE_ATTENTION_TOOL));
  if(worldEnabled)tools.push(...buildWorldTools());
  tools.push(...buildModerationTools(config.tools?.moderation));
  tools.push(...buildExtendedToolDefinitions(resolveGroupId(config.groupId), config.tools?.extended));
  return tools;
}
