import { describe, expect, it } from 'vitest';
import { GroupId, MessageId } from '@/id';
import { napcat } from '@/napcat';

type Ws = Parameters<typeof napcat>[0];

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('夹具无效');
  }
  return value;
}

function ws(send: () => Promise<unknown>): Ws {
  return {
    subscribe() {
      return () => {};
    },
    send,
  } as unknown as Ws;
}

const group = must(GroupId('100'));
const payload = { segments: ['a'] };

describe('napcat', () => {
  it('回执整条进 message，原件留在 cause', async () => {
    const envelope = {
      status: 'failed',
      retcode: 1200,
      data: null,
      message: '发送失败',
      wording: '你已被禁言',
      echo: 'x',
    };
    const client = napcat(
      ws(async () => {
        throw envelope;
      }),
    );
    const error = await client
      .send(group, payload)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(JSON.stringify(envelope));
    expect((error as Error).cause).toBe(envelope);
  });

  it('Error 原样抛出', async () => {
    const thrown = new Error('网络断了');
    const client = napcat(
      ws(async () => {
        throw thrown;
      }),
    );
    await expect(client.send(group, payload)).rejects.toBe(thrown);
  });

  it('取消息失败也整条进 message', async () => {
    const client = napcat(
      ws(async () => {
        throw {
          status: 'failed',
          retcode: 1404,
          data: null,
          message: '消息不存在',
          wording: '',
          echo: 'x',
        };
      }),
    );
    await expect(client.message(must(MessageId(1)))).rejects.toThrow(
      '消息不存在',
    );
  });
});
