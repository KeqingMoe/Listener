import { id } from './bot.js';
import { resolveGroupId } from './contracts.js';
import { withLogContext } from './logger.js';

export interface GroupHandler {
  receive(event: unknown, selfId: string): Promise<void>;
  setConnected(value: boolean): void;
  stop(): Promise<void>;
}
/** Explicit static whitelist. Unknown groups and private messages never reach
 * a Listener or its memory, even when the shared connection receives them. */
export class GroupRouter {
  private readonly handlers = new Map<string,GroupHandler>();
  private connected = false;
  private stopped = false;
  constructor(entries: Iterable<readonly [string,GroupHandler]>) {
    const instances=new Set<GroupHandler>();
    for(const [groupId,handler] of entries){
      resolveGroupId(groupId);
      if(this.handlers.has(groupId)||instances.has(handler)||this.handlers.size>=32)throw new Error('Invalid group routing registry');
      instances.add(handler);this.handlers.set(groupId,handler);
    }
    for(const handler of this.handlers.values())handler.setConnected(false);
  }
  get size(): number { return this.handlers.size; }
  setConnected(value: boolean): void {
    if(this.stopped)return;
    this.connected=value;
    for(const handler of this.handlers.values())handler.setConnected(value);
  }
  async receive(event: unknown,selfId: string): Promise<void> {
    if(!this.connected||this.stopped||!id(selfId)||!event||typeof event!=='object'||Array.isArray(event)||Object.getPrototypeOf(event)!==Object.prototype)return;
    const raw=event as Record<string,unknown>;
    for(const key of ['post_type','message_type','notice_type','sub_type','group_id','self_id']){const d=Object.getOwnPropertyDescriptor(raw,key);if(d&&!Object.hasOwn(d,'value'))return;}
    if(raw.self_id!==undefined&&id(raw.self_id)!==selfId)return;
    const chat=raw.post_type==='message'&&raw.message_type==='group';
    const notice=raw.post_type==='notice'&&(typeof raw.notice_type==='string'&&['group_msg_emoji_like','group_recall','group_increase','group_decrease','group_ban','group_upload'].includes(raw.notice_type)||(raw.notice_type==='notify'&&typeof raw.sub_type==='string'&&['poke','group_name'].includes(raw.sub_type)));
    if(!chat&&!notice)return;
    const groupId=id(raw.group_id);
    if(!groupId)return;
    const handler=this.handlers.get(groupId);
    if(handler)await withLogContext({group_id:groupId},()=>handler.receive(event,selfId));
  }
  async stop(): Promise<void> {
    if(this.stopped)return;this.stopped=true;this.connected=false;
    const results=await Promise.allSettled([...this.handlers.values()].map(handler=>handler.stop()));
    if(results.some(result=>result.status==='rejected'))throw new Error('Group shutdown failed');
  }
}
