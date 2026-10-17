import { Chat, GroupId, MessageId, Time, UserId } from '@listener/chat';
import type { Logger } from 'pino';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { wait } from '@/tools/wait';

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('夹具无效');
  }
  return value;
}

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

describe('wait', () => {
  it('已有未读立刻 event', async () => {
    const c = chat();
    await c.append(plain(10));
    const { log, seen } = recorder();
    await wait(c, new AbortController().signal, log).execute('', {
      ms: 60_000,
    });
    expect(seen[0]).toMatchObject({ tool: 'wait', reason: 'event' });
    expect(c.unread).toBe(1);
  });

  it('没被提及的新消息也打断', async () => {
    const c = chat();
    const { log, seen } = recorder();
    const pending = wait(c, new AbortController().signal, log).execute('', {
      ms: 60_000,
    });
    await c.append(plain(10));
    await pending;
    expect(seen[0]).toMatchObject({ tool: 'wait', reason: 'event' });
  });

  it('没有动静，到期 timeout', async () => {
    const c = chat();
    const { log, seen } = recorder();
    await wait(c, new AbortController().signal, log).execute('', { ms: 0 });
    expect(seen[0]).toMatchObject({ tool: 'wait', reason: 'timeout' });
  });

  it('abort 打断', async () => {
    const c = chat();
    const abort = new AbortController();
    const { log, seen } = recorder();
    const pending = wait(c, abort.signal, log).execute('', { ms: 60_000 });
    abort.abort();
    await pending;
    expect(seen[0]).toMatchObject({ tool: 'wait', reason: 'abort' });
  });
});
