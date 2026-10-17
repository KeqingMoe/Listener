import type { ChatEvent, MessageCreated, Send } from './event';
import type { GroupId, MessageId, UserId } from './id';
import type { Avatar, MemberInfo } from './members';

export type Append = (event: ChatEvent) => Promise<void>;

export type Client = {
  send(groupId: GroupId, message: Send): Promise<MessageId>;
  info(groupId: GroupId, userId: UserId): Promise<MemberInfo | undefined>;
  avatar(userId: UserId, size: number): Promise<Avatar | undefined>;
  message(msgId: MessageId): Promise<MessageCreated | undefined>;
  watch(groupId: GroupId, append: Append): () => void;
  dispose(): void;
};
