import { canonicalMessageId } from '../onebot/identity.ts';
import { resolveGroupId } from '../contracts/identity.ts';
import { type Api } from '../contracts/onebot.ts';
import { type JsonObject } from '../contracts/json.ts';
import { type Memory } from '../contracts/messages.ts';
import {
  getReactionCatalog,
  type ReactionEntry,
} from '../onebot/catalog/reactions.ts';

const CAPACITY = 512,
  ITEM_LIMIT = 8,
  SCAN_LIMIT = 128,
  FRESH_MS = 15_000,
  FAILURE_MS = 5_000,
  DEADLINE_MS = 1_500;

interface Snapshot {
  message_id: string;
  status: 'observed' | 'partial' | 'empty_snapshot';
  observed_at: number;
  items: JsonObject[];
  omitted?: number;
}

interface Cached {
  revision: number;
  touched: number;
  dirty: boolean;
  retryAfter: number;
  snapshot?: Snapshot;
}

interface Pending {
  promise: Promise<void>;
}

interface Proof {
  sender?: string;
}

function object(value: unknown): value is JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  try {
    return (
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Reflect.ownKeys(value).every(
        (key) =>
          typeof key === 'string' &&
          Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'),
      )
    );
  } catch {
    return false;
  }
}

function unsigned(value: unknown): string | undefined {
  const id = canonicalMessageId(value);
  return id !== undefined && !id.startsWith('-') ? id : undefined;
}

function identity(value: unknown): string | undefined {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  }
  return typeof value === 'string' &&
    value.length <= 32 &&
    value.trim() === value &&
    /^[1-9][0-9]*$/.test(value)
    ? value
    : undefined;
}

function proof(
  memory: Memory,
  id: string,
  quoted?: ReadonlySet<string>,
): Proof | undefined {
  try {
    const local = memory.find(id);
    if (local !== undefined) {
      if (
        !object(local) ||
        local.messageId !== id ||
        typeof local.userId !== 'string' ||
        identity(local.userId) !== local.userId
      ) {
        return undefined;
      }
      return { sender: local.userId };
    }
    if (
      quoted
        ? quoted.has(id)
        : memory
            .recent()
            .some(
              (entry) =>
                object(entry) &&
                canonicalMessageId(entry.messageId) === entry.messageId &&
                identity(entry.userId) &&
                entry.replyTo === id,
            )
    ) {
      return {};
    }
  } catch {
    /* 损坏或外来的来源信息不构成证据。 */
  }
  return undefined;
}

function verified(
  raw: unknown,
  id: string,
  groupId: string,
  origin: Proof,
): raw is JsonObject {
  if (
    !object(raw) ||
    raw.message_type !== 'group' ||
    identity(raw.group_id) !== groupId ||
    canonicalMessageId(raw.message_id) !== id ||
    !object(raw.sender)
  ) {
    return false;
  }
  const sender = identity(raw.sender.user_id);
  return (
    sender !== undefined &&
    (origin.sender === undefined || origin.sender === sender) &&
    (!Object.hasOwn(raw, 'user_id') || identity(raw.user_id) === sender)
  );
}

let catalog: ReadonlyMap<string, ReactionEntry> | undefined;

function label(
  id: string,
  type: string,
): Pick<ReactionEntry, 'name' | 'emoji'> | undefined {
  try {
    catalog ??= new Map(getReactionCatalog().map((entry) => [entry.id, entry]));
  } catch {
    return undefined;
  }
  const entry = catalog.get(id);
  if (
    !entry ||
    !(
      (type === '1' && entry.kind === 'face') ||
      (type === '2' && entry.kind === 'emoji')
    )
  ) {
    return undefined;
  }
  return { name: entry.name, ...(entry.emoji ? { emoji: entry.emoji } : {}) };
}

/**
 * 观察QQ上报的回应计数，不代表去重后的人数、本账号是否参与，也不能保证没有回应。
 * SDK返回的空列表只算empty_snapshot：底层SDK没给聚合字段时，GetMsg同样会初始化出空列表。
 */
export class ReactionObservations {
  private readonly groupId: string;
  private readonly retentionMs: number;
  private readonly cache = new Map<string, Cached>();
  // 这些真实RPC的占用记录刻意在clear()和refresh超时后仍然保留，确保并发上限覆盖仍在途的请求。
  private readonly pending = new Map<string, Pending>();
  private serial = 0;
  private generation = 0;
  private refreshEpoch = 0;
  private active?: { promise: Promise<void>; controller: AbortController };
  constructor(
    private readonly api: Api,
    groupId: string,
    retentionDays: number,
  ) {
    this.groupId = resolveGroupId(groupId);
    if (
      !Number.isFinite(retentionDays) ||
      retentionDays <= 0 ||
      retentionDays > 30
    ) {
      throw new Error('Invalid reaction observation retention');
    }
    this.retentionMs = retentionDays * 86_400_000;
  }

  clear(): void {
    this.generation++;
    this.refreshEpoch++;
    this.cache.clear();
    this.active?.controller.abort();
    // 不重置serial：旧的ingest令牌绝不能匹配到新条目。
  }

  private prune(now = Date.now()): void {
    const cutoff = now - this.retentionMs;
    for (const [id, entry] of this.cache) {
      if (entry.touched < cutoff) {
        this.cache.delete(id);
        continue;
      }
      if (entry.snapshot && entry.snapshot.observed_at < cutoff) {
        entry.snapshot = undefined;
        entry.dirty = true;
        entry.revision = ++this.serial;
      }
    }
  }

  private entry(id: string): Cached {
    let entry = this.cache.get(id);
    if (!entry) {
      entry = {
        revision: ++this.serial,
        touched: Date.now(),
        dirty: false,
        retryAfter: 0,
      };
    }
    entry.touched = Date.now();
    this.cache.delete(id);
    this.cache.set(id, entry);
    while (this.cache.size > CAPACITY) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    return entry;
  }

  /**
   * 在异步get_msg之前立即获取；收到通知、被淘汰或重置后revision都会变化，
   * 因此旧响应不能刷新更新的证据。
   */
  revision(messageId: string): number {
    if (
      typeof messageId !== 'string' ||
      canonicalMessageId(messageId) !== messageId
    ) {
      return 0;
    }
    this.prune();
    return this.entry(messageId).revision;
  }

  markDirty(messageId: string): void {
    if (
      typeof messageId !== 'string' ||
      canonicalMessageId(messageId) !== messageId
    ) {
      return;
    }
    this.prune();
    const entry = this.entry(messageId);
    entry.dirty = true;
    entry.revision = ++this.serial;
  }

  notice(event: unknown, memory: Memory): boolean {
    if (
      !object(event) ||
      event.post_type !== 'notice' ||
      event.notice_type !== 'group_msg_emoji_like' ||
      identity(event.group_id) !== this.groupId
    ) {
      return false;
    }
    const id = canonicalMessageId(event.message_id);
    if (id === undefined || !proof(memory, id)) {
      return false;
    }
    // 通知本身只作为脏标记：不读取或增减likes.count，不信任is_add，
    // 不把缺失的user_id归为自己，也不在这里发起RPC或模型调用。
    this.markDirty(id);
    return true;
  }

  private matches(id: string, revision?: number): boolean {
    return (
      revision === undefined ||
      (Number.isSafeInteger(revision) &&
        revision > 0 &&
        this.cache.get(id)?.revision === revision)
    );
  }

  private failed(id: string, clearSnapshot: boolean): void {
    const entry = this.entry(id);
    if (clearSnapshot) {
      entry.snapshot = undefined;
    }
    entry.dirty = true;
    entry.retryAfter = Date.now() + FAILURE_MS;
    entry.revision = ++this.serial;
  }

  /**
   * 同步直接传入的快照可以省略revision令牌；异步调用方必须传入请求前获取的revision，
   * 并自行校验所属的generation。
   */
  ingest(
    messageId: string,
    raw: unknown,
    memory: Memory,
    expectedRevision?: number,
  ): void {
    if (
      typeof messageId !== 'string' ||
      canonicalMessageId(messageId) !== messageId
    ) {
      return;
    }
    this.prune();
    if (!this.matches(messageId, expectedRevision)) {
      return;
    }
    const origin = proof(memory, messageId);
    if (!origin || !verified(raw, messageId, this.groupId, origin)) {
      this.failed(messageId, true);
      return;
    }
    const list = raw.emoji_likes_list;
    if (!Array.isArray(list)) {
      this.failed(messageId, false);
      return;
    }
    const items: JsonObject[] = [],
      seen = new Set<string>();
    for (
      let i = 0;
      i < Math.min(list.length, SCAN_LIMIT) && items.length < ITEM_LIMIT;
      i++
    ) {
      const descriptor = Object.getOwnPropertyDescriptor(list, String(i));
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, 'value') ||
        !object(descriptor.value)
      ) {
        continue;
      }
      const row = descriptor.value;
      const id = unsigned(row.emoji_id),
        type = unsigned(row.emoji_type),
        count = unsigned(row.likes_cnt);
      if (id === undefined || type === undefined || count === undefined) {
        continue;
      }
      const key = `${type}:${id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      items.push({
        emoji_id: id,
        emoji_type: type,
        ...label(id, type),
        count: Number(count),
      });
    }
    const omitted = list.length - items.length;
    const snapshot: Snapshot = {
      message_id: messageId,
      observed_at: Date.now(),
      status:
        list.length === 0 ? 'empty_snapshot' : omitted ? 'partial' : 'observed',
      items,
      ...(omitted ? { omitted } : {}),
    };
    const entry = this.entry(messageId);
    entry.snapshot = snapshot;
    entry.dirty = false;
    entry.retryAfter = 0;
    entry.revision = ++this.serial;
  }

  get(messageId: string): JsonObject | undefined {
    if (
      typeof messageId !== 'string' ||
      canonicalMessageId(messageId) !== messageId
    ) {
      return undefined;
    }
    this.prune();
    const entry = this.cache.get(messageId),
      snapshot = entry?.snapshot;
    if (!entry || !snapshot) {
      return undefined;
    }
    const stale = entry.dirty || Date.now() - snapshot.observed_at >= FRESH_MS;
    return structuredClone({
      ...snapshot,
      status: stale ? 'stale' : snapshot.status,
    });
  }

  private eligible(
    id: string,
    origin: (id: string) => Proof | undefined,
  ): boolean {
    if (canonicalMessageId(id) !== id || !origin(id) || this.pending.has(id)) {
      return false;
    }
    const entry = this.cache.get(id),
      now = Date.now();
    return (
      !entry ||
      (entry.retryAfter <= now &&
        (entry.dirty ||
          !entry.snapshot ||
          now - entry.snapshot.observed_at >= FRESH_MS))
    );
  }

  private select(
    recentIds: readonly string[],
    origin: (id: string) => Proof | undefined,
    preferred: readonly string[],
    onlyPreferred: boolean,
  ): string[] {
    const selected: string[] = [],
      seen = new Set<string>();
    const add = (id: unknown): boolean => {
      if (
        selected.length >= ITEM_LIMIT ||
        typeof id !== 'string' ||
        seen.has(id)
      ) {
        return false;
      }
      seen.add(id);
      if (!this.eligible(id, origin)) {
        return false;
      }
      selected.push(id);
      return true;
    };
    if (!onlyPreferred) {
      let dirty = 0;
      for (const [id, entry] of this.cache) {
        if (entry.dirty && add(id) && ++dirty >= 4) {
          break;
        }
      }
    }
    for (const id of preferred) {
      add(id);
      if (selected.length >= ITEM_LIMIT) {
        break;
      }
    }
    if (!onlyPreferred && selected.length < ITEM_LIMIT) {
      for (
        let i = recentIds.length - 1;
        i >= 0 && selected.length < ITEM_LIMIT;
        i--
      ) {
        add(recentIds[i]);
      }
    }
    return selected;
  }

  /** 等待promise或abort，任一方完成后都移除abort监听，避免泄漏。 */
  private async wait(
    promise: Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) {
      return;
    }
    let onAbort!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      onAbort = resolve;
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([promise, cancelled]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async refresh(
    memory: Memory,
    preferredIds: readonly string[],
    signal?: AbortSignal,
    onlyPreferred = false,
  ): Promise<void> {
    if (signal?.aborted) {
      return;
    }
    if (this.active) {
      if (signal) {
        await this.wait(this.active.promise, signal);
      } else {
        await this.active.promise;
      }
      return;
    }
    this.prune();
    if (this.pending.size >= 2) {
      return;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, DEADLINE_MS);
    const deadline = performance.now() + DEADLINE_MS;
    const generation = this.generation,
      epoch = ++this.refreshEpoch;
    const alive = () =>
      !controller.signal.aborted &&
      !signal?.aborted &&
      this.generation === generation &&
      this.refreshEpoch === epoch &&
      performance.now() < deadline;
    const run = async (): Promise<void> => {
      // 冻结的recent()可能深拷贝数百条完整条目，只取一次，
      // 而不是为本轮视图外最多512个脏ID各取一次。
      const recentIds: string[] = [],
        quoted = new Set<string>();
      try {
        for (const entry of memory.recent()) {
          if (
            !object(entry) ||
            typeof entry.messageId !== 'string' ||
            canonicalMessageId(entry.messageId) !== entry.messageId ||
            !identity(entry.userId)
          ) {
            continue;
          }
          recentIds.push(entry.messageId);
          if (
            typeof entry.replyTo === 'string' &&
            canonicalMessageId(entry.replyTo) === entry.replyTo
          ) {
            quoted.add(entry.replyTo);
          }
        }
      } catch {
        /* memory不可用时不增加任何可引用依据。 */
      }
      const proven = new Map<string, Proof | undefined>();
      const origin = (id: string): Proof | undefined => {
        if (!proven.has(id)) {
          proven.set(id, proof(memory, id, quoted));
        }
        return proven.get(id);
      };
      const ids = this.select(recentIds, origin, preferredIds, onlyPreferred);
      let next = 0;
      const worker = async (): Promise<void> => {
        while (alive() && next < ids.length) {
          const id = ids[next++]!;
          if (
            this.pending.has(id) ||
            this.pending.size >= 2 ||
            !this.eligible(id, origin)
          ) {
            continue;
          }
          const revision = this.revision(id);
          const pending: Pending = { promise: Promise.resolve() };
          this.pending.set(id, pending);
          pending.promise = Promise.resolve()
            .then(() => {
              if (!alive()) {
                return undefined;
              }
              return this.api.call('get_msg', { message_id: id });
            })
            .then(
              (raw) => {
                if (alive() && this.matches(id, revision)) {
                  this.ingest(id, raw, memory, revision);
                }
              },
              () => {
                if (alive() && this.matches(id, revision)) {
                  this.failed(id, false);
                }
              },
            )
            .catch(() => {
              // 防御性清洗出错时绝不能泄漏provider的payload，
              // 也不能在对外等待已超时后产生未处理的rejection。
              if (alive() && this.matches(id, revision)) {
                this.failed(id, true);
              }
            })
            .finally(() => {
              if (this.pending.get(id) === pending) {
                this.pending.delete(id);
              }
            });
          await this.wait(pending.promise, controller.signal);
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(2 - this.pending.size, ids.length) },
          () => worker(),
        ),
      );
    };
    // 推迟到active赋值之后再开始工作，同步实现的假API也一样。
    const active = { controller, promise: Promise.resolve().then(run) };
    this.active = active;
    try {
      await active.promise;
    } finally {
      controller.abort();
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (this.active === active) {
        this.active = undefined;
      }
    }
  }
}
