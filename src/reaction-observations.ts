import { resolveGroupId, type Api, type JsonObject, type Memory } from './contracts.js';
import { getReactionCatalog, type ReactionEntry } from './reaction-catalog.js';

const CAPACITY = 512, ITEM_LIMIT = 8, SCAN_LIMIT = 128, FRESH_MS = 15_000, FAILURE_MS = 5_000, DEADLINE_MS = 1_500;
interface Snapshot { message_id: string; status: 'observed'|'partial'|'empty_snapshot'; observed_at: number; items: JsonObject[]; omitted?: number }
interface Cached { revision: number; touched: number; dirty: boolean; retryAfter: number; snapshot?: Snapshot }
interface Pending { promise: Promise<void> }
interface Proof { sender?: string }
function object(value: unknown): value is JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try { return [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key =>
    typeof key === 'string' && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value')); }
  catch { return false; }
}
function shortId(value: unknown): string|undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && !Object.is(value, -0) ? String(value) : undefined;
  if (typeof value !== 'string' || value.length > 17 || !/^(0|-?[1-9][0-9]*)$/.test(value) || String(Number(value)) !== value || !Number.isSafeInteger(Number(value))) return undefined;
  return value;
}
function unsigned(value: unknown): string|undefined {
  const id = shortId(value);
  return id !== undefined && !id.startsWith('-') ? id : undefined;
}
function identity(value: unknown): string|undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  return typeof value === 'string' && value.length <= 32 && value.trim() === value && /^[1-9][0-9]*$/.test(value) ? value : undefined;
}
function proof(memory: Memory, id: string, quoted?: ReadonlySet<string>): Proof|undefined {
  try {
    const local = memory.find(id);
    if (local !== undefined) {
      if (!object(local) || local.messageId !== id || typeof local.userId !== 'string' || identity(local.userId) !== local.userId) return undefined;
      return { sender: local.userId };
    }
    if (quoted ? quoted.has(id) : memory.recent().some(entry => object(entry) && shortId(entry.messageId) === entry.messageId && identity(entry.userId) && entry.replyTo === id)) return {};
  } catch { /* Broken/foreign provenance is not evidence. */ }
  return undefined;
}
function verified(raw: unknown, id: string, groupId: string, origin: Proof): raw is JsonObject {
  if (!object(raw) || raw.message_type !== 'group' || identity(raw.group_id) !== groupId || shortId(raw.message_id) !== id || !object(raw.sender)) return false;
  const sender = identity(raw.sender.user_id);
  return sender !== undefined && (origin.sender === undefined || origin.sender === sender) &&
    (!Object.hasOwn(raw, 'user_id') || identity(raw.user_id) === sender);
}
let catalog: ReadonlyMap<string, ReactionEntry>|undefined;
function label(id: string, type: string): Pick<ReactionEntry, 'name'|'emoji'>|undefined {
  try { catalog ??= new Map(getReactionCatalog().map(entry => [entry.id, entry])); } catch { return undefined; }
  const entry = catalog.get(id);
  if (!entry || !((type === '1' && entry.kind === 'face') || (type === '2' && entry.kind === 'emoji'))) return undefined;
  return { name: entry.name, ...(entry.emoji ? { emoji: entry.emoji } : {}) };
}

/** Observes QQ-reported counters, never unique people, own membership or a
 * guaranteed absence. An empty SDK list is only an empty_snapshot: GetMsg also
 * initializes that list when the underlying SDK supplied no aggregate field. */
export class ReactionObservations {
  private readonly groupId: string;
  private readonly retentionMs: number;
  private readonly cache = new Map<string, Cached>();
  // These physical RPC leases deliberately survive clear() and refresh timeout.
  private readonly pending = new Map<string, Pending>();
  private serial = 0;
  private generation = 0;
  private refreshEpoch = 0;
  private active?: { promise: Promise<void>; controller: AbortController };
  constructor(private readonly api: Api, groupId: string, retentionDays: number) {
    this.groupId = resolveGroupId(groupId);
    if (!Number.isFinite(retentionDays) || retentionDays <= 0 || retentionDays > 30) throw new Error('Invalid reaction observation retention');
    this.retentionMs = retentionDays * 86_400_000;
  }
  clear(): void {
    this.generation++; this.refreshEpoch++;
    this.cache.clear(); this.active?.controller.abort();
    // Do not reset serial: old ingestion tokens must never match a new entry.
  }
  private prune(now = Date.now()): void {
    const cutoff = now - this.retentionMs;
    for (const [id, entry] of this.cache) {
      if (entry.touched < cutoff) { this.cache.delete(id); continue; }
      if (entry.snapshot && entry.snapshot.observed_at < cutoff) {
        entry.snapshot = undefined; entry.dirty = true; entry.revision = ++this.serial;
      }
    }
  }
  private entry(id: string): Cached {
    let entry = this.cache.get(id);
    if (!entry) entry = { revision: ++this.serial, touched: Date.now(), dirty: false, retryAfter: 0 };
    entry.touched = Date.now(); this.cache.delete(id); this.cache.set(id, entry);
    while (this.cache.size > CAPACITY) this.cache.delete(this.cache.keys().next().value!);
    return entry;
  }
  /** Capture immediately before asynchronous get_msg; revisions survive neither
   * notices nor eviction/reset, so old responses cannot freshen newer evidence. */
  revision(messageId: string): number {
    if (typeof messageId !== 'string' || shortId(messageId) !== messageId) return 0;
    this.prune(); return this.entry(messageId).revision;
  }
  markDirty(messageId: string): void {
    if (typeof messageId !== 'string' || shortId(messageId) !== messageId) return;
    this.prune(); const entry = this.entry(messageId);
    entry.dirty = true; entry.revision = ++this.serial;
  }
  notice(event: unknown, memory: Memory): boolean {
    if (!object(event) || event.post_type !== 'notice' || event.notice_type !== 'group_msg_emoji_like' || identity(event.group_id) !== this.groupId) return false;
    const id = shortId(event.message_id);
    if (id === undefined || !proof(memory, id)) return false;
    // The envelope is a dirty hint only. Do not inspect/add/subtract likes.count,
    // trust is_add, attribute absent user_id to self, or initiate RPC/model work.
    this.markDirty(id); return true;
  }
  private matches(id: string, revision?: number): boolean {
    return revision === undefined || (Number.isSafeInteger(revision) && revision > 0 && this.cache.get(id)?.revision === revision);
  }
  private failed(id: string, clearSnapshot: boolean): void {
    const entry = this.entry(id);
    if (clearSnapshot) entry.snapshot = undefined;
    entry.dirty = true; entry.retryAfter = Date.now() + FAILURE_MS; entry.revision = ++this.serial;
  }
  /** Direct synchronous snapshots may omit the token. Async callers MUST supply
   * their pre-request revision and independently guard their owner generation. */
  ingest(messageId: string, raw: unknown, memory: Memory, expectedRevision?: number): void {
    if (typeof messageId !== 'string' || shortId(messageId) !== messageId) return;
    this.prune(); if (!this.matches(messageId, expectedRevision)) return;
    const origin = proof(memory, messageId);
    if (!origin || !verified(raw, messageId, this.groupId, origin)) { this.failed(messageId, true); return; }
    const list = raw.emoji_likes_list;
    if (!Array.isArray(list)) { this.failed(messageId, false); return; }
    const items: JsonObject[] = [], seen = new Set<string>();
    for (let i = 0; i < Math.min(list.length, SCAN_LIMIT) && items.length < ITEM_LIMIT; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(list, String(i));
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !object(descriptor.value)) continue;
      const row = descriptor.value;
      const id = unsigned(row.emoji_id), type = unsigned(row.emoji_type), count = unsigned(row.likes_cnt);
      if (id === undefined || type === undefined || count === undefined) continue;
      const key = `${type}:${id}`; if (seen.has(key)) continue; seen.add(key);
      items.push({ emoji_id: id, emoji_type: type, ...label(id, type), count: Number(count) });
    }
    const omitted = list.length - items.length;
    const snapshot: Snapshot = { message_id: messageId, observed_at: Date.now(),
      status: list.length === 0 ? 'empty_snapshot' : omitted ? 'partial' : 'observed', items, ...(omitted ? { omitted } : {}) };
    const entry = this.entry(messageId);
    entry.snapshot = snapshot; entry.dirty = false; entry.retryAfter = 0; entry.revision = ++this.serial;
  }
  get(messageId: string): JsonObject|undefined {
    if (typeof messageId !== 'string' || shortId(messageId) !== messageId) return undefined;
    this.prune(); const entry = this.cache.get(messageId), snapshot = entry?.snapshot;
    if (!entry || !snapshot) return undefined;
    const stale = entry.dirty || Date.now() - snapshot.observed_at >= FRESH_MS;
    return structuredClone({ ...snapshot, status: stale ? 'stale' : snapshot.status });
  }
  private eligible(id: string, origin: (id: string) => Proof|undefined): boolean {
    if (shortId(id) !== id || !origin(id) || this.pending.has(id)) return false;
    const entry = this.cache.get(id), now = Date.now();
    return !entry || (entry.retryAfter <= now && (entry.dirty || !entry.snapshot || now - entry.snapshot.observed_at >= FRESH_MS));
  }
  private select(recentIds: readonly string[], origin: (id: string) => Proof|undefined, preferred: readonly string[], onlyPreferred: boolean): string[] {
    const selected: string[] = [], seen = new Set<string>();
    const add = (id: unknown): boolean => {
      if (selected.length >= ITEM_LIMIT || typeof id !== 'string' || seen.has(id)) return false;
      seen.add(id);
      if (!this.eligible(id, origin)) return false;
      selected.push(id); return true;
    };
    if (!onlyPreferred) {
      let dirty = 0;
      for (const [id, entry] of this.cache) if (entry.dirty && add(id) && ++dirty >= 4) break;
    }
    for (const id of preferred) { add(id); if (selected.length >= ITEM_LIMIT) break; }
    if (!onlyPreferred && selected.length < ITEM_LIMIT) {
      for (let i = recentIds.length - 1; i >= 0 && selected.length < ITEM_LIMIT; i--) add(recentIds[i]);
    }
    return selected;
  }
  /** Wait without retaining an abort listener after either branch completes. */
  private async wait(promise: Promise<void>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    let onAbort!: () => void;
    const cancelled = new Promise<void>(resolve => { onAbort = resolve; signal.addEventListener('abort', onAbort, { once: true }); });
    try { await Promise.race([promise, cancelled]); }
    finally { signal.removeEventListener('abort', onAbort); }
  }
  async refresh(memory: Memory, preferredIds: readonly string[], signal?: AbortSignal, onlyPreferred = false): Promise<void> {
    if (signal?.aborted) return;
    if (this.active) {
      if (signal) await this.wait(this.active.promise, signal); else await this.active.promise;
      return;
    }
    this.prune();
    if (this.pending.size >= 2) return;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, DEADLINE_MS);
    const deadline = performance.now() + DEADLINE_MS;
    const generation = this.generation, epoch = ++this.refreshEpoch;
    const alive = () => !controller.signal.aborted && !signal?.aborted && this.generation === generation && this.refreshEpoch === epoch && performance.now() < deadline;
    const run = async (): Promise<void> => {
      // Frozen recent() can deep-clone hundreds of rich entries. Materialize it
      // once, not once for each of up to 512 dirty IDs outside this turn's view.
      const recentIds: string[] = [], quoted = new Set<string>();
      try {
        for (const entry of memory.recent()) {
          if (!object(entry) || typeof entry.messageId !== 'string' || shortId(entry.messageId) !== entry.messageId || !identity(entry.userId)) continue;
          recentIds.push(entry.messageId);
          if (typeof entry.replyTo === 'string' && shortId(entry.replyTo) === entry.replyTo) quoted.add(entry.replyTo);
        }
      } catch { /* Unavailable memory does not add any reference authority. */ }
      const proven = new Map<string, Proof|undefined>();
      const origin = (id: string): Proof|undefined => {
        if (!proven.has(id)) proven.set(id, proof(memory, id, quoted));
        return proven.get(id);
      };
      const ids = this.select(recentIds, origin, preferredIds, onlyPreferred);
      let next = 0;
      const worker = async (): Promise<void> => {
        while (alive() && next < ids.length) {
          const id = ids[next++]!;
          if (this.pending.has(id) || this.pending.size >= 2 || !this.eligible(id, origin)) continue;
          const revision = this.revision(id);
          const pending: Pending = { promise: Promise.resolve() };
          this.pending.set(id, pending);
          pending.promise = Promise.resolve().then(() => {
            if (!alive()) return undefined;
            return this.api.call('get_msg', { message_id: id });
          }).then(raw => {
            if (alive() && this.matches(id, revision)) this.ingest(id, raw, memory, revision);
          }, () => {
            if (alive() && this.matches(id, revision)) this.failed(id, false);
          }).catch(() => {
            // Defensive sanitization failures must never leak provider payloads
            // or create an unhandled rejection after a timed-out public wait.
            if (alive() && this.matches(id, revision)) this.failed(id, true);
          }).finally(() => { if (this.pending.get(id) === pending) this.pending.delete(id); });
          await this.wait(pending.promise, controller.signal);
        }
      };
      await Promise.all(Array.from({ length: Math.min(2 - this.pending.size, ids.length) }, () => worker()));
    };
    // Defer work until active is installed, including for synchronous fake APIs.
    const active = { controller, promise: Promise.resolve().then(run) };
    this.active = active;
    try { await active.promise; }
    finally {
      controller.abort(); clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      if (this.active === active) this.active = undefined;
    }
  }
}
