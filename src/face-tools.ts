import type { JsonObject } from './contracts.js';
import { FACE_CATALOG } from './face-catalog.js';
import { canonicalFaceId } from './sync-faces.js';

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

/** Every loaded ID is sendable: no animation filter or independent face quota. */
export const FACE_ID_SCHEMA: JsonObject = Object.freeze({
  type: 'string',
  enum: Object.freeze(FACE_CATALOG.map(face => face.id)),
  description: 'QQ原生表情ID，仅从此目录选择；★表示目录中带动画配置，不保证所有客户端呈现相同动效。' + FACE_CATALOG.map(face => `${face.id}:${face.name}${face.animated ? '★' : ''}`).join('；'),
});
