import type { Model } from './model.js';

export interface ForwardReference { id: string; index: number; count?: number; countSource?: 'hint' | 'verified' }
export interface ImageReference { id: string; index: number }
export type MessageSegment =
  | { type: 'text'; text: string }
  | { type: 'face'; id: string; name?: string }
  | { type: 'at'; user_id: string }
  | { type: 'reply'; message_id: string }
  | { type: 'image'; image_id?: string; content_status: 'not_viewed'; reason?: string }
  | { type: 'forward'; forward_id?: string; count?: number; count_source?: 'hint' | 'verified'; content_status: 'not_read'; reason?: string }
  | { type: 'unsupported'; kind: string };
export interface TimelineEntry { messageId: string; userId: string; nickname: string; text: string; time: number; replyTo?: string; bot?: boolean; images?: ImageReference[]; forwards?: ForwardReference[]; segments?: MessageSegment[]; segments_omitted?: number; content_truncated?: boolean }
export interface Memory { append(entry: TimelineEntry): boolean; recent(): TimelineEntry[]; find(messageId: string): TimelineEntry | undefined; context(): string; compact(model: Model, signal?: AbortSignal): Promise<void>; clear(): void; close(): void }
