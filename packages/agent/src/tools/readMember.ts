import type { AgentTool } from '@earendil-works/pi-agent-core';
import { type Chat, UserId } from '@listener/chat';
import type { Logger } from 'pino';
import { Type } from 'typebox';
import { toolError } from './error';

const readMemberParameters = Type.Object({
  userId: Type.String(),
});

/** QQ 等级：皇冠 64、太阳 16、月亮 4、星星 1。 */
const marks: readonly (readonly [number, string])[] = [
  [64, '👑'],
  [16, '☀️'],
  [4, '🌙'],
  [1, '⭐'],
];

function mark(level: number): string {
  let rest = level;
  let out = '';
  for (const [size, sign] of marks) {
    out += sign.repeat(Math.trunc(rest / size));
    rest %= size;
  }
  return out;
}

export function readMember(
  chat: Chat,
  parent: Logger,
): AgentTool<typeof readMemberParameters> {
  return {
    name: 'readMember',
    label: '看主页',
    description: [
      '看一个人的主页资料：大头像、昵称、群名片、性别年龄地区、',
      '群等级、QQ 等级、入群时间、最后发言时间、是不是 Bot。',
    ].join(''),
    parameters: readMemberParameters,
    async execute(toolCallId, params) {
      const log = parent.child({ tool: 'readMember', toolCallId });
      const userId = UserId(params.userId);
      if (userId === undefined) {
        throw new Error(toolError.invalid);
      }
      const member = await chat.members.profile(userId);
      if (member === undefined) {
        log.info({ userId, found: false });
        return {
          content: [{ type: 'text' as const, text: 'null' }],
          details: undefined,
        };
      }
      const { info, avatar } = member;
      const profile = { userId, ...info, qqLevel: mark(info.qqLevel) };
      log.info({
        profile,
        avatar:
          avatar === undefined
            ? undefined
            : {
                mimeType: avatar.mimeType,
                bytes: Buffer.byteLength(avatar.data, 'base64'),
              },
      });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(profile) },
          ...(avatar !== undefined
            ? [{ type: 'image' as const, ...avatar }]
            : []),
        ],
        details: undefined,
      };
    },
  };
}
