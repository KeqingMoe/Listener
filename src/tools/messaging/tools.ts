import { resolveGroupId } from '../../contracts/identity.ts';
import { type Api } from '../../contracts/onebot.ts';
import { type Memory, type TimelineEntry } from '../../contracts/messages.ts';
import { type JsonObject } from '../../contracts/json.ts';
import {
  type ToolDefinition,
  type TurnContext,
} from '../../contracts/tools.ts';

import { imageReferences } from '../../onebot/image-references.ts';
import { forwardReferences } from '../../onebot/forward-references.ts';
import {
  FACE_ID_SCHEMA,
  FACE_LAYOUT_GUIDANCE,
  faceMarker,
  isKnownFaceId,
} from '../faces/tools.ts';
import {
  extractMessageContent,
  projectMessage,
} from '../../world/message-content.ts';

export interface GroupToolsOptions {
  members?: boolean;
  getGroupMembers?: boolean;
  getMemberInfo?: boolean;
  mention?: boolean;
  groupId?: string;
}

export interface PreparedMessage {
  segments: Array<
    | { type: 'text'; data: { text: string } }
    | { type: 'at'; data: { qq: string } }
    | { type: 'face'; data: { id: string } }
  >;
  text: string;
  replyTo?: string;
}

const schema = (properties: JsonObject, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const tool = (
  name: string,
  description: string,
  parameters: JsonObject,
): ToolDefinition => ({
  type: 'function',
  function: { name, description, parameters },
});
export const GROUP_TOOLS: ToolDefinition[] = [
  tool(
    'get_group_members',
    '读取当前群成员的明确范围，可按QQ、昵称或群名片搜索。limit必须填写；输出受通用资源边界限制，过大时返回truncated和next_offset。',
    schema(
      {
        search: { type: 'string', maxLength: 100 },
        offset: { type: 'integer', minimum: 0 },
        limit: { type: 'integer', minimum: 1 },
      },
      ['limit'],
    ),
  ),
  tool(
    'get_member_info',
    '读取当前群指定成员的基本资料。',
    schema({ user_id: { type: 'string' } }, ['user_id']),
  ),
  tool(
    'read_message',
    '读取当前群本地消息或本地近期消息引用的消息。',
    schema({ message_id: { type: 'string' } }, ['message_id']),
  ),
];
const MESSAGE_SEGMENTS_SCHEMA = {
  type: 'array',
  minItems: 1,
  items: {
    oneOf: [
      schema({ type: { const: 'text' }, text: { type: 'string' } }, [
        'type',
        'text',
      ]),
      schema({ type: { const: 'at' }, user_id: { type: 'string' } }, [
        'type',
        'user_id',
      ]),
      schema(
        {
          type: { const: 'face' },
          id: FACE_ID_SCHEMA,
          name: {
            type: 'string',
            maxLength: 80,
            description:
              '可选名称说明，仅供阅读；不会发往QQ，实际表情只由id决定。',
          },
        },
        ['type', 'id'],
      ),
    ],
  },
};
export const SEND_MESSAGE_TOOL = tool(
  'send_message',
  '向当前群发送一条文字、QQ原生表情或混合消息；发送后返回message_id，可以继续使用工具，最后必须调用 finish。face必须使用目录id，可选name仅是说明且不传给QQ，不支持连击或指定动画结果。text包括括号标记和CQ样式在内都按原文发送，不转成操作；真正@须使用at片段并核验本群成员，不支持全体或自己。' +
    FACE_LAYOUT_GUIDANCE,
  schema({ segments: MESSAGE_SEGMENTS_SCHEMA, reply_to: { type: 'string' } }, [
    'segments',
  ]),
);

function object(v: unknown): v is JsonObject {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function fail(code = 'invalid_arguments'): never {
  throw new Error(code);
}

function fields(v: unknown, allowed: string[]): asserts v is JsonObject {
  if (!object(v) || Object.keys(v).some((k) => !allowed.includes(k))) {
    fail();
  }
}

function identifier(v: unknown, message = false, remote = false): string {
  if (remote && typeof v === 'number' && Number.isSafeInteger(v)) {
    v = String(v);
  }
  if (
    typeof v !== 'string' ||
    v !== v.trim() ||
    !(message ? /^-?\d{1,32}$/ : /^[1-9]\d{0,31}$/).test(v)
  ) {
    fail();
  }
  return v;
}

function bound(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function integer(
  v: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (v === undefined) {
    return fallback;
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    fail();
  }
  return v;
}

function member(
  v: unknown,
  expectedGroup: string,
  expected?: string,
): JsonObject {
  if (!object(v) || identifier(v.group_id, false, true) !== expectedGroup) {
    fail('verification_failed');
  }
  const userId = identifier(v.user_id, false, true);
  if (expected !== undefined && userId !== expected) {
    fail('verification_failed');
  }
  return {
    user_id: userId,
    nickname: bound(v.nickname, 80),
    card: bound(v.card, 80),
    role:
      typeof v.role === 'string' &&
      ['owner', 'admin', 'member'].includes(v.role)
        ? v.role
        : 'unknown',
  };
}

function localMessage(entry: TimelineEntry): JsonObject {
  return projectMessage(entry, 4000);
}

export class GroupTools {
  private readonly options: Readonly<Required<GroupToolsOptions>>;
  private readonly groupId: string;
  constructor(
    private api: Api,
    private memory: Memory,
    options: GroupToolsOptions = {},
  ) {
    if (
      !object(options) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
      Reflect.ownKeys(options).some(
        (key) =>
          typeof key !== 'string' ||
          ![
            'members',
            'getGroupMembers',
            'getMemberInfo',
            'mention',
            'groupId',
          ].includes(key),
      )
    ) {
      throw new Error('Invalid group tool options');
    }
    this.groupId = resolveGroupId(options.groupId);
    for (const key of ['getGroupMembers', 'getMemberInfo']) {
      if (Object.hasOwn(options, key) && typeof options[key] !== 'boolean') {
        throw new Error('Invalid group tool options');
      }
    }
    const getGroupMembers = options.getGroupMembers ?? options.members ?? true,
      getMemberInfo = options.getMemberInfo ?? options.members ?? true;
    if (
      typeof getGroupMembers !== 'boolean' ||
      typeof getMemberInfo !== 'boolean'
    ) {
      throw new Error('Invalid group tool options');
    }
    const policy = {
      members: true,
      mention: true,
      ...options,
      groupId: this.groupId,
      getGroupMembers,
      getMemberInfo,
    };
    if (
      typeof policy.members !== 'boolean' ||
      typeof policy.mention !== 'boolean'
    ) {
      throw new Error('Invalid group tool options');
    }
    this.options = Object.freeze(policy);
  }

  private scope(context: TurnContext): void {
    if (context.groupId !== this.groupId) {
      fail('forbidden_group');
    }
  }

  private async call(action: string, params: JsonObject): Promise<unknown> {
    try {
      return await this.api.call(action, params);
    } catch {
      return fail('api_unavailable');
    }
  }

  private async remoteMessage(messageId: string): Promise<JsonObject> {
    const raw = await this.call('get_msg', { message_id: messageId });
    if (
      !object(raw) ||
      raw.message_type !== 'group' ||
      identifier(raw.group_id, false, true) !== this.groupId ||
      identifier(raw.message_id, true, true) !== messageId ||
      !object(raw.sender)
    ) {
      fail('verification_failed');
    }
    const userId = identifier(raw.sender.user_id, false, true);
    if (
      raw.user_id !== undefined &&
      identifier(raw.user_id, false, true) !== userId
    ) {
      fail('verification_failed');
    }
    if (!Array.isArray(raw.message) || raw.message.length > 128) {
      fail('verification_failed');
    }
    const images = imageReferences(messageId, raw.message);
    const forwards = forwardReferences(messageId, raw.message);
    for (const segment of raw.message) {
      if (!object(segment) || !object(segment.data)) {
        fail('verification_failed');
      }
    }
    const content = extractMessageContent(
      messageId,
      raw.message,
      images,
      forwards,
    );
    const replyTo = extractMessageContent(
      messageId,
      raw.message.filter((segment) => segment.type === 'reply'),
    )
      .segments.filter((segment) => segment.type === 'reply')
      .at(-1)?.message_id;
    return projectMessage(
      {
        messageId,
        userId,
        nickname: bound(raw.sender.card || raw.sender.nickname, 80),
        text: '',
        ...content,
        time:
          typeof raw.time === 'number' && Number.isFinite(raw.time)
            ? Math.floor(raw.time)
            : 0,
        ...(replyTo !== undefined ? { replyTo } : {}),
        ...(images.length ? { images } : {}),
        ...(forwards.length ? { forwards } : {}),
      },
      4000,
    );
  }

  async execute(
    name: string,
    args: unknown,
    context: TurnContext,
  ): Promise<JsonObject> {
    try {
      this.scope(context);
      if (
        (name === 'get_group_members' && !this.options.getGroupMembers) ||
        (name === 'get_member_info' && !this.options.getMemberInfo)
      ) {
        fail('tool_disabled');
      }
      if (name === 'get_group_members') {
        fields(args, ['search', 'offset', 'limit']);
        if (
          args.search !== undefined &&
          (typeof args.search !== 'string' || args.search.length > 100)
        ) {
          fail();
        }
        const search =
          (args.search as string | undefined)?.trim().toLowerCase() ?? '';
        if (
          typeof args.limit !== 'number' ||
          !Number.isSafeInteger(args.limit) ||
          args.limit < 1
        ) {
          fail();
        }
        const offset = integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER),
          limit = args.limit;
        const raw = await this.call('get_group_member_list', {
          group_id: this.groupId,
        });
        if (!Array.isArray(raw) || raw.length > 100000) {
          fail('verification_failed');
        }
        // Verify the entire source, even records outside the requested page.
        const matching = raw
          .map((v) => member(v, this.groupId))
          .filter(
            (v) =>
              !search ||
              [v.user_id, v.nickname, v.card].some((s) =>
                String(s).toLowerCase().includes(search),
              ),
          );
        const members: JsonObject[] = [];
        let bytes = 512;
        const wanted = Math.min(limit, Math.max(0, matching.length - offset));
        for (let i = 0; i < wanted; i++) {
          const value = matching[offset + i]!;
          const size = Buffer.byteLength(JSON.stringify(value), 'utf8') + 1;
          if (bytes + size > 24000) {
            break;
          }
          bytes += size;
          members.push(value);
        }
        const next = offset + members.length,
          hasMore = next < matching.length;
        return {
          status: 'ok',
          members,
          source: 'provider_member_cache',
          freshness: 'not_guaranteed',
          total_scope: 'provider_snapshot',
          total: matching.length,
          offset,
          limit,
          requested: limit,
          returned: members.length,
          has_more: hasMore,
          truncated: members.length < wanted,
          ...(members.length < wanted ? { reason: 'output_limit' } : {}),
          ...(hasMore ? { next_offset: next } : {}),
        };
      }
      if (name === 'get_member_info') {
        fields(args, ['user_id']);
        const userId = identifier(args.user_id);
        return {
          status: 'ok',
          member: member(
            await this.call('get_group_member_info', {
              group_id: this.groupId,
              user_id: userId,
              no_cache: true,
            }),
            this.groupId,
            userId,
          ),
        };
      }
      if (name === 'read_message') {
        fields(args, ['message_id']);
        const messageId = identifier(args.message_id, true);
        const local = this.memory.find(messageId);
        if (local) {
          return { status: 'ok', message: localMessage(local) };
        }
        if (
          !this.memory.recent().some((entry) => entry.replyTo === messageId)
        ) {
          fail('message_not_in_context');
        }
        return { status: 'ok', message: await this.remoteMessage(messageId) };
      }
      return { status: 'error', error: 'unknown_tool' };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      return {
        status: 'error',
        error: [
          'invalid_arguments',
          'forbidden_group',
          'verification_failed',
          'api_unavailable',
          'message_not_in_context',
          'tool_disabled',
        ].includes(code)
          ? code
          : 'tool_failed',
      };
    }
  }

  async prepareMessage(
    args: unknown,
    context: TurnContext,
  ): Promise<PreparedMessage> {
    this.scope(context);
    fields(args, ['segments', 'reply_to']);
    if (!Array.isArray(args.segments) || args.segments.length < 1) {
      fail();
    }
    let visible = false;
    const targets = new Set<string>();
    const segments: PreparedMessage['segments'] = args.segments.map(
      (segment) => {
        if (!object(segment)) {
          fail();
        }
        if (segment.type === 'text') {
          fields(segment, ['type', 'text']);
          if (
            typeof segment.text !== 'string' ||
            /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(segment.text)
          ) {
            fail();
          }
          visible ||= !!segment.text.trim();
          return { type: 'text' as const, data: { text: segment.text } };
        }
        if (segment.type === 'face') {
          fields(segment, ['type', 'id', 'name']);
          if (
            !isKnownFaceId(segment.id) ||
            (Object.hasOwn(segment, 'name') &&
              (typeof segment.name !== 'string' || segment.name.length > 80))
          ) {
            fail();
          }
          visible = true;
          return { type: 'face' as const, data: { id: segment.id } };
        }
        if (segment.type !== 'at') {
          fail();
        }
        if (!this.options.mention) {
          fail('tool_disabled');
        }
        fields(segment, ['type', 'user_id']);
        const target = identifier(segment.user_id);
        if (target === context.selfId) {
          fail();
        }
        targets.add(target);
        visible = true;
        return { type: 'at' as const, data: { qq: target } };
      },
    );
    if (!visible) {
      fail();
    }
    const replyTo = Object.hasOwn(args, 'reply_to')
      ? identifier(args.reply_to, true)
      : undefined;
    for (const target of targets) {
      member(
        await this.call('get_group_member_info', {
          group_id: this.groupId,
          user_id: target,
          no_cache: true,
        }),
        this.groupId,
        target,
      );
    }
    if (replyTo !== undefined && !this.memory.find(replyTo)) {
      if (!this.memory.recent().some((entry) => entry.replyTo === replyTo)) {
        fail('forbidden_reference');
      }
      await this.remoteMessage(replyTo);
    }
    return {
      segments,
      text: segments
        .map((s) =>
          s.type === 'text'
            ? s.data.text
            : s.type === 'face'
              ? faceMarker(s.data.id)
              : `[at:${s.data.qq}]`,
        )
        .join(''),
      ...(replyTo !== undefined ? { replyTo } : {}),
    };
  }
}
