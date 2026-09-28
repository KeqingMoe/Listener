import type { ForwardReference } from '../contracts/messages.js';
export interface ExtractedForward { resourceId?: string; inline?: unknown[]; count?: number; countSource?: 'hint' | 'verified' }
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const resource = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && v.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f]/.test(v);
function json(v: unknown): Record<string, unknown> | undefined {
  if (typeof v === 'string') { if (v.length > 1024 * 1024) return; try { v = JSON.parse(v); } catch { return; } }
  return object(v) ? v : undefined;
}
/** Pure reference extraction: resource identifiers are never part of persisted references. */
export function extractForward(segment: unknown): ExtractedForward | undefined {
  if (!object(segment) || !object(segment.data)) return;
  if (segment.type === 'forward') {
    const inline = Array.isArray(segment.data.content) ? segment.data.content : undefined;
    const resourceId = resource(segment.data.id) ? segment.data.id : undefined;
    if (!inline && !resourceId) return;
    return { ...(resourceId ? { resourceId } : {}), ...(inline ? { inline, count: inline.length, countSource: 'verified' as const } : {}) };
  }
  if (segment.type !== 'json') return;
  const card = json(segment.data.data);
  if (!card || card.app !== 'com.tencent.multimsg' || !object(card.meta) || !object(card.meta.detail) || !resource(card.meta.detail.resid)) return;
  const extra = json(card.extra);
  const count = extra?.tsum;
  return { resourceId: card.meta.detail.resid, ...(typeof count === 'number' && Number.isInteger(count) && count > 0 && count <= 1000 ? { count, countSource: 'hint' as const } : {}) };
}
export function forwardReferences(messageId: string, segments: unknown): ForwardReference[] {
  if (typeof messageId !== 'string' || !/^-?\d{1,32}$/.test(messageId) || messageId.trim() !== messageId || !Array.isArray(segments)) return [];
  const refs: ForwardReference[] = [];
  for (let index = 0; index < Math.min(128, segments.length) && refs.length < 3; index++) {
    const extracted = extractForward(segments[index]);
    if (extracted) refs.push({ id: `fwd_${messageId}_${index}`, index, ...(extracted.count !== undefined ? { count: extracted.count, countSource: extracted.countSource } : {}) });
  }
  return refs;
}
export function sanitizeForwardReferences(messageId: string, refs: unknown): ForwardReference[] {
  if (typeof messageId !== 'string' || messageId.trim() !== messageId || !/^-?\d{1,32}$/.test(messageId) || !Array.isArray(refs)) return [];
  const output: ForwardReference[] = [], seen = new Set<string>();
  for (const value of refs.slice(0, 128)) {
    if (!object(value) || !Number.isInteger(value.index) || (value.index as number) < 0 || (value.index as number) > 127 || value.id !== `fwd_${messageId}_${value.index}` || seen.has(value.id as string)) continue;
    const ref: ForwardReference = { id: value.id as string, index: value.index as number };
    if (typeof value.count === 'number' && Number.isInteger(value.count) && value.count >= 0 && value.count <= 1000 && (value.countSource === 'verified' || (value.countSource === 'hint' && value.count > 0))) { ref.count = value.count; ref.countSource = value.countSource; }
    output.push(ref); seen.add(ref.id); if (output.length === 3) break;
  }
  return output;
}
export function forwardMarker(ref: ForwardReference): string {
  const valid = /^fwd_-?\d{1,32}_(0|[1-9]\d?|1[01]\d|12[0-7])$/.test(ref.id) && ref.id.trim() === ref.id;
  const count = Number.isInteger(ref.count) && ref.count! >= 0 && (ref.countSource === 'verified' || ref.countSource === 'hint') ? `${ref.count}条${ref.countSource === 'hint' ? '（提示，未核实）' : '（已核实）'}` : '条数未知';
  return `[合并转发${valid ? ` id=${ref.id}` : ''}：${count}，未读取]`;
}
