import { describe, expect, it } from 'vitest';
import type { Client } from '@/client';
import type { MessageCreated, Segment } from '@/event';
import { GroupId, MessageId, Time, UserId } from '@/id';
import { type Avatar, faces, type MemberInfo, Members } from '@/members';

function must<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error('夹具无效');
  }
  return value;
}

const group = must(GroupId('100'));

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function client(
  info: (userId: string) => MemberInfo | undefined = userId => ({
    nickname: `昵称${userId}`,
    card: `群名片${userId}`,
    role: 'member',
    title: '',
  }),
  avatar: (userId: string) => Avatar | undefined = () => ({
    data: 'AA==',
    mimeType: 'image/jpeg',
  }),
): { client: Client; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    client: {
      async send() {
        return must(MessageId(1));
      },
      async info(_groupId, userId) {
        asked.push(userId);
        return info(userId);
      },
      async avatar(userId) {
        return avatar(userId);
      },
      async message() {
        return undefined;
      },
      watch() {
        return () => {};
      },
      dispose() {},
    },
  };
}

let next = 1;

function message(userId: string, segments: Segment[] = ['hi']): MessageCreated {
  next += 1;
  return {
    type: 'message.created',
    msgId: must(MessageId(next)),
    time: must(Time(1000)),
    userId: must(UserId(userId)),
    segments,
  };
}

describe('Members', () => {
  const 张 = must(UserId('2'));
  const 李 = must(UserId('3'));

  it('消息一到就去查', () => {
    const { client: from, asked } = client();
    const members = new Members(group, from);

    members.see([张]);

    expect(asked).toEqual(['2']);
  });

  it('看过的人才会发', async () => {
    const members = new Members(group, client().client);

    members.see([张, 李]);
    await flush();

    expect(members.take()).toEqual([]);

    members.want([李]);
    expect(members.take().map(card => card.userId)).toEqual(['3']);
  });

  it('名片没到手就等下次', async () => {
    const members = new Members(group, client().client);

    members.want([张]);
    expect(members.take()).toEqual([]);
    await flush();

    expect(members.take().map(card => card.userId)).toEqual(['2']);
  });

  it('介绍过就不再查，也不再发', async () => {
    const { client: from, asked } = client();
    const members = new Members(group, from);

    members.want([张]);
    await flush();
    expect(members.take().map(card => card.userId)).toEqual(['2']);

    members.want([张]);
    await flush();

    expect(members.take()).toEqual([]);
    expect(asked).toEqual(['2']);
  });

  it('普通群员不写 role 和 title', async () => {
    const members = new Members(group, client().client);

    members.want([张]);
    await flush();

    const [card] = members.take();
    expect(card).toMatchObject({ userId: 张, name: '群名片2' });
    expect(card?.role).toBeUndefined();
    expect(card?.title).toBeUndefined();
  });

  it('身份和头衔才写进去', async () => {
    const members = new Members(
      group,
      client(() => ({
        nickname: '老张',
        card: '',
        role: 'admin',
        title: '卷王',
      })).client,
    );

    members.want([张]);
    await flush();

    expect(members.take()).toEqual([
      {
        userId: 张,
        name: '老张',
        role: 'admin',
        title: '卷王',
        avatar: { data: 'AA==', mimeType: 'image/jpeg' },
      },
    ]);
  });

  it('查不到人就不发名片', async () => {
    const members = new Members(group, client(() => undefined).client);

    members.want([张]);
    await flush();

    expect(members.take()).toEqual([]);
  });

  it('拉取炸了也不卡住，下次露脸重查', async () => {
    let broken = true;
    const { client: from, asked } = client(() => {
      if (broken) {
        throw new Error('炸了');
      }
      return { nickname: '阿三', card: '', role: 'member', title: '' };
    });
    const members = new Members(group, from);

    members.want([张]);
    await flush();
    expect(members.take()).toEqual([]);

    broken = false;
    members.want([张]);
    await flush();

    expect(members.take().map(card => card.userId)).toEqual(['2']);
    expect(asked).toEqual(['2', '2']);
  });
});

describe('faces', () => {
  it('说话的和被 @ 的都算', () => {
    const event = message('2', [{ type: 'at', userId: must(UserId('3')) }]);

    expect(faces(event)).toEqual(['2', '3']);
  });
});
