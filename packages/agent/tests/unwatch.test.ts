import { Chat, GroupId, MessageId, Time, UserId } from '@listener/chat';
import type { Logger } from 'pino';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { unwatch } from '@/tools/unwatch';

function recorder(): { log: Logger; seen: Record<string, unknown>[] } {
  const seen: Record<string, unknown>[] = [];
  const log = pino(
    { level: 'info' },
    {
      write: (line: string) => {
        seen.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  return { log, seen };
}

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
    const { log, seen } = recorder();
    const tool = unwatch(
      c,
      new AbortController().signal,
      { at: true, reply: true },
      log,
    );
    await tool.execute('', { ms: 60_000 });
    expect(seen[0]).toMatchObject({ tool: 'unwatch', reason: 'event' });
    expect(c.unread).toBe(1);
  });

  it('未读未被提及不打断', async () => {
    const c = chat();
    await c.append(plain(10));
    const { log, seen } = recorder();
    const tool = unwatch(
      c,
      new AbortController().signal,
      { at: true, reply: true },
      log,
    );
    await tool.execute('', { ms: 0 });
    expect(seen[0]).toMatchObject({ tool: 'unwatch', reason: 'timeout' });
    expect(c.unread).toBe(1);
  });

  it('新事件被提及打断', async () => {
    const c = chat();
    const { log, seen } = recorder();
    const tool = unwatch(
      c,
      new AbortController().signal,
      { at: true, reply: true },
      log,
    );
    const pending = tool.execute('', { ms: 60_000 });
    await c.append(plain(10));
    await c.append(mention(11));
    await pending;
    expect(seen[0]).toMatchObject({ tool: 'unwatch', reason: 'event' });
  });

  it('关掉 at 后提及不打断', async () => {
    const c = chat();
    await c.append(mention(10));
    const { log, seen } = recorder();
    const tool = unwatch(
      c,
      new AbortController().signal,
      { at: false, reply: true },
      log,
    );
    await tool.execute('', { ms: 0 });
    expect(seen[0]).toMatchObject({ tool: 'unwatch', reason: 'timeout' });
  });

  it('abort 打断', async () => {
    const c = chat();
    const abort = new AbortController();
    const { log, seen } = recorder();
    const tool = unwatch(c, abort.signal, { at: true, reply: true }, log);
    const pending = tool.execute('', { ms: 60_000 });
    abort.abort();
    await pending;
    expect(seen[0]).toMatchObject({ tool: 'unwatch', reason: 'abort' });
  });
});
