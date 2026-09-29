import { id } from '../onebot/identity.js';
import { resolveGroupId } from '../contracts/identity.js';
import { withLogContext } from '../observability/logger.js';
import { normalizeOneBotEvent } from '../world/ingest.js';
import { types } from 'node:util';
import type { Reminder, DeliveryOutcome } from '../reminders/store.js';

export interface GroupHandler {
  receive(event: unknown, selfId: string): Promise<void>;
  /** Active, host-scheduled reminder dispatch; must not synthesize a receive event. */
  sendReminder?(reminder: Reminder, beforeDispatchClaim: () => boolean): Promise<DeliveryOutcome>;
  receiveSandboxResult?(result: {selfId:string;groupId:string;jobId:string;[key:string]:unknown}): Promise<boolean>;
  resumeSandboxResults?(selfId:string):void;
  setConnected(value: boolean): void;
  stop(): Promise<void>;
}
export interface DynamicGroupRouting {
  enabled(groupId: string): boolean;
  create(groupId: string): Promise<GroupHandler>;
  listGroups(): Promise<unknown>;
  membershipChanged?(groupIds: readonly string[]): void;
  onError?(reason: string): void;
}
/** Membership is established only by authenticated protocol input or a complete
 * successful get_group_list response, never by model text or configured IDs alone.
 * Structural transitions are serialized; handlers are allocated lazily. */
export class GroupRouter {
  private readonly handlers = new Map<string, GroupHandler>();
  private members = new Set<string>();
  private readonly touched = new Map<string, number>();
  private readonly departed = new Set<string>();
  private readonly groupEpoch = new Map<string, number>();
  private readonly closing = new Set<string>();
  private revision = 0;
  private connected = false;
  private stopped = false;
  private epoch = 0;
  private selfId?: string;
  private membershipVerified = false;
  private serial: Promise<void> = Promise.resolve();
  private stopPromise?: Promise<void>;
  private readonly dynamic?: DynamicGroupRouting;
  constructor(source: Iterable<readonly [string, GroupHandler]> | DynamicGroupRouting) {
    if ('create' in source) { this.dynamic = source; return; }
    const instances = new Set<GroupHandler>();
    for (const [groupId, handler] of source) {
      resolveGroupId(groupId);
      if (this.handlers.has(groupId) || instances.has(handler)) throw new Error('Invalid group routing registry');
      instances.add(handler); this.handlers.set(groupId, handler); this.members.add(groupId);
      handler.setConnected(false);
    }
  }
  get size(): number { return this.members.size; }
  get residentSize(): number { return this.handlers.size; }
  get groupIds(): readonly string[] { return [...this.members]; }
  get reminderAccount(): string | undefined { return this.connected && !this.stopped && this.membershipVerified ? this.selfId : undefined; }
  /** Only persisted host tasks may use this entry; membership never comes from task data. */
  async dispatchReminder(reminder: Reminder, claim: () => boolean): Promise<DeliveryOutcome> {
    const { groupId, selfId } = reminder;
    const epoch = this.epoch, groupEpoch = this.groupEpoch.get(groupId) ?? 0;
    const valid = () => id(groupId) === groupId && id(selfId) === selfId &&
      this.reminderAccount === selfId && epoch === this.epoch &&
      (this.groupEpoch.get(groupId) ?? 0) === groupEpoch && this.enabled(groupId) &&
      this.members.has(groupId) && !this.departed.has(groupId) && !this.closing.has(groupId);
    if (!valid()) throw new Error('reminder_unavailable');
    // Allocation shares receive's structural queue, but delivery must not hold it.
    const handler = this.handlers.get(groupId) ?? await this.enqueue(async () => {
      if (!valid()) return;
      let result = this.handlers.get(groupId);
      if (!result && this.dynamic) {
        result = await this.dynamic.create(groupId);
        if (!valid()) { await result.stop(); return; }
        result.setConnected(true); this.handlers.set(groupId, result);
      }
      return result;
    });
    if (!valid() || !handler?.sendReminder) throw new Error('reminder_unavailable');
    return withLogContext({group_id: groupId}, () => handler.sendReminder!(reminder, () =>
      valid() && this.handlers.get(groupId) === handler && claim()));
  }
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.serial.then(run);
    this.serial = result.then(() => {}, () => {});
    return result;
  }
  async dispatchSandboxResult(result:{selfId:string;groupId:string;jobId:string;[key:string]:unknown}):Promise<void> {
    const {groupId,selfId}=result,epoch=this.epoch,groupEpoch=this.groupEpoch.get(groupId)??0;
    const valid=()=>id(groupId)===groupId&&id(selfId)===selfId&&this.reminderAccount===selfId&&epoch===this.epoch&&(this.groupEpoch.get(groupId)??0)===groupEpoch&&this.enabled(groupId)&&this.members.has(groupId)&&!this.departed.has(groupId)&&!this.closing.has(groupId);
    if(!valid())throw new Error('sandbox_delivery_unavailable');
    const handler=this.handlers.get(groupId)??await this.enqueue(async()=>{if(!valid())return;let current=this.handlers.get(groupId);if(!current&&this.dynamic){current=await this.dynamic.create(groupId);if(!valid()){await current.stop();return;}current.setConnected(true);this.handlers.set(groupId,current);}return current;});
    if(!handler?.receiveSandboxResult||!valid())throw new Error('sandbox_delivery_unavailable');
    const projected = await handler.receiveSandboxResult(result);
    if(!projected) throw new Error('sandbox_delivery_unavailable');
  }
  private publish(): void { this.dynamic?.membershipChanged?.([...this.members]); }
  private async closeGroups(groupIds:Iterable<string>):Promise<void>{
    const ids=[...new Set(groupIds)];
    if(!ids.length)return;
    for(const groupId of ids){this.members.delete(groupId);this.closing.add(groupId);this.handlers.get(groupId)?.setConnected(false);}
    let publicationError:unknown;
    try{this.publish();}catch(error){publicationError=error;}
    const results=await Promise.allSettled(ids.map(async groupId=>{
      const handler=this.handlers.get(groupId);
      if(handler){await handler.stop();this.handlers.delete(groupId);}
      this.closing.delete(groupId);
    }));
    if(results.some(result=>result.status==='rejected'))throw new Error('Group shutdown failed');
    if(publicationError)throw publicationError;
  }
  private enabled(groupId: string): boolean {
    try { return this.dynamic ? this.dynamic.enabled(groupId) : this.members.has(groupId); }
    catch { this.dynamic?.onError?.('group_policy_failed'); return false; }
  }
  setConnected(value: boolean): void {
    if (this.stopped) return;
    this.connected = value;
    if (!value) { this.epoch++; this.membershipVerified = false; }
    for (const [groupId,handler] of this.handlers) handler.setConnected(value&&!this.departed.has(groupId)&&!this.closing.has(groupId));
  }
  /** A failed/invalid snapshot leaves the last known membership intact. */
  async connect(selfId: string): Promise<void> {
    this.membershipVerified = false;
    if (this.stopped || id(selfId) !== selfId) return;
    const changedIdentity = this.selfId !== undefined && this.selfId !== selfId;
    const epoch = ++this.epoch;
    this.selfId = selfId;
    if (changedIdentity) {
      this.connected = false;
      for (const handler of this.handlers.values()) handler.setConnected(false);
      await this.enqueue(async () => {
        const old = [...this.handlers]; this.members.clear(); this.touched.clear(); this.departed.clear(); this.groupEpoch.clear();
        for(const [groupId] of old)this.closing.add(groupId);
        const results=await Promise.allSettled(old.map(async([groupId,handler])=>{
          await handler.stop();this.handlers.delete(groupId);this.closing.delete(groupId);
        }));
        try{if(results.some(result=>result.status==='rejected'))throw new Error('Group identity shutdown failed');}
        finally{this.publish();}
      });
    }
    if (this.stopped || epoch !== this.epoch) return;
    this.setConnected(true);
    if (!this.dynamic) { this.membershipVerified = true; return; }
    const revision = this.revision;
    let response: unknown;
    try { response = await this.dynamic.listGroups(); }
    catch { this.dynamic.onError?.('group_list_unavailable'); return; }
    if (!Array.isArray(response) || types.isProxy(response)) { this.dynamic.onError?.('group_list_invalid'); return; }
    const listed=new Set<string>();
    for(const row of response){
      if(!row||typeof row!=='object'||types.isProxy(row)||Array.isArray(row)||Object.getPrototypeOf(row)!==Object.prototype){this.dynamic.onError?.('group_list_invalid');return;}
      const descriptor=Object.getOwnPropertyDescriptor(row,'group_id');
      const groupId=descriptor&&Object.hasOwn(descriptor,'value')?id(descriptor.value):undefined;
      if(!groupId){this.dynamic.onError?.('group_list_invalid');return;}
      listed.add(groupId);
    }
    if(this.stopped||!this.connected||epoch!==this.epoch)return;
    const snapshotNext=new Set([...listed].filter(groupId=>this.enabled(groupId)));
    for(const [groupId,at] of this.touched)if(at>revision){
      if(!this.departed.has(groupId)&&this.enabled(groupId))snapshotNext.add(groupId);else snapshotNext.delete(groupId);
    }
    const snapshotRetired=new Set([...this.members].filter(groupId=>!snapshotNext.has(groupId)));
    // Fence at response arrival, not after a pending factory/close yields the
    // structural queue. Even known-but-never-opened groups need this tombstone.
    for(const groupId of snapshotRetired){
      this.departed.add(groupId);this.closing.add(groupId);this.groupEpoch.set(groupId,(this.groupEpoch.get(groupId)??0)+1);
      this.handlers.get(groupId)?.setConnected(false);
    }
    await this.enqueue(async () => {
      // Finish already-authorized revocations even if disconnected meanwhile.
      await this.closeGroups(snapshotRetired);
      if (this.stopped || !this.connected || epoch !== this.epoch) return;
      const next = new Set([...listed].filter(groupId => this.enabled(groupId)));
      for (const [groupId, at] of this.touched) if (at > revision) {
        if (!this.departed.has(groupId)&&this.enabled(groupId)) next.add(groupId); else next.delete(groupId);
      }
      // Authoritative removals must still retire resources if a newly discovered
      // group's policy/path is invalid. Do not admit any additions until validated.
      const removed = [...this.members].filter(groupId => !next.has(groupId));
      for(const groupId of removed){
        if(!this.departed.has(groupId)){this.departed.add(groupId);this.groupEpoch.set(groupId,(this.groupEpoch.get(groupId)??0)+1);}
      }
      await this.closeGroups(removed);
      if(this.stopped||!this.connected||epoch!==this.epoch)return;
      try { this.dynamic!.membershipChanged?.([...next]); }
      catch(error){try{this.publish();}catch{}throw error;}
      this.members = next;
      for(const groupId of next)if((this.touched.get(groupId)??0)<=revision)this.departed.delete(groupId);
      for (const [groupId, at] of this.touched) if (at <= revision) this.touched.delete(groupId);
      this.membershipVerified = true;
    });
  }
  async receive(event: unknown, selfId: string): Promise<void> {
    if (!this.connected || this.stopped || id(selfId) !== selfId || !event || typeof event !== 'object' || types.isProxy(event) || Array.isArray(event) || Object.getPrototypeOf(event) !== Object.prototype) return;
    const raw = event as Record<string, unknown>;
    for (const key of ['post_type','message_type','notice_type','sub_type','group_id','self_id','user_id']) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, key); if (descriptor && !Object.hasOwn(descriptor,'value')) return;
    }
    if (raw.self_id !== undefined && id(raw.self_id) !== selfId) return;
    const chat = raw.post_type === 'message' && raw.message_type === 'group';
    const notice = raw.post_type === 'notice' && (typeof raw.notice_type === 'string' && ['group_msg_emoji_like','group_recall','group_increase','group_decrease','group_ban','group_upload'].includes(raw.notice_type) || raw.notice_type === 'notify' && ['poke','group_name'].includes(String(raw.sub_type)));
    const groupId = id(raw.group_id);
    if ((!chat && !notice) || !groupId || !this.enabled(groupId)) return;
    if (this.dynamic && (this.selfId !== selfId || id(raw.self_id) !== selfId || !normalizeOneBotEvent(event, selfId))) return;
    const epoch = this.epoch;
    const selfLeft = notice && raw.notice_type === 'group_decrease' && id(raw.user_id) === selfId;
    const selfJoined=notice&&raw.notice_type==='group_increase'&&id(raw.user_id)===selfId;
    if(this.dynamic){
      if(selfLeft){this.departed.add(groupId);this.closing.add(groupId);this.groupEpoch.set(groupId,(this.groupEpoch.get(groupId)??0)+1);}
      else if(selfJoined)this.departed.delete(groupId);
      else if(this.departed.has(groupId))return;
      // Explicit self join/leave beats an in-flight snapshot. Ordinary traffic
      // is weaker membership evidence and cannot override a successful removal.
      if(selfLeft||selfJoined)this.touched.set(groupId,++this.revision);
    }
    const groupEpoch=this.groupEpoch.get(groupId)??0;
    // Cancel running work immediately, even if another transition is awaiting close.
    if (selfLeft) this.handlers.get(groupId)?.setConnected(false);
    const stable=this.handlers.get(groupId);
    // Unrelated live groups never wait behind another group's late ACK/close.
    if(stable&&!selfLeft&&!selfJoined&&this.members.has(groupId)&&!this.closing.has(groupId)){
      await withLogContext({group_id:groupId},()=>stable.receive(event,selfId));return;
    }
    const handler = await this.enqueue(async () => {
      if(this.dynamic&&selfLeft){
        if((this.groupEpoch.get(groupId)??0)===groupEpoch)await this.closeGroups([groupId]);
        return;
      }
      if (this.stopped || !this.connected || epoch !== this.epoch || (this.groupEpoch.get(groupId)??0)!==groupEpoch) return;
      if (this.dynamic) {
        if(this.closing.has(groupId))await this.closeGroups([groupId]);
        if(this.stopped||!this.connected||epoch!==this.epoch||(this.groupEpoch.get(groupId)??0)!==groupEpoch||this.departed.has(groupId))return;
        if (!this.members.has(groupId)) {
          const next = [...this.members, groupId];
          this.dynamic.membershipChanged?.(next); this.members.add(groupId);
        }
      }
      let result = this.handlers.get(groupId);
      if (!result && this.dynamic) {
        result = await this.dynamic.create(groupId);
        if (this.stopped || !this.connected || epoch !== this.epoch || (this.groupEpoch.get(groupId)??0)!==groupEpoch || this.departed.has(groupId)) { await result.stop(); return; }
        result.setConnected(true); this.handlers.set(groupId, result);
      }
      return result;
    });
    if (handler && this.connected && !this.stopped && epoch === this.epoch && (this.groupEpoch.get(groupId)??0)===groupEpoch && !this.departed.has(groupId))
      await withLogContext({group_id:groupId}, () => handler.receive(event,selfId));
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true; this.connected = false; this.epoch++;
    for (const handler of this.handlers.values()) handler.setConnected(false);
    this.stopPromise = this.enqueue(async () => {
      const handlers = [...this.handlers.values()]; this.handlers.clear(); this.members.clear(); this.touched.clear(); this.departed.clear(); this.groupEpoch.clear(); this.closing.clear();
      const results = await Promise.allSettled(handlers.map(handler => handler.stop()));
      this.publish();
      if (results.some(result => result.status === 'rejected')) throw new Error('Group shutdown failed');
    });
    return this.stopPromise;
  }
}
