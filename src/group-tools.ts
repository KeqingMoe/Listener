import { resolveGroupId, type Api, type Memory, type JsonObject, type ToolDefinition, type TurnContext, type TimelineEntry } from './contracts.js';

import { imageReferences } from './image-tools.js';
import { forwardReferences } from './forward-references.js';
import { FACE_ID_SCHEMA, FACE_LAYOUT_GUIDANCE, faceMarker, isKnownFaceId } from './face-tools.js';
import { extractMessageContent, projectMessage } from './message-content.js';

export interface GroupToolsOptions {
  members?: boolean;
  mention?: boolean;
  maxParts?: number;
  groupId?: string;
}

export interface PreparedPart {
  segments: Array<{ type: 'text'; data: { text: string } } | { type: 'at'; data: { qq: string } } | { type: 'face'; data: { id: string } }>;
  text: string;
  replyTo?: string;
}
const schema = (properties: JsonObject, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const tool = (name: string, description: string, parameters: JsonObject): ToolDefinition => ({ type: 'function', function: { name, description, parameters } });
export const GROUP_TOOLS: ToolDefinition[] = [
  tool('get_group_members', '读取当前群成员的有限分页，可按QQ、昵称或群名片搜索。', schema({ search: { type: 'string', maxLength: 100 }, offset: { type: 'integer', minimum: 0, maximum: 100000 }, limit: { type: 'integer', minimum: 1, maximum: 50 } })),
  tool('get_member_info', '读取当前群指定成员的基本资料。', schema({ user_id: { type: 'string' } }, ['user_id'])),
  tool('read_message', '读取当前群本地消息或本地近期消息引用的消息。', schema({ message_id: { type: 'string' } }, ['message_id'])),
];
export const SEND_MESSAGE_TOOL = tool('send_message', '向当前群发送文字、QQ原生表情或混合消息；face只需目录中的id，普通和超级表情都可发送，不支持指定连击或动画结果。条数及片段数沿用本轮上限，不另设表情数量配额。收到和历史消息中的text/at/face片段与此格式一致，face的可选name只是说明。text中包括括号标记、CQ样式在内的字符串均按普通文字发送，不自动转为表情或提及；要表达真实表情或@必须使用face或at片段。使用结构化at片段提及成员，不支持全员或自己。' + FACE_LAYOUT_GUIDANCE, schema({ parts: { type: 'array', minItems: 1, maxItems: 3, items: schema({ segments: { type: 'array', minItems: 1, maxItems: 12, items: { oneOf: [schema({ type: { const: 'text' }, text: { type: 'string', maxLength: 800 } }, ['type', 'text']), schema({ type: { const: 'at' }, user_id: { type: 'string' } }, ['type', 'user_id']), schema({ type: { const: 'face' }, id: FACE_ID_SCHEMA, name: {type:'string',maxLength:80,description:'可选名称说明，仅供阅读；不会发往QQ，实际表情只由id决定。'} }, ['type', 'id'])] } }, reply_to: { type: 'string' } }, ['segments']) } }, ['parts']));

function object(v: unknown): v is JsonObject { return !!v && typeof v === 'object' && !Array.isArray(v); }
function fail(code = 'invalid_arguments'): never { throw new Error(code); }
function fields(v: unknown, allowed: string[]): asserts v is JsonObject {
  if (!object(v) || Object.keys(v).some(k => !allowed.includes(k))) fail();
}
function identifier(v: unknown, message = false, remote = false): string {
  if (remote && typeof v === 'number' && Number.isSafeInteger(v)) v = String(v);
  if (typeof v !== 'string' || v !== v.trim() || !(message ? /^-?\d{1,32}$/ : /^[1-9]\d{0,31}$/).test(v)) fail();
  return v;
}
function bound(v: unknown, max: number): string { return typeof v === 'string' ? v.slice(0, max) : ''; }
function integer(v: unknown, fallback: number, min: number, max: number): number {
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) fail();
  return v;
}
function member(v: unknown, expectedGroup: string, expected?: string): JsonObject {
  if (!object(v) || identifier(v.group_id, false, true) !== expectedGroup) fail('verification_failed');
  const userId = identifier(v.user_id, false, true);
  if (expected !== undefined && userId !== expected) fail('verification_failed');
  return { user_id: userId, nickname: bound(v.nickname, 80), card: bound(v.card, 80), role: typeof v.role === 'string' && ['owner', 'admin', 'member'].includes(v.role) ? v.role : 'unknown' };
}
function localMessage(entry: TimelineEntry): JsonObject {
  return projectMessage(entry,4000);
}

export class GroupTools {
  private readonly options: Readonly<Required<GroupToolsOptions>>;
  private readonly groupId: string;
  constructor(private api: Api, private memory: Memory, options: GroupToolsOptions = {}) {
    if (!object(options) || ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
      Reflect.ownKeys(options).some(key => typeof key !== 'string' || !['members', 'mention', 'maxParts', 'groupId'].includes(key))) throw new Error('Invalid group tool options');
    this.groupId = resolveGroupId(options.groupId);
    const policy = { members: true, mention: true, maxParts: 3, ...options, groupId: this.groupId };
    if (typeof policy.members !== 'boolean' || typeof policy.mention !== 'boolean' ||
      !Number.isInteger(policy.maxParts) || policy.maxParts < 1 || policy.maxParts > 10) throw new Error('Invalid group tool options');
    this.options = Object.freeze(policy);
  }
  private scope(context: TurnContext): void { if (context.groupId !== this.groupId) fail('forbidden_group'); }
  private async call(action: string, params: JsonObject): Promise<unknown> {
    try { return await this.api.call(action, params); } catch { return fail('api_unavailable'); }
  }
  private async remoteMessage(messageId: string): Promise<JsonObject> {
    const raw = await this.call('get_msg', { message_id: messageId });
    if (!object(raw) || raw.message_type !== 'group' || identifier(raw.group_id, false, true) !== this.groupId || identifier(raw.message_id, true, true) !== messageId || !object(raw.sender)) fail('verification_failed');
    const userId = identifier(raw.sender.user_id, false, true);
    if (raw.user_id !== undefined && identifier(raw.user_id, false, true) !== userId) fail('verification_failed');
    if (!Array.isArray(raw.message) || raw.message.length > 128) fail('verification_failed');
    const images = imageReferences(messageId,raw.message);
    const forwards = forwardReferences(messageId,raw.message);
    for (const segment of raw.message) if (!object(segment) || !object(segment.data)) fail('verification_failed');
    const content=extractMessageContent(messageId,raw.message,images,forwards);
    const replyTo=extractMessageContent(messageId,raw.message.filter(segment=>segment.type==='reply')).segments.filter(segment=>segment.type==='reply').at(-1)?.message_id;
    return projectMessage({ messageId, userId, nickname: bound(raw.sender.card || raw.sender.nickname, 80), text:'', ...content, time: typeof raw.time === 'number' && Number.isFinite(raw.time) ? Math.floor(raw.time) : 0, ...(replyTo!==undefined?{replyTo}:{}), ...(images.length ? {images} : {}), ...(forwards.length ? {forwards} : {}) },4000);
  }
  async execute(name: string, args: unknown, context: TurnContext): Promise<JsonObject> {
    try {
      this.scope(context);
      if (!this.options.members && (name === 'get_group_members' || name === 'get_member_info')) fail('tool_disabled');
      if (name === 'get_group_members') {
        fields(args, ['search', 'offset', 'limit']);
        if (args.search !== undefined && (typeof args.search !== 'string' || args.search.length > 100)) fail();
        const search = (args.search as string | undefined)?.trim().toLowerCase() ?? '';
        const offset = integer(args.offset, 0, 0, 100000), limit = integer(args.limit, 20, 1, 50);
        const raw = await this.call('get_group_member_list', { group_id: this.groupId });
        if (!Array.isArray(raw) || raw.length > 100000) fail('verification_failed');
        // Verify the entire source, even records outside the requested page.
        const matching = raw.map(v => member(v, this.groupId)).filter(v => !search || [v.user_id, v.nickname, v.card].some(s => String(s).toLowerCase().includes(search)));
        return { status: 'ok', members: matching.slice(offset, offset + limit), total: matching.length, offset, limit, has_more: offset + limit < matching.length };
      }
      if (name === 'get_member_info') {
        fields(args, ['user_id']); const userId = identifier(args.user_id);
        return { status: 'ok', member: member(await this.call('get_group_member_info', { group_id: this.groupId, user_id: userId, no_cache: true }), this.groupId, userId) };
      }
      if (name === 'read_message') {
        fields(args, ['message_id']); const messageId = identifier(args.message_id, true);
        const local = this.memory.find(messageId);
        if (local) return { status: 'ok', message: localMessage(local) };
        if (!this.memory.recent().some(entry => entry.replyTo === messageId)) fail('message_not_in_context');
        return { status: 'ok', message: await this.remoteMessage(messageId) };
      }
      return { status: 'error', error: 'unknown_tool' };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      return { status: 'error', error: ['invalid_arguments', 'forbidden_group', 'verification_failed', 'api_unavailable', 'message_not_in_context', 'tool_disabled'].includes(code) ? code : 'tool_failed' };
    }
  }
  async prepareMessage(args: unknown, context: TurnContext): Promise<PreparedPart[]> {
    this.scope(context); fields(args, ['parts']);
    if (!Array.isArray(args.parts) || args.parts.length < 1 || args.parts.length > this.options.maxParts) fail();
    let atCount = 0;
    const targets = new Set<string>();
    const parts: PreparedPart[] = args.parts.map(part => {
      fields(part, ['segments', 'text', 'reply_to']);
      const hasText = Object.hasOwn(part, 'text'), hasSegments = Object.hasOwn(part, 'segments');
      if (hasText === hasSegments) fail();
      const source = hasText ? [{ type: 'text', text: part.text }] : part.segments;
      if (!Array.isArray(source) || source.length < 1 || source.length > 12) fail();
      let textLength = 0, visible = false;
      const segments: PreparedPart['segments'] = source.map(segment => {
        if (!object(segment)) fail();
        if (segment.type === 'text') {
          fields(segment, ['type', 'text']);
          if (typeof segment.text !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(segment.text)) fail();
          textLength += segment.text.length;
          visible ||= !!segment.text.trim();
          return { type: 'text' as const, data: { text: segment.text } };
        }
        if (segment.type === 'face') {
          fields(segment,['type','id','name']);
          if (!isKnownFaceId(segment.id)||(Object.hasOwn(segment,'name')&&(typeof segment.name!=='string'||segment.name.length>80))) fail();
          visible = true;
          return {type:'face' as const,data:{id:segment.id}};
        }
        if (segment.type !== 'at') fail();
        if (!this.options.mention) fail('tool_disabled');
        fields(segment, ['type', 'user_id']);
        const target = identifier(segment.user_id);
        if (target === context.selfId || ++atCount > 3) fail();
        targets.add(target); visible = true;
        return { type: 'at' as const, data: { qq: target } };
      });
      if (!visible || textLength > 800) fail();
      // Text is never interpreted as operations, including marker/CQ-looking strings.
      // Actual mentions and faces were independently validated as structured segments.
      const replyTo = Object.hasOwn(part, 'reply_to') ? identifier(part.reply_to, true) : undefined;
      return { segments, text: segments.map(s => s.type === 'text' ? s.data.text : s.type === 'face' ? faceMarker(s.data.id) : `[at:${s.data.qq}]`).join(''), ...(replyTo !== undefined ? { replyTo } : {}) };
    });
    for (const target of targets) member(await this.call('get_group_member_info', { group_id: this.groupId, user_id: target, no_cache: true }), this.groupId, target);
    for (const part of parts) if (part.replyTo !== undefined && !this.memory.find(part.replyTo)) {
      if (!this.memory.recent().some(entry=>entry.replyTo===part.replyTo)) fail('forbidden_reference');
      await this.remoteMessage(part.replyTo);
    }
    return parts;
  }
}
