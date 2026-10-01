/**
 * 把工具调用的参数和结果整理成可直接阅读的摘要。只用于展示，
 * 原始参数与结果仍按原样提供给“原始数据”。
 */

export interface ChatLine {
  /** 发言人；未知时为空串。 */
  who: string;
  text: string;
  bot?: boolean;
  recalled?: boolean;
}

export type ToolView =
  /** Bot发出的一条消息。 */
  | { kind: 'send'; text: string; replyTo: string | null }
  /** 读取到的消息列表。 */
  | { kind: 'messages'; lines: ChatLine[]; more: number }
  /** 一行文字说明。 */
  | { kind: 'line'; text: string };

type Json = Record<string, unknown>;

const record = (value: unknown): Json | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Json)
    : null;
const str = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

/** 片段渲染为一行可读文本；与 Segment 声明一一对应，未知片段给出类型。 */
export function segmentsText(segments: unknown): string {
  if (!Array.isArray(segments)) {
    return '';
  }
  return segments
    .map((raw) => {
      const s = record(raw);
      switch (s?.type) {
        case 'text':
          return str(s.text);
        case 'face':
          return `[${str(s.name) || `表情${str(s.id)}`}]`;
        case 'at':
          return `@${str(s.user_id)} `;
        case 'reply':
          return '';
        case 'image':
          return '[图片]';
        case 'record':
          return '[语音]';
        case 'forward':
          return '[合并转发]';
        default:
          return `[${str(s?.kind) || str(s?.type) || '未知'}]`;
      }
    })
    .join('')
    .trim();
}

function messageLine(raw: unknown): ChatLine | null {
  const m = record(raw);
  if (!m) {
    return null;
  }
  const text =
    m.representation === 'legacy_text'
      ? str(m.text)
      : segmentsText(m.segments) || str(m.text);
  return {
    who: str(m.nickname) || str(m.userId),
    text,
    ...(m.bot === true ? { bot: true } : {}),
    ...(m.recalled === true ? { recalled: true } : {}),
  };
}

const MAX_LINES = 20;

function messages(list: unknown): ToolView | null {
  if (!Array.isArray(list)) {
    return null;
  }
  const lines = list
    .map(messageLine)
    .filter((line): line is ChatLine => !!line);
  return {
    kind: 'messages',
    lines: lines.slice(0, MAX_LINES),
    more: Math.max(0, lines.length - MAX_LINES),
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
): ToolView | null {
  const a = record(args) ?? {};
  const r = record(result) ?? {};
  switch (name) {
    case 'send_message':
      return {
        kind: 'send',
        text: segmentsText(a.segments),
        replyTo: str(a.reply_to) || null,
      };
    case 'read_messages':
      return messages(r.messages);
    case 'read_message': {
      const line = messageLine(r.message);
      return line ? { kind: 'messages', lines: [line], more: 0 } : null;
    }
    case 'read_events': {
      if (!Array.isArray(r.events)) {
        return null;
      }
      const lines = r.events
        .map((raw): ChatLine | null => {
          const e = record(raw);
          const payload = record(e?.payload);
          return e?.type === 'message.created' && payload?.message
            ? messageLine(payload.message)
            : { who: str(e?.actor_id), text: `〈${str(e?.type)}〉` };
        })
        .filter((line): line is ChatLine => !!line);
      return {
        kind: 'messages',
        lines: lines.slice(0, MAX_LINES),
        more: Math.max(0, lines.length - MAX_LINES),
      };
    }
    case 'react_message':
      return {
        kind: 'line',
        text: `${a.action === 'remove' ? '撤回' : '给'}消息 ${str(a.message_id)} 的回应 ${str(a.emoji_id)}`,
      };
    case 'poke_member':
      return { kind: 'line', text: `戳了戳 ${str(a.user_id)}` };
    case 'send_group_ai_voice':
      return { kind: 'send', text: `[AI语音] ${str(a.text)}`, replyTo: null };
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
