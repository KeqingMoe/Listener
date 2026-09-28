import { OWNER_ID, resolveOwnerId, type JsonObject, type Memory, type TimelineEntry, type TurnContext } from './contracts/index.js';
import { newTraceId } from './logger.js';
import type { AttentionHit } from './attention.js';
import { projectMessage } from './message-content.js';

export interface BatchItem {
  entry: TimelineEntry;
  context: TurnContext;
  sequence: number;
  received: number;
  trigger?: 'mention' | 'quote';
  unverifiedQuote?: boolean;
}

const MAX_ITEMS = 64;
const MAX_PAYLOAD = 24_000;
const copy = <T>(value: T): T => structuredClone(value);

/** Arrival ordering and retention only. Scheduling, random draws and logging belong to Listener. */
export class ReplyBatch {
  readonly turnId = newTraceId();
  items: BatchItem[] = [];
  openedAt: number;
  readyAt: number;
  randomSelected: boolean;
  readonly attentionHits: AttentionHit[] = [];
  omittedAttentionHits = 0;
  addAttention(hits: readonly AttentionHit[]): void {
    for(const hit of hits){
      if(this.attentionHits.some(previous=>previous.plan_id===hit.plan_id))continue;
      if(this.attentionHits.length>=64){this.omittedAttentionHits++;continue;}
      this.attentionHits.push(copy(hit));
    }
  }
  omittedMessages = 0;
  omittedDirect = 0;
  hasNonOwnerDirect = false;
  hasUnverifiedQuote = false;
  private readonly seen = new Set<string>();
  private firstDirectSequence = Infinity;

  private readonly ownerId: string;
  constructor(item: BatchItem, delayMs: number, randomSelected = false, ownerId: string = OWNER_ID) {
    this.ownerId = resolveOwnerId(ownerId);
    this.openedAt = item.received;
    this.readyAt = item.received + delayMs;
    this.randomSelected = randomSelected;
    this.add(item, delayMs);
  }

  add(item: BatchItem, delayMs: number): void {
    if (item.trigger && item.entry.userId !== this.ownerId) this.hasNonOwnerDirect = true;
    if (item.unverifiedQuote) this.hasUnverifiedQuote = true;
    if (this.seen.has(item.entry.messageId) || this.items.some(existing => existing.entry.messageId === item.entry.messageId)) return;
    this.seen.add(item.entry.messageId);
    // Listener's memory handles transport dedup; keep only a bounded local FIFO.
    if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!);
    this.openedAt = Math.min(this.openedAt, item.received);
    if (item.trigger && item.sequence < this.firstDirectSequence) {
      this.readyAt = this.firstDirectSequence === Infinity
        ? item.received + delayMs : Math.min(this.readyAt, item.received + delayMs);
      this.firstDirectSequence = item.sequence;
    }
    if (this.items.length === MAX_ITEMS) {
      const ordinary = this.items.findIndex(existing => !existing.trigger);
      this.omittedMessages++;
      if (ordinary < 0) {
        if (!item.trigger) return;
        this.omittedDirect++;
        // A slow quote lookup can finish late despite an earlier arrival.
        // Preserve the earliest arrivals, not the first lookup completions.
        if (item.sequence >= this.items[this.items.length-1]!.sequence) return;
        this.items.pop();
      } else {
        if (!item.trigger && item.sequence <= this.items[ordinary]!.sequence) return;
        this.items.splice(ordinary, 1);
      }
    }
    this.items.push(copy(item));
    this.items.sort((a, b) => a.sequence - b.sequence);
  }

  get direct(): BatchItem[] { return this.items.filter(item => item.trigger); }
  get kind(): 'direct' | 'attention' | 'random' { return this.direct.length ? 'direct' : this.attentionHits.length ? 'attention' : 'random'; }
  get primary(): BatchItem { return this.direct[0] ?? this.items[this.items.length - 1]!; }

  payload(): JsonObject {
    const trusted = this.direct.map(({ entry, trigger }) => ({
      message_id: entry.messageId, user_id: entry.userId, trigger,
    }));
    const render = (limit: number, names: boolean, compactMetadata=false): JsonObject => {
      const truncated: string[] = [];
      const messages = this.items.map(({ entry }) => {
        const message=projectMessage(entry,limit);
        // Typed media segments carry their references; do not duplicate the root lists.
        delete message.images;delete message.forwards;
        if(names)message.nickname=entry.nickname.replace(/[\u0000-\u001f\u007f-\u009f]/g,'').slice(0,24);
        else delete message.nickname;
        if(message.content_truncated||message.text_truncated)truncated.push(entry.messageId);
        return message;
      });
      return {
        current_batch: {
          messages, omitted_messages: this.omittedMessages, omitted_direct: this.omittedDirect,
          unverified_references: this.hasUnverifiedQuote,
          ...(compactMetadata?{truncated_messages:truncated.length,truncated_ids_omitted:truncated.length}: {truncated_message_ids:truncated}),
          ...(truncated.length ? { reason: Number.isFinite(limit)?'payload_character_limit':'source_content_incomplete' } : {}),
        },
        trusted_direct_requests: trusted, trigger_kind: this.kind,
      };
    };
    const full = render(Infinity, true);
    if (JSON.stringify(full).length <= MAX_PAYLOAD) return full;
    // Names and duplicated attachment metadata are expendable; provenance and callers are not.
    const withoutNames = render(Infinity, false);
    if (JSON.stringify(withoutNames).length <= MAX_PAYLOAD) return withoutNames;
    let low = 0;
    let high = Math.max(16000,...this.items.map(item => JSON.stringify(item.entry.text).length));
    let compactMetadata=false;
    let best = render(0, false);
    if(JSON.stringify(best).length>MAX_PAYLOAD){
      // The same IDs already accompany every per-message truncation flag.
      // Drop only this duplicate roster, never message/caller/reply provenance.
      compactMetadata=true;best=render(0,false,true);
    }
    if (JSON.stringify(best).length > MAX_PAYLOAD) {
      // Valid OneBot IDs (at most 32 digits) always fit, even with all 64 callers.
      throw new RangeError('Reply batch provenance exceeds payload limit');
    }
    // Equal per-entry caps share space among long bodies without dropping early callers.
    // Measure serialized JSON, including escaping, framing, roster and truncation flags.
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = render(middle, false,compactMetadata);
      if (JSON.stringify(candidate).length <= MAX_PAYLOAD) {
        best = candidate;
        low = middle + 1;
      } else high = middle - 1;
    }
    return best;
  }
}

/** Capture synchronously before awaiting compaction; never delegate writes or later reads. */
export function snapshotMemory(memory: Memory, batchEntries: TimelineEntry[], excludeIds = new Set<string>()): Memory {
  const rawContext = memory.context();
  let context = rawContext;
  try {
    const parsed: unknown = JSON.parse(rawContext);
    const keep = (entry: unknown): boolean => !entry || typeof entry !== 'object'
      || !('messageId' in entry) || !excludeIds.has(String(entry.messageId));
    if (Array.isArray(parsed)) context = JSON.stringify(parsed.filter(keep));
    else if (parsed && typeof parsed === 'object' && 'messages' in parsed && Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.filter(keep);
      context = JSON.stringify(parsed);
    }
  } catch { /* Legacy memories may expose plain text rather than JSON. */ }
  const entries = new Map<string, TimelineEntry>();
  for (const entry of memory.recent().slice(-300)) {
    if (!excludeIds.has(entry.messageId)) entries.set(entry.messageId, copy(entry));
  }
  // Trusted batch entries override both stale records and the unresolved-ID exclusion.
  for (const entry of batchEntries.slice(0, MAX_ITEMS)) entries.set(entry.messageId, copy(entry));
  return {
    recent: () => copy([...entries.values()]),
    find: id => { const entry = entries.get(id); return entry ? copy(entry) : undefined; },
    context: () => context,
    append: () => false,
    compact: async () => {},
    clear: () => {},
    close: () => {},
  };
}
