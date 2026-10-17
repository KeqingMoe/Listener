import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import {
  type Avatar,
  Chat,
  type Client,
  GroupId,
  type MemberInfo,
  MessageId,
  type Send,
  Time,
  UserId,
} from '@listener/chat';
import type { Logger } from 'pino';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { runLoop } from '@/loop';
import { toolError, tools } from '@/tools';

const quiet: Logger = pino({ level: 'silent' });

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('夹具无效');
  }
  return value;
}

function memberChat(info?: MemberInfo, avatar?: Avatar): Chat {
  return new Chat(
    { selfId: must(UserId('1')), groupId: must(GroupId('100')) },
    {
      async send() {
        return must(MessageId(1));
      },
      async message() {
        return undefined;
      },
      async info() {
        return info;
      },
      async avatar() {
        return avatar;
      },
      watch() {
        return () => {};
      },
      dispose() {},
    },
  );
}

function memberTool(chat: Chat, log: Logger = quiet) {
  const tool = tools(
    chat,
    new AbortController().signal,
    {
      at: true,
      reply: true,
    },
    log,
  ).find(tool => tool.name === 'readMember');
  if (tool === undefined) {
    throw new Error('没有 readMember');
  }
  return tool;
}

function text(content: { type: string; text?: string }[]): string {
  const [part] = content;
  if (part?.type !== 'text' || part.text === undefined) {
    throw new Error('没有文本');
  }
  return part.text;
}

describe('tools', () => {
  it('sendMessage 走 chat.send', async () => {
    const sent: Send[] = [];
    const abort = new AbortController();
    const client: Client = {
      async send(_groupId, message) {
        sent.push(message);
        return must(MessageId(20));
      },
      async message() {
        return undefined;
      },
      async info() {
        return undefined;
      },
      async avatar() {
        return undefined;
      },
      watch() {
        return () => {};
      },
      dispose() {},
    };
    const chat = new Chat(
      {
        selfId: must(UserId('1')),
        groupId: must(GroupId('100')),
      },
      client,
    );
    await chat.append({
      type: 'message.created',
      msgId: must(MessageId(10)),
      time: must(Time(1000)),
      userId: must(UserId('2')),
      segments: ['hello kq'],
    });
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('sendMessage', {
            segments: ['并非 kq'],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(''),
    ]);
    const running = runLoop(
      chat,
      10,
      {
        model: faux.getModel(),
        streamFn: models.streamSimple.bind(models),
        signal: abort.signal,
        mentioned: { at: true, reply: true },
      },
      quiet,
    );
    await vi.waitFor(() => {
      expect(sent).toEqual([{ segments: ['并非 kq'] }]);
    });
    abort.abort();
    await running;
  });

  it('readMember 把主页喂全', async () => {
    const chat = memberChat({
      nickname: '阿三',
      card: '老张',
      role: 'admin',
      title: '卷王',
      sex: 'male',
      age: 20,
      area: '广东',
      level: '3',
      qqLevel: 32,
      joinTime: must(Time(1595294844000)),
      lastActiveTime: must(Time(1700000000000)),
    });

    const result = await memberTool(chat).execute('', { userId: '2' });
    expect(JSON.parse(text(result.content))).toMatchObject({
      userId: '2',
      nickname: '阿三',
      card: '老张',
      sex: 'male',
      age: 20,
      area: '广东',
      level: '3',
      qqLevel: '☀️☀️',
      role: 'admin',
      title: '卷王',
    });
    const json = text(result.content);
    expect(json).not.toContain('"isRobot"');
    expect(json).toMatch(/"joinTime":"\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}"/);
    expect(json).toMatch(
      /"lastActiveTime":"\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}"/,
    );
  });

  it('readMember 没填的给值，没有的不给', async () => {
    const chat = memberChat({
      nickname: '阿三',
      sex: 'unknown',
      age: 0,
      area: '',
      level: '0',
      qqLevel: 65,
      joinTime: must(Time(1)),
      isRobot: true,
    });

    const json = text(
      (await memberTool(chat).execute('', { userId: '2' })).content,
    );
    expect(json).not.toContain('"role"');
    expect(json).toContain('"sex":"unknown"');
    expect(json).toContain('"age":0');
    expect(json).toContain('"area":""');
    expect(json).toContain('"qqLevel":"👑⭐"');
    expect(json).toContain('"isRobot":true');
    expect(json).not.toContain('"card"');
    expect(json).not.toContain('"title"');
    expect(json).not.toContain('"lastActiveTime"');
  });

  it('readMember 查不到就是 null', async () => {
    const result = await memberTool(memberChat()).execute('', { userId: '2' });
    expect(result.content).toEqual([{ type: 'text', text: 'null' }]);
  });

  it('readMember 连头像一起给', async () => {
    const chat = memberChat(
      {
        nickname: '阿三',
        sex: 'unknown',
        age: 0,
        area: '',
        level: '0',
        qqLevel: 0,
        joinTime: must(Time(1)),
      },
      { data: 'AA==', mimeType: 'image/jpeg' },
    );

    const result = await memberTool(chat).execute('', { userId: '2' });
    expect(result.content[1]).toEqual({
      type: 'image',
      data: 'AA==',
      mimeType: 'image/jpeg',
    });
  });

  it('readMember 的日志只记字节数，不记图', async () => {
    const lines: string[] = [];
    const log = pino(
      { level: 'info' },
      { write: (line: string) => void lines.push(line) },
    );
    const chat = memberChat(
      {
        nickname: '阿三',
        sex: 'unknown',
        age: 0,
        area: '',
        level: '0',
        qqLevel: 0,
        joinTime: must(Time(1)),
      },
      { data: 'AA==', mimeType: 'image/jpeg' },
    );

    await memberTool(chat, log).execute('', { userId: '2' });
    const written = lines.join('\n');
    expect(written).not.toContain('AA==');
    expect(written).toContain('"bytes":1');
  });

  it('readMember 的 userId 不合法就报错', async () => {
    await expect(
      memberTool(memberChat()).execute('', { userId: '0' }),
    ).rejects.toThrow(toolError.invalid);
  });

  it('非法 at 报参数不合法', async () => {
    const chat = new Chat(
      {
        selfId: must(UserId('1')),
        groupId: must(GroupId('100')),
      },
      {
        async send() {
          return must(MessageId(1));
        },
        async message() {
          return undefined;
        },
        async info() {
          return undefined;
        },
        async avatar() {
          return undefined;
        },
        watch() {
          return () => {};
        },
        dispose() {},
      },
    );
    const sendMessage = tools(
      chat,
      new AbortController().signal,
      {
        at: true,
        reply: true,
      },
      quiet,
    ).find(tool => tool.name === 'sendMessage');
    if (sendMessage === undefined) {
      throw new Error('没有 sendMessage');
    }
    await expect(
      sendMessage.execute('', {
        segments: [{ type: 'at', userId: '0' }],
      }),
    ).rejects.toThrow(toolError.invalid);
  });
});
