import type { JsonObject } from '../../contracts/json.js';
import { FACE_CATALOG } from '../../onebot/catalog/faces.js';
import { canonicalFaceId } from '../../onebot/catalog/schema.js';

const facesById = new Map(FACE_CATALOG.map(face => [face.id, face]));

/** Outgoing tool arguments are strict strings, including the valid ID "0". */
export function isKnownFaceId(value: unknown): value is string {
  return canonicalFaceId(value) && facesById.has(value);
}

/** Incoming APIs may encode IDs as numbers. Never echo malformed/raw values. */
export function faceMarker(value: unknown): string {
  const id = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
  if (!canonicalFaceId(id)) return '[QQ表情：未知]';
  const face = facesById.get(id);
  return face ? `[QQ表情：${face.name} id=${id}]` : `[QQ表情：名称未知 id=${id}]`;
}

export const FACE_LAYOUT_GUIDANCE = '超级表情建议不设置 reply_to、不带 reply 引用，单独调用一次 send_message 发送，segments 中只放一个 face，才能展示大表情效果；混入文字、at、其他表情或引用都会影响放大。相关文字、at 和引用通过另一次 send_message 发送，换行不等于独立消息。若有意使用句内小尺寸表情，仍可混排；这只是排版建议，不是额外的表情数量限制。';

/** Every loaded ID is sendable: no animation filter or independent face quota. */
export const FACE_ID_SCHEMA: JsonObject = Object.freeze({
  type: 'string',
  enum: Object.freeze(FACE_CATALOG.map(face => face.id)),
  description: 'QQ原生表情ID，仅从此目录选择；★表示目录中带动画配置，优先考虑独立展示，不保证所有客户端呈现相同动效；超级表情建议单独发送一条消息且不设置reply_to，以展示大表情效果。' + FACE_CATALOG.map(face => `${face.id}:${face.name}${face.animated ? '★' : ''}`).join('；'),
});
