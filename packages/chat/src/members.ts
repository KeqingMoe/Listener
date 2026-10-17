import type { Client } from './client';
import type { ChatEvent } from './event';
import type { GroupId, UserId } from './id';

export type Role = 'owner' | 'admin';

export type MemberInfo = {
  nickname: string;
  card: string;
  role: Role | 'member';
  title: string;
};

export type Avatar = {
  data: string;
  mimeType: string;
};

export type Card = {
  userId: UserId;
  name: string;
  role?: Role;
  title?: string;
  avatar?: Avatar;
};

/** 一个事件里露过脸的人：说话的，和被 @ 的。 */
export function faces(event: ChatEvent): UserId[] {
  switch (event.type) {
    case 'message.created': {
      const ids = [event.userId];
      for (const segment of event.segments) {
        if (typeof segment !== 'string' && segment.type === 'at') {
          ids.push(segment.userId);
        }
      }
      return ids;
    }
  }
}

/**
 * 谁是谁。给模型看过的生面孔才去查，查到就介绍，一个人只介绍一次。
 *
 * `#cards` 的键在 = 在管，值是 `undefined` = 还在查。
 *
 * | # | 名字        | `#cards`    | `#wanted` | `#introduced` |
 * |---|-------------|-------------|-----------|---------------|
 * | 1 | 陌生        | —           | —         | —             |
 * | 2 | 在查·预热   | `undefined` | —         | —             |
 * | 3 | 在查·要看   | `undefined` | ✓         | —             |
 * | 4 | 有卡·没人看 | `Card`      | —         | —             |
 * | 5 | 有卡·待发   | `Card`      | ✓         | —             |
 * | 6 | 待发·没卡   | —           | ✓         | —             |
 * | 7 | 介绍完了    | —           | —         | ✓             |
 *
 * 转移：
 *
 * - `see`：1→2
 * - `want`：1→3、2→3、4→5、6→3
 * - 查到：2→4、3→5
 * - 查不到：2→1、3→6（删键）
 * - `take`：5→7（发出）、6→1（清掉）
 *
 * 6 是过渡态：拉取失败留下的空壳，到下一次 `take` 被清掉；期间再被 `want`/`see`
 * 见到就回到 3 重查。7 是终点，所有入口第一句都先看 `#introduced`。
 */
export class Members {
  /** 查到了、还没介绍的名片；还在查的 undefined 占个位。 */
  #cards = new Map<UserId, Card | undefined>();
  /** 想要介绍的人。 */
  #wanted = new Set<UserId>();
  /** 已经介绍过的。 */
  #introduced = new Set<UserId>();

  constructor(
    private readonly groupId: GroupId,
    private readonly client: Client,
  ) {}

  see(users: UserId[]): void {
    for (const userId of users) {
      this.#look(userId);
    }
  }

  want(users: UserId[]): void {
    for (const userId of users) {
      if (this.#introduced.has(userId)) {
        continue;
      }
      this.#wanted.add(userId);
      this.#look(userId);
    }
  }

  take(): Card[] {
    const cards: Card[] = [];
    for (const userId of this.#wanted) {
      const card = this.#cards.get(userId);
      if (card === undefined) {
        if (!this.#cards.has(userId)) {
          this.#wanted.delete(userId);
        }
        continue;
      }
      this.#cards.delete(userId);
      this.#wanted.delete(userId);
      this.#introduced.add(userId);
      cards.push(card);
    }
    return cards;
  }

  #look(userId: UserId): void {
    if (this.#introduced.has(userId) || this.#cards.has(userId)) {
      return;
    }
    this.#cards.set(userId, undefined);
    void this.#pull(userId);
  }

  async #pull(userId: UserId): Promise<void> {
    const card = await this.#card(userId).catch(() => undefined);
    if (card === undefined) {
      this.#cards.delete(userId);
      return;
    }
    this.#cards.set(userId, card);
  }

  async #card(userId: UserId): Promise<Card | undefined> {
    const [info, avatar] = await Promise.all([
      this.client.info(this.groupId, userId),
      this.client.avatar(userId, 160),
    ]);
    if (info === undefined) {
      return;
    }
    return {
      userId,
      name: info.card || info.nickname,
      role: info.role === 'member' ? undefined : info.role,
      title: info.title === '' ? undefined : info.title,
      avatar,
    };
  }
}
