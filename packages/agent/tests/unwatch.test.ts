import { Chat, GroupId, MessageId, Time, UserId } from '@listener/chat';
import { describe, expect, it } from 'vitest';
import { unwatch } from '@/tools/unwatch';

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('夹具无效');
  }
  return value;
}

function chat() {
  return new Chat(
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
}

function plain(msgId: number) {
  return {
    type: 'message.created' as const,
    msgId: must(MessageId(msgId)),
    time: must(Time(1000)),
    userId: must(UserId('2')),
    segments: ['a'],
  };
}

function mention(msgId: number) {
  return {
    type: 'message.created' as const,
    msgId: must(MessageId(msgId)),
    time: must(Time(1000)),
    userId: must(UserId('2')),
    segments: [{ type: 'at' as const, userId: must(UserId('1')) }],
  };
}

describe('unwatch', () => {
  it('未读被提及立刻 event', async () => {
    const c = chat();
    await c.append(mention(10));
    const tool = unwatch(c, new AbortController().signal, {
      at: true,
      reply: true,
    });
    const result = await tool.execute('', { ms: 60_000 });
    expect(result.details).toEqual({ reason: 'event' });
    expect(c.unread).toBe(1);
  });

  it('未读未被提及不打断', async () => {
    const c = chat();
    await c.append(plain(10));
    const tool = unwatch(c, new AbortController().signal, {
      at: true,
      reply: true,
    });
    const result = await tool.execute('', { ms: 0 });
    expect(result.details).toEqual({ reason: 'timeout' });
    expect(c.unread).toBe(1);
  });

  it('新事件被提及打断', async () => {
    const c = chat();
    const tool = unwatch(c, new AbortController().signal, {
      at: true,
      reply: true,
    });
    const pending = tool.execute('', { ms: 60_000 });
    await c.append(plain(10));
    await c.append(mention(11));
    expect((await pending).details).toEqual({ reason: 'event' });
  });

  it('关掉 at 后提及不打断', async () => {
    const c = chat();
    await c.append(mention(10));
    const tool = unwatch(c, new AbortController().signal, {
      at: false,
      reply: true,
    });
    const result = await tool.execute('', { ms: 0 });
    expect(result.details).toEqual({ reason: 'timeout' });
  });

  it('abort 打断', async () => {
    const c = chat();
    const abort = new AbortController();
    const tool = unwatch(c, abort.signal, { at: true, reply: true });
    const pending = tool.execute('', { ms: 60_000 });
    abort.abort();
    expect((await pending).details).toEqual({ reason: 'abort' });
  });
});
