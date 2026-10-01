/**
 * 把工具调用的参数和结果整理成可直接阅读的摘要。只用于展示，
 * 原始参数与结果仍按原样提供给“原始数据”。
 */

/** 消息中的一个片段；kind 决定展示样式。 */
export interface Part {
  kind: 'text' | 'at' | 'face' | 'media' | 'other';
  text: string;
  /** 悬停提示，例如 at 的QQ号。 */
  title?: string;
}

export interface ChatLine {
  /** 发言人显示名；未知时为空串。 */
  who: string;
  userId: string;
  parts: Part[];
  bot?: boolean;
  recalled?: boolean;
}

export type ToolView =
  /** Bot发出的一条消息。 */
  | { kind: 'send'; parts: Part[]; replyTo: string | null }
  /** 读取到的消息列表。 */
  | { kind: 'messages'; lines: ChatLine[]; more: number }
  /** 一行文字说明。 */
  | { kind: 'line'; text: string };

/** QQ号到显示名的对照，来自同一范围内读到的消息与成员资料。 */
export type Names = ReadonlyMap<string, string>;

type Json = Record<string, unknown>;

const record = (value: unknown): Json | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : null;
const str = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const nameOf = (names: Names, userId: string) => names.get(userId) || userId;

/**
 * 从工具结果中收集QQ号到显示名；群名片优先于昵称，先出现的保留。
 * 本次读到的名字反映当时状态，优先；fallback（服务端按本群消息记录查到的
 * 最近名字）只补足本次没出现过的人。
 */
export function collectNames(
  tools: readonly { result: unknown }[],
  fallback: Readonly<Record<string, string>> = {},
): Map<string, string> {
  const names = new Map<string, string>();
  const add = (userId: unknown, ...candidates: unknown[]) => {
    const id = str(userId);
    const name = candidates.map(str).find(Boolean);
    if (id && name && !names.has(id)) {
      names.set(id, name);
    }
  };
  const message = (raw: unknown) => {
    const m = record(raw);
    add(m?.userId, m?.nickname);
  };
  const member = (raw: unknown) => {
    const m = record(raw);
    add(m?.user_id, m?.card, m?.nickname);
  };
  for (const tool of tools) {
    const r = record(tool.result);
    if (!r) {
      continue;
    }
    list(r.messages).forEach(message);
    message(r.message);
    for (const raw of list(r.events)) {
      message(record(record(raw)?.payload)?.message);
    }
    list(r.members).forEach(member);
    member(r.member);
  }
  for (const [id, name] of Object.entries(fallback)) {
    add(id, name);
  }
  return names;
}

/** 片段转为展示片段；与 Segment 声明一一对应，reply 片段不展示。 */
export function segmentParts(segments: unknown, names: Names = new Map()) {
  const parts: Part[] = [];
  for (const raw of list(segments)) {
    const s = record(raw);
    switch (s?.type) {
      case 'text':
        if (str(s.text)) {
          parts.push({ kind: 'text', text: str(s.text) });
        }
        break;
      case 'face':
        parts.push({
          kind: 'face',
          text: str(s.name) || `表情${str(s.id)}`,
          title: `表情 ${str(s.id)}`,
        });
        break;
      case 'at': {
        const id = str(s.user_id);
        parts.push({ kind: 'at', text: `@${nameOf(names, id)}`, title: id });
        break;
      }
      case 'reply':
        break;
      case 'image':
        parts.push({ kind: 'media', text: '图片' });
        break;
      case 'record':
        parts.push({ kind: 'media', text: '语音' });
        break;
      case 'forward':
        parts.push({ kind: 'media', text: '合并转发' });
        break;
      default:
        parts.push({
          kind: 'other',
          text: str(s?.kind) || str(s?.type) || '未知',
        });
    }
  }
  return parts;
}

/** 展示片段拼成纯文本，用于测试与无障碍文本。 */
export function partsText(parts: readonly Part[]): string {
  return parts
    .map((part) => (part.kind === 'text' ? part.text : `[${part.text}]`))
    .join('');
}

function messageLine(raw: unknown, names: Names): ChatLine | null {
  const m = record(raw);
  if (!m) {
    return null;
  }
  const userId = str(m.userId);
  const parts =
    m.representation === 'legacy_text'
      ? [{ kind: 'text' as const, text: str(m.text) }]
      : segmentParts(m.segments, names);
  return {
    who: str(m.nickname) || nameOf(names, userId),
    userId,
    parts:
      parts.length || !str(m.text)
        ? parts
        : [{ kind: 'text', text: str(m.text) }],
    ...(m.bot === true ? { bot: true } : {}),
    ...(m.recalled === true ? { recalled: true } : {}),
  };
}

const MAX_LINES = 20;

function lines(items: (ChatLine | null)[]): ToolView {
  const shown = items.filter((line): line is ChatLine => !!line);
  return {
    kind: 'messages',
    lines: shown.slice(0, MAX_LINES),
    more: Math.max(0, shown.length - MAX_LINES),
  };
}

/** 参数概要：标量写成 key=value，复杂值只写键名，按原顺序。 */
export function argumentsLine(args: unknown, max = 120): string {
  const a = record(args);
  if (!a) {
    return '';
  }
  const parts = Object.entries(a).map(([key, value]) =>
    value !== null && typeof value === 'object'
      ? key
      : `${key}=${typeof value === 'string' ? value : String(value)}`,
  );
  const line = parts.join(' ');
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** 无法给出专门展示时返回 null，由调用方显示参数概要。 */
export function toolView(
  name: string,
  args: unknown,
  result: unknown,
  names: Names = new Map(),
): ToolView | null {
  const a = record(args) ?? {};
  const r = record(result) ?? {};
  switch (name) {
    case 'send_message':
      return {
        kind: 'send',
        parts: segmentParts(a.segments, names),
        replyTo: str(a.reply_to) || null,
      };
    case 'read_messages':
      return Array.isArray(r.messages)
        ? lines(r.messages.map((m) => messageLine(m, names)))
        : null;
    case 'read_message': {
      const line = messageLine(r.message, names);
      return line ? lines([line]) : null;
    }
    case 'read_events':
      return Array.isArray(r.events)
        ? lines(
            r.events.map((raw) => {
              const e = record(raw);
              const payload = record(e?.payload);
              if (e?.type === 'message.created' && payload?.message) {
                return messageLine(payload.message, names);
              }
              const actor = str(e?.actor_id);
              return {
                who: actor ? nameOf(names, actor) : '',
                userId: actor,
                parts: [{ kind: 'other', text: str(e?.type) }],
              };
            }),
          )
        : null;
    case 'react_message':
      return {
        kind: 'line',
        text: `${a.action === 'remove' ? '撤回' : '给'}消息 ${str(a.message_id)} 的回应 ${str(a.emoji_id)}`,
      };
    case 'poke_member':
      return {
        kind: 'line',
        text: `戳了戳 ${nameOf(names, str(a.user_id))}`,
      };
    case 'send_group_ai_voice':
      return {
        kind: 'send',
        parts: [
          { kind: 'media', text: 'AI语音' },
          { kind: 'text', text: str(a.text) },
        ],
        replyTo: null,
      };
    case 'finish':
      return { kind: 'line', text: '结束本次唤醒' };
    default:
      return null;
  }
}

/** 结果中的失败或非成功状态，供醒目显示；成功时返回 null。 */
export function resultProblem(result: unknown): string | null {
  const r = record(result);
  if (!r) {
    return null;
  }
  const status = str(r.status);
  if (!status || status === 'ok') {
    return null;
  }
  const detail = str(r.error) || str(r.reason_code) || str(r.reason);
  return detail ? `${status}: ${detail}` : status;
}
