import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import {
  Chat,
  type Client,
  GroupId,
  MessageId,
  UnixTime,
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

function client(): Client {
  return {
    async send() {
      return must(MessageId(1));
    },
    async message() {
      return undefined;
    },
    watch() {
      return () => {};
    },
    dispose() {},
  };
}

function chat() {
  return new Chat(
    {
      selfId: must(UserId('1')),
      groupId: must(GroupId('100')),
    },
    client(),
  );
}

describe('runLoop', () => {
  it('启动投窗口，没工具也继续直到 abort', async () => {
    const c = chat();
    await c.append({
      type: 'message.created',
      msgId: must(MessageId(10)),
      timestamp: must(UnixTime(1)),
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
        ? seen[0].events.map(event =>
            event.type === 'message.created' ? event.msgId : undefined,
          )
        : [],
    ).toEqual([10]);
  });

  it('工具回合把未读再投进去', async () => {
    const c = chat();
    await c.append({
      type: 'message.created',
      msgId: must(MessageId(10)),
      timestamp: must(UnixTime(1)),
      userId: must(UserId('2')),
      segments: ['a'],
    });
    const extra = {
      type: 'message.created' as const,
      msgId: must(MessageId(11)),
      timestamp: must(UnixTime(1)),
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
      events: [extra],
    });
  });

  it('中途投递也过窗口，多的变成缺口', async () => {
    const c = chat();
    await c.append({
      type: 'message.created',
      msgId: must(MessageId(10)),
      timestamp: must(UnixTime(1)),
      userId: must(UserId('2')),
      segments: ['a'],
    });
    const burst = [11, 12, 13].map(msgId => ({
      type: 'message.created' as const,
      msgId: must(MessageId(msgId)),
      timestamp: must(UnixTime(1)),
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
      events: [
        { type: 'gap', skipped: 1 },
        { type: 'message.created', msgId: 12 },
        { type: 'message.created', msgId: 13 },
      ],
    });
  });
});
