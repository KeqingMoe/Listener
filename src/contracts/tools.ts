import type { JsonObject } from './json.js';

export interface ToolDefinition { type: 'function'; function: { name: string; description: string; parameters: JsonObject } }
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface TurnContext { groupId: string; actorId: string; messageId: string; selfId: string }
