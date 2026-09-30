import sharp from 'sharp';
import type { ToolDefinition, TurnContext } from '../../contracts/tools.ts';
import type { JsonObject } from '../../contracts/json.ts';
import { ARTIFACT_LIMITS, ArtifactError, type Artifact, type ArtifactStore } from '../../artifacts/store.ts';

export const ARTIFACT_TOOL_NAMES = ['create_artifact', 'create_image', 'list_artifacts'] as const;
export type ArtifactToolName = (typeof ARTIFACT_TOOL_NAMES)[number];
export const IMAGE_LIMITS = { edge: 8192 } as const;
const IMAGE_FORMATS = ['png', 'jpeg', 'webp'] as const;
const MB = ARTIFACT_LIMITS.bytes / 1024 / 1024;

const bytesSchema = (description: string) => ({ type: 'array', items: { type: 'integer', minimum: 0, maximum: 255 }, description });
const common = {
  name: { type: 'string', minLength: 1, maxLength: ARTIFACT_LIMITS.name, description: '显示名，也是上传群文件时的文件名；不得含斜杠或控制字符。' },
  description: { type: 'string', minLength: 1, maxLength: ARTIFACT_LIMITS.description, description: '内容说明，确认上传时会展示给主人。' },
  ttl_ms: { type: 'integer', minimum: 1, maximum: ARTIFACT_LIMITS.ttlMs, description: `保留时长毫秒，最长${ARTIFACT_LIMITS.ttlMs}（24小时），到期自动删除。` },
};
const DEFINITIONS: Record<ArtifactToolName, ToolDefinition> = {
  create_artifact: { type: 'function', function: { name: 'create_artifact', description: `把文本或字节保存为本群的产物（artifact），返回artifact_id，可用于upload_group_file等工具。单个最大${MB}MiB；存储已满时返回artifact_storage_full，不会自动腾出空间。直接调用时字节为0..255整数数组；沙箱代码内可传Uint8Array。`, parameters: { type: 'object', additionalProperties: false, required: ['name', 'description', 'ttl_ms', 'content'], properties: {
    ...common,
    content: { oneOf: [{ type: 'string', description: 'UTF-8文本。' }, bytesSchema('原始字节。')] },
    media_type: { type: 'string', maxLength: ARTIFACT_LIMITS.mediaType, description: 'MIME类型，默认application/octet-stream；不会根据内容推断。' },
  } } } },
  create_image: { type: 'function', function: { name: 'create_image', description: `把RGBA像素编码为图片产物，返回artifact_id，可用send_group_image发送或view_images查看。pixels长度必须为width×height×4，宽高各不超过${IMAGE_LIMITS.edge}。沙箱代码内pixels可传Uint8Array。`, parameters: { type: 'object', additionalProperties: false, required: ['name', 'description', 'ttl_ms', 'width', 'height', 'pixels', 'format'], properties: {
    ...common,
    width: { type: 'integer', minimum: 1, maximum: IMAGE_LIMITS.edge },
    height: { type: 'integer', minimum: 1, maximum: IMAGE_LIMITS.edge },
    pixels: bytesSchema('按行排列的RGBA像素，每像素4字节。'),
    format: { type: 'string', enum: [...IMAGE_FORMATS] },
  } } } },
  list_artifacts: { type: 'function', function: { name: 'list_artifacts', description: '列出本群未过期的产物（新到旧），含名称、说明、类型、大小与到期时间。', parameters: { type: 'object', additionalProperties: false, properties: {
    offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
  } } } },
};

export function buildArtifactToolDefinitions(enabled: readonly string[]): ToolDefinition[] {
  return ARTIFACT_TOOL_NAMES.filter(name => enabled.includes(name)).map(name => structuredClone(DEFINITIONS[name]));
}

class InvalidArguments extends Error {}
const invalid = (): never => { throw new InvalidArguments(); };

function fields(args: unknown, required: readonly string[], optional: readonly string[]): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args) || ![Object.prototype, null].includes(Object.getPrototypeOf(args))) {invalid();}
  const record = args as Record<string, unknown>;
  for (const key of Object.keys(record)) {if (!required.includes(key) && !optional.includes(key)) {invalid();}}
  for (const key of required) {if (!Object.hasOwn(record, key)) {invalid();}}
  return record;
}

/** 字节字段：沙箱代码传入Uint8Array，直接调用时传入整数数组。 */
export function byteField(value: unknown, max: number): Uint8Array {
  if (value instanceof Uint8Array) { if (value.byteLength > max) {throw new ArtifactError('artifact_too_large');} return value; }
  if (!Array.isArray(value)) {return invalid();}
  if (value.length > max) {throw new ArtifactError('artifact_too_large');}
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) { const v = value[i]; if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255) {invalid();} out[i] = v as number; }
  return out;
}

export function artifactView(artifact: Artifact): JsonObject {
  return { artifact_id: artifact.artifactId, name: artifact.name, description: artifact.description, media_type: artifact.mediaType, size: artifact.size, sha256: artifact.sha256, created_at: new Date(artifact.createdAt).toISOString(), expires_at: new Date(artifact.expiresAt).toISOString() };
}

const integer = (value: unknown, min: number, max: number): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid();

export class ArtifactTools {
  constructor(private readonly store: ArtifactStore) {}
  async execute(name: string, args: unknown, context: TurnContext, signal?: AbortSignal): Promise<JsonObject> {
    const scope = { selfId: context.selfId, groupId: context.groupId };
    try {
      if (signal?.aborted) {return { status: 'error', error: 'cancelled' };}
      if (name === 'create_artifact') {
        const a = fields(args, ['name', 'description', 'ttl_ms', 'content'], ['media_type']);
        const bytes = typeof a.content === 'string' ? Buffer.from(a.content, 'utf8') : byteField(a.content, ARTIFACT_LIMITS.bytes);
        if (a.media_type !== undefined && typeof a.media_type !== 'string') {invalid();}
        const artifact = await this.store.create({ ...scope, name: a.name as string, description: a.description as string, ttlMs: a.ttl_ms as number, mediaType: (a.media_type as string | undefined) ?? 'application/octet-stream', bytes });
        return { status: 'ok', ...artifactView(artifact) };
      }
      if (name === 'create_image') {
        const a = fields(args, ['name', 'description', 'ttl_ms', 'width', 'height', 'pixels', 'format'], []);
        const width = integer(a.width, 1, IMAGE_LIMITS.edge), height = integer(a.height, 1, IMAGE_LIMITS.edge);
        if (!IMAGE_FORMATS.includes(a.format as typeof IMAGE_FORMATS[number])) {invalid();}
        const pixels = byteField(a.pixels, IMAGE_LIMITS.edge * IMAGE_LIMITS.edge * 4);
        if (pixels.byteLength !== width * height * 4) {invalid();}
        const format = a.format as typeof IMAGE_FORMATS[number];
        const image = sharp(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength), { raw: { width, height, channels: 4 }, limitInputPixels: false });
        const encoded = format === 'png' ? await image.png().toBuffer() : format === 'jpeg' ? await image.flatten({ background: '#ffffff' }).jpeg({ quality: 90 }).toBuffer() : await image.webp({ quality: 90 }).toBuffer();
        if (signal?.aborted) {return { status: 'error', error: 'cancelled' };}
        const artifact = await this.store.create({ ...scope, name: a.name as string, description: a.description as string, ttlMs: a.ttl_ms as number, mediaType: `image/${format}`, bytes: encoded });
        return { status: 'ok', ...artifactView(artifact), width, height };
      }
      if (name === 'list_artifacts') {
        const a = fields(args, [], ['offset', 'limit']);
        const page = this.store.list(scope, a.offset === undefined ? 0 : integer(a.offset, 0, Number.MAX_SAFE_INTEGER), a.limit === undefined ? 20 : integer(a.limit, 1, 100));
        return { status: 'ok', artifacts: page.artifacts.map(artifactView), has_more: page.hasMore };
      }
      return { status: 'error', error: 'unknown_tool' };
    } catch (error) {
      if (error instanceof InvalidArguments) {return { status: 'error', error: 'invalid_arguments' };}
      if (error instanceof ArtifactError) {return { status: 'error', error: error.message };}
      return { status: 'error', error: 'artifact_failed' };
    }
  }
}
