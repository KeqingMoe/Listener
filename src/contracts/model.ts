import type { ToolCall, ToolDefinition } from './tools.ts';

export type ChatContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };
export interface ChatMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | ChatContentPart[] | null; tool_calls?: ToolCall[]; tool_call_id?: string }
export interface Completion { content: string | null; tool_calls: ToolCall[] }
export interface Model { complete(messages: ChatMessage[], tools?: ToolDefinition[], signal?: AbortSignal): Promise<Completion> }
