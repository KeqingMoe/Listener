import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type ModelThinkingLevel,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import {
  type Avatar,
  Chat,
  type Client,
  GroupId,
  type MemberInfo,
  MessageId,
  Time,
  UserId,
} from '@listener/chat';
import { describe, expect, it, vi } from 'vitest';
import { type LoopEvent, runLoop } from '@/loop';

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('夹具无效');
  }
  return value;
}

function member(overrides: Partial<MemberInfo> = {}): MemberInfo {
  return {
    nickname: '昵称',
    sex: 'unknown',
    age: 0,
    area: '',
    level: '0',
    qqLevel: 0,
    joinTime: must(Time(1)),
    ...overrides,
  };
}

function client(
  info: (userId: string) => MemberInfo | undefined = () => undefined,
  avatar: (userId: string) => Avatar | undefined = () => undefined,
): Client {
  return {
    async send() {
      return must(MessageId(1));
    },
    async message() {
      return undefined;
    },
    async info(_groupId, userId) {
      return info(userId);
    },
    async avatar(userId) {
      return avatar(userId);
    },
    watch() {
      return () => {};
    },
    dispose() {},
  };
}

function chat(from: Client = client()) {
  return new Chat(
    {
      selfId: must(UserId('1')),
      groupId: must(GroupId('100')),
    },
    from,
  );
}

describe('runLoop', () => {
  it('启动投窗口，没工具也继续直到 abort', async () => {
    const c = chat();
    await c.append({
      type: 'message.created',
      msgId: must(MessageId(10)),
      time: must(Time(1000)),
      userId: must(UserId('2')),
      segments: ['a'],
    });
    const abort = new AbortController();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage(''),
      fauxAssistantMessage(''),
      fauxAssistantMessage(''),
    ]);
    const seen: LoopEvent[] = [];
    const running = runLoop(
      c,
      10,
      {
        model: faux.getModel(),
        streamFn: models.streamSimple.bind(models),
        signal: abort.signal,
        mentioned: { at: true, reply: true },
      },
      event => {
        seen.push(event);
      },
    );
    await vi.waitFor(() => {
      expect(seen.some(event => event.type === 'assistant')).toBe(true);
    });
    abort.abort();
    await running;
    expect(seen[0]).toMatchObject({ type: 'feed', via: 'start' });
    expect(
      seen[0] && seen[0].type === 'feed'
        ? seen[0].payload.events.map(event =>
            event.type === 'message.created' ? event.msgId : undefined,
          )
        : [],
    ).toEqual([10]);
  });

  it('投递时带上名片，不带头像字节', async () => {
    const c = chat(
      client(
        userId =>
          userId === '2'
            ? member({
                nickname: 'nick',
                card: '老张',
                role: 'owner',
                title: '卷王',
              })
            : undefined,
        () => ({ data: 'AA==', mimeType: 'image/jpeg' }),
      ),
    );
    await c.append({
      type: 'message.created',
      msgId: must(MessageId(10)),
      time: must(Time(1000)),
      userId: must(UserId('2')),
      segments: ['a'],
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    const abort = new AbortController();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('sendMessage', { segments: ['x'] })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage(''),
      fauxAssistantMessage(''),
    ]);
    const seen: LoopEvent[] = [];
    const texts: string[] = [];
    const images: string[] = [];
    const running = runLoop(
      c,
      10,
      {
        model: faux.getModel(),
        streamFn: async (model, context, options) => {
          for (const message of context.messages) {
            if (
              message.role !== 'user' ||
              typeof message.content === 'string'
            ) {
              continue;
            }
            for (const part of message.content) {
              if (part.type === 'text') {
                texts.push(part.text);
              }
              if (part.type === 'image') {
                images.push(part.mimeType);
              }
            }
          }
          return models.streamSimple(model, context, options);
        },
        signal: abort.signal,
        mentioned: { at: true, reply: true },
      },
      event => {
        seen.push(event);
      },
    );
    await vi.waitFor(() => {
      expect(
        seen.some(event => event.type === 'feed' && event.via === 'turn'),
      ).toBe(true);
    });
    abort.abort();
    await running;

    const feeds = seen.filter(event => event.type === 'feed');
    expect(feeds[0]).toMatchObject({
      via: 'start',
      members: [
        {
          userId: '2',
          name: '老张',
          role: 'owner',
          title: '卷王',
          avatar: true,
        },
      ],
    });
    expect(feeds[1]).toMatchObject({ via: 'turn', members: [] });
    expect(texts).toContain(
      '{"userId":"2","name":"老张","role":"owner","title":"卷王"}',
    );
    expect(new Set(images)).toEqual(new Set(['image/jpeg']));
  });

  it('工具回合把未读再投进去', async () => {
    const c = chat();
    await c.append({
      type: 'message.created',
      msgId: must(MessageId(10)),
      time: must(Time(1000)),
      userId: must(UserId('2')),
      segments: ['a'],
    });
    const extra = {
      type: 'message.created' as const,
      msgId: must(MessageId(11)),
      time: must(Time(1000)),
      userId: must(UserId('2')),
      segments: ['during'],
    };
    const abort = new AbortController();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const inner = models.streamSimple.bind(models);
    let calls = 0;
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('sendMessage', {
            segments: ['x'],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(''),
      fauxAssistantMessage(''),
    ]);
    const seen: LoopEvent[] = [];
    const running = runLoop(
      c,
      10,
      {
        model: faux.getModel(),
        streamFn: async (model, context, options) => {
          calls += 1;
          if (calls === 1) {
            await c.append(extra);
          }
          return inner(model, context, options);
        },
        signal: abort.signal,
        mentioned: { at: true, reply: true },
      },
      event => {
        seen.push(event);
      },
    );
    await vi.waitFor(() => {
      expect(
        seen.some(event => event.type === 'feed' && event.via === 'turn'),
      ).toBe(true);
    });
    abort.abort();
    await running;
    expect(seen.map(event => event.type).slice(0, 4)).toEqual([
      'feed',
      'assistant',
      'tool',
      'feed',
    ]);
    expect(seen[3]).toMatchObject({
      type: 'feed',
      via: 'turn',
      payload: { events: [extra] },
    });
  });

  it('中途投递也过窗口，多的变成缺口', async () => {
    const c = chat();
    await c.append({
      type: 'message.created',
      msgId: must(MessageId(10)),
      time: must(Time(1000)),
      userId: must(UserId('2')),
      segments: ['a'],
    });
    const burst = [11, 12, 13].map(msgId => ({
      type: 'message.created' as const,
      msgId: must(MessageId(msgId)),
      time: must(Time(1000)),
      userId: must(UserId('2')),
      segments: ['during'],
    }));
    const abort = new AbortController();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const inner = models.streamSimple.bind(models);
    let calls = 0;
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('sendMessage', {
            segments: ['x'],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(''),
      fauxAssistantMessage(''),
    ]);
    const seen: LoopEvent[] = [];
    const running = runLoop(
      c,
      2,
      {
        model: faux.getModel(),
        streamFn: async (model, context, options) => {
          calls += 1;
          if (calls === 1) {
            for (const one of burst) {
              await c.append(one);
            }
          }
          return inner(model, context, options);
        },
        signal: abort.signal,
        mentioned: { at: true, reply: true },
      },
      event => {
        seen.push(event);
      },
    );
    await vi.waitFor(() => {
      expect(
        seen.some(event => event.type === 'feed' && event.via === 'turn'),
      ).toBe(true);
    });
    abort.abort();
    await running;
    expect(seen[3]).toMatchObject({
      type: 'feed',
      via: 'turn',
      payload: {
        events: [
          { type: 'gap', skipped: 1 },
          { type: 'message.created', msgId: 12 },
          { type: 'message.created', msgId: 13 },
        ],
      },
    });
  });

  it('开跑前先把自己的名片挂上', async () => {
    const c = chat(
      client(userId =>
        userId === '1'
          ? member({ nickname: '小二', role: 'owner' })
          : undefined,
      ),
    );
    await new Promise(resolve => setTimeout(resolve, 0));
    const abort = new AbortController();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage(''), fauxAssistantMessage('')]);
    const seen: LoopEvent[] = [];
    const running = runLoop(
      c,
      10,
      {
        model: faux.getModel(),
        streamFn: models.streamSimple.bind(models),
        signal: abort.signal,
        mentioned: { at: true, reply: true },
      },
      event => {
        seen.push(event);
      },
    );
    await vi.waitFor(() => {
      expect(seen.some(event => event.type === 'feed')).toBe(true);
    });
    abort.abort();
    await running;

    const feed = must(seen.find(event => event.type === 'feed'));
    expect(feed.members).toMatchObject([
      { userId: '1', name: '小二', role: 'owner' },
    ]);
    expect(JSON.stringify(feed.members)).not.toContain('title');
  });

  it('空批次也投信封，带上现在时间', async () => {
    const c = chat();
    const abort = new AbortController();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const inner = models.streamSimple.bind(models);
    faux.setResponses([
      fauxAssistantMessage(''),
      fauxAssistantMessage(''),
      fauxAssistantMessage(''),
    ]);
    const users: number[] = [];
    const contents: string[] = [];
    const running = runLoop(c, 10, {
      model: faux.getModel(),
      streamFn: async (model, context, options) => {
        const mine = context.messages.filter(
          message => message.role === 'user',
        );
        users.push(mine.length);
        contents.push(String(mine[mine.length - 1]?.content));
        return inner(model, context, options);
      },
      signal: abort.signal,
      mentioned: { at: true, reply: true },
    });
    await vi.waitFor(() => {
      expect(users.length).toBeGreaterThan(1);
    });
    abort.abort();
    await running;
    expect(users[1]).toBe(2);
    expect(JSON.parse(contents[1] ?? '')).toMatchObject({
      events: [],
      now: expect.stringMatching(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/),
    });
  });

  async function levelsFor(thinking?: ModelThinkingLevel) {
    const c = chat();
    await c.append({
      type: 'message.created',
      msgId: must(MessageId(10)),
      time: must(Time(1000)),
      userId: must(UserId('2')),
      segments: ['a'],
    });
    const abort = new AbortController();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const levels: unknown[] = [];
    const step = (
      _context: unknown,
      options: SimpleStreamOptions | undefined,
    ) => {
      levels.push(options?.reasoning);
      return fauxAssistantMessage('');
    };
    faux.setResponses([step, step, step]);
    const running = runLoop(c, 10, {
      model: faux.getModel(),
      streamFn: models.streamSimple.bind(models),
      signal: abort.signal,
      mentioned: { at: true, reply: true },
      thinking,
    });
    await vi.waitFor(() => {
      expect(levels.length).toBeGreaterThan(0);
    });
    abort.abort();
    await running;
    return levels;
  }

  it('thinking 进请求的 reasoning，off 与不写都不带', async () => {
    expect((await levelsFor('high'))[0]).toBe('high');
    expect((await levelsFor('off'))[0]).toBeUndefined();
    expect((await levelsFor())[0]).toBeUndefined();
  });
});
