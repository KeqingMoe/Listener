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
    if(!this.connected||this.stopped||!event||typeof event!=='object')return;
    const raw=event as Record<string,unknown>;
    if(raw.post_type!=='message'||raw.message_type!=='group')return;
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
