import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { FACE_CATALOG_VERSION, FACE_DATA_LIMIT, extractFaceCatalog } from '../../cli/sync-faces.js';
import type { ToolDefinition } from '../../contracts/index.js';

export interface ReactionEntry { readonly id: string; readonly name: string; readonly kind: 'face'|'emoji'; readonly emoji?: string }
const defaultPath = new URL(`../../../data/napcat-face-config-v${FACE_CATALOG_VERSION}.json`, import.meta.url);
const invalid = (): never => { throw new Error('Invalid QQ reaction catalog'); };
function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    return [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'));
  } catch { return false; }
}
function array(value: unknown): value is unknown[] {
  if (!Array.isArray(value) || value.length > 1024) return false;
  try {
    return Reflect.ownKeys(value).length === value.length + 1 && Array.from({ length: value.length }, (_, i) => i)
      .every(i => Object.hasOwn(value, i) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, String(i))!, 'value'));
  } catch { return false; }
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !!value.trim() &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value) && [...value].every(char => {
      const code = char.codePointAt(0)!;
      return code < 0xd800 || code > 0xdfff;
    });
}
function unicodeId(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value || !/^[1-9][0-9]{3,6}$/.test(value)) return false;
  const code = Number(value);
  return String(code) === value && Number.isSafeInteger(code) && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
}
/** Minimal candidate projection, not a claim that QQ accepts every reaction. */
export function extractReactionCatalog(raw: unknown): readonly ReactionEntry[] {
  if (!record(raw) || !array(raw.sysface) || !array(raw.emoji)) return invalid();
  if (!raw.sysface.every(entry => record(entry) && typeof entry.QSid === 'string' && entry.QSid.trim() === entry.QSid && /^(0|[1-9][0-9]{0,2})$/.test(entry.QSid))) return invalid();
  let faces;
  try { faces = extractFaceCatalog(raw).faces; } catch { return invalid(); }
  const result: ReactionEntry[] = [];
  const ids = new Set<string>();
  for (const face of faces) {
    if (face.id.length > 3 || !text(face.name, 64) || ids.has(face.id)) return invalid();
    ids.add(face.id);
    result.push(Object.freeze({ id: face.id, name: face.name.trim(), kind: 'face' as const }));
  }
  for (const entry of raw.emoji) {
    if (!record(entry) || !unicodeId(entry.QCid) || !text(entry.QSid, 32) || typeof entry.QDes !== 'string') return invalid();
    const name = entry.QDes.replace(/^\//, '');
    if (!text(name, 64) || ids.has(entry.QCid) || entry.QSid.codePointAt(0) !== Number(entry.QCid)) return invalid();
    ids.add(entry.QCid);
    result.push(Object.freeze({ id: entry.QCid, name: name.trim(), kind: 'emoji' as const, emoji: entry.QSid }));
  }
  return Object.freeze(result);
}
// Independently hand-authored examples only; never vendor the upstream table.
const fallback: readonly ReactionEntry[] = Object.freeze([
  Object.freeze({ id: '0', name: '惊讶', kind: 'face' as const }),
  Object.freeze({ id: '14', name: '微笑', kind: 'face' as const }),
  Object.freeze({ id: '76', name: '赞', kind: 'face' as const }),
  Object.freeze({ id: '99', name: '鼓掌', kind: 'face' as const }),
  Object.freeze({ id: '375', name: '超级鼓掌', kind: 'face' as const }),
  Object.freeze({ id: '128077', name: '赞', kind: 'emoji' as const, emoji: '👍' }),
  Object.freeze({ id: '128079', name: '鼓掌', kind: 'emoji' as const, emoji: '👏' }),
  Object.freeze({ id: '128522', name: '微笑', kind: 'emoji' as const, emoji: '😊' }),
]);
/** Missing raw resources alone may fall back. Existing invalid/symlink/special files fail closed. */
export function loadReactionCatalog(path: string|URL = defaultPath): readonly ReactionEntry[] {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return fallback;
    throw new Error('Cannot read QQ reaction catalog');
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > FACE_DATA_LIMIT) return invalid();
    const bytes = Buffer.alloc(FACE_DATA_LIMIT + 1); let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > FACE_DATA_LIMIT) return invalid();
    return extractReactionCatalog(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))));
  } catch { return invalid(); }
  finally { closeSync(fd); }
}
let cached: readonly ReactionEntry[]|undefined;
let known: ReadonlySet<string>|undefined;
/** Intentionally lazy: importing a disabled feature never opens its catalog. */
export function getReactionCatalog(): readonly ReactionEntry[] {
  return cached ??= loadReactionCatalog();
}
export function isKnownReactionId(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value || String(Number(value)) !== value || !/^(0|[1-9][0-9]{0,6})$/.test(value)) return false;
  known ??= new Set(getReactionCatalog().map(entry => entry.id));
  return known.has(value);
}
export function createReactionTool(): ToolDefinition {
  const catalog = getReactionCatalog();
  return { type: 'function', function: {
    name: 'react_message',
    description: '对当前群可核验消息添加或取消本账号自己的表情回应，不发送一条新消息，也不是群管理授权。add添加，remove取消；即时执行，后续取消本轮不回滚已执行操作。成功不自动结束本轮；若仅回应表情，最后调用finish结束。可与send_message、finish、manage_attention在同一次响应中按顺序组合，也可回应多个人的消息；finish必须放在最后，其后的所有工具都不执行。目录是NapCat候选表，不保证QQ接受每个ID；失败不要捏造成功，结果未知不要重试。通常无需再发一句“已点赞”。',
    parameters: { type: 'object', additionalProperties: false, required: ['message_id', 'emoji_id', 'action'], properties: {
      message_id: { type: 'string', minLength: 1, maxLength: 17, pattern: '^(0|[1-9][0-9]*|-[1-9][0-9]*)$', description: '当前群本轮可见消息或其可核验引用的OneBot消息ID，不是转发内的声称ID或QQ内部长ID；必须可精确转换成安全整数。' },
      emoji_id: { type: 'string', enum: catalog.map(entry => entry.id), description: '使用候选目录的ID字符串，不要直接传emoji字符。QQ与Unicode是不同类别：' + catalog.map(entry => entry.kind === 'face' ? `[QQ]${entry.id}:${entry.name}` : `[Unicode]${entry.id}:${entry.emoji} ${entry.name}`).join('；') },
      action: { type: 'string', enum: ['add', 'remove'] },
    } },
  } };
}
