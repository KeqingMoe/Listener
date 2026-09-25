import type { ForwardReference } from './forward-references.js';
/** Original database identity and low-level constructor default. The service
 * whitelist is configured exclusively through the groups table. */
export const LISTENER_GROUP = '100000002';
export function resolveGroupId(value: unknown = LISTENER_GROUP): string {
  if (typeof value !== 'string' || !/^[1-9]\d{0,31}$/.test(value) || value.trim() !== value) throw new Error('Invalid group identity');
  return value;
}
export const OWNER_ID = '100000001';
export type JsonObject = Record<string, unknown>;
export interface Api { call(action: string, params?: JsonObject): Promise<unknown> }
export interface ToolDefinition { type: 'function'; function: { name: string; description: string; parameters: JsonObject } }
export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };
export interface ChatMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | ChatContentPart[] | null; tool_calls?: ToolCall[]; tool_call_id?: string }
export interface Completion { content: string | null; tool_calls: ToolCall[] }
export interface Model { complete(messages: ChatMessage[], tools?: ToolDefinition[], signal?: AbortSignal): Promise<Completion> }
export interface ImageReference { id: string; index: number }
export interface TimelineEntry { messageId: string; userId: string; nickname: string; text: string; time: number; replyTo?: string; bot?: boolean; images?: ImageReference[]; forwards?: ForwardReference[] }
export interface Memory { append(entry: TimelineEntry): boolean; recent(): TimelineEntry[]; find(messageId: string): TimelineEntry | undefined; context(): string; compact(model: Model, signal?: AbortSignal): Promise<void>; clear(): void; close(): void }
export interface TurnContext { groupId: string; actorId: string; messageId: string; selfId: string }
