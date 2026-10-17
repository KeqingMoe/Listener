import { Chat, GroupId, MessageId, Time, UserId } from '@listener/chat';
import { describe, expect, it } from 'vitest';
import { wait } from '@/tools/wait';

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

describe('wait', () => {
  it('已有未读立刻 event', async () => {
    const c = chat();
    await c.append(plain(10));
    const tool = wait(c, new AbortController().signal);
    const result = await tool.execute('', { ms: 60_000 });
    expect(result.details).toEqual({ reason: 'event' });
    expect(c.unread).toBe(1);
  });

  it('没被提及的新消息也打断', async () => {
    const c = chat();
    const tool = wait(c, new AbortController().signal);
    const pending = tool.execute('', { ms: 60_000 });
    await c.append(plain(10));
    expect((await pending).details).toEqual({ reason: 'event' });
  });

  it('没有动静，到期 timeout', async () => {
    const c = chat();
    const tool = wait(c, new AbortController().signal);
    const result = await tool.execute('', { ms: 0 });
    expect(result.details).toEqual({ reason: 'timeout' });
  });

  it('abort 打断', async () => {
    const c = chat();
    const abort = new AbortController();
    const tool = wait(c, abort.signal);
    const pending = tool.execute('', { ms: 60_000 });
    abort.abort();
    expect((await pending).details).toEqual({ reason: 'abort' });
  });
});
