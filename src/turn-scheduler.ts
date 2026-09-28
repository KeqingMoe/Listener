import { resolveGroupId } from './contracts/index.js';

export interface TurnAdmission { acquire(groupId: string, signal?: AbortSignal): Promise<() => void> }
interface Waiting {
  groupId: string; signal?: AbortSignal; abort: () => void;
  resolve: (release: () => void) => void; reject: (error: Error) => void;
}
const cancelled = () => new DOMException('Turn admission cancelled', 'AbortError');

/** A permit covers one whole turn (summary, tools and sends included). FIFO
 * admission with at most one outstanding turn per group prevents busy groups
 * from filling the queue. Listener keeps its batch mutable until admission. */
export class TurnScheduler implements TurnAdmission {
  private readonly groups = new Set<string>();
  private readonly queue: Waiting[] = [];
  private active = 0;
  private closed = false;
  constructor(private readonly concurrency = 2, private readonly maxGroups = 32) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8 ||
        !Number.isInteger(maxGroups) || maxGroups < 1 || maxGroups > 32) throw new Error('Invalid turn scheduler limits');
  }
  get activeCount(): number { return this.active; }
  get waitingCount(): number { return this.queue.length; }
  async acquire(groupId: string, signal?: AbortSignal): Promise<() => void> {
    resolveGroupId(groupId);
    if (signal?.aborted) throw cancelled();
    if (this.closed) throw new Error('Turn scheduler closed');
    if (this.groups.has(groupId)) throw new Error('Group already admitted or waiting');
    if (this.groups.size >= this.maxGroups) throw new Error('Turn scheduler capacity exceeded');
    return new Promise((resolve, reject) => {
      const entry: Waiting = {groupId,signal,resolve,reject,abort:()=>{
        const index=this.queue.indexOf(entry);
        if(index<0)return;
        this.queue.splice(index,1);this.groups.delete(groupId);
        signal?.removeEventListener('abort',entry.abort);reject(cancelled());this.pump();
      }};
      this.groups.add(groupId);this.queue.push(entry);
      signal?.addEventListener('abort',entry.abort,{once:true});
      this.pump();
    });
  }
  private pump(): void {
    while (!this.closed && this.active < this.concurrency && this.queue.length) {
      const entry=this.queue.shift()!;
      entry.signal?.removeEventListener('abort',entry.abort);
      if(entry.signal?.aborted){this.groups.delete(entry.groupId);entry.reject(cancelled());continue;}
      this.active++;let released=false;
      entry.resolve(()=>{
        if(released)return;released=true;
        this.active--;this.groups.delete(entry.groupId);this.pump();
      });
    }
  }
  close(): void {
    if(this.closed)return;this.closed=true;
    for(const entry of this.queue.splice(0)){
      entry.signal?.removeEventListener('abort',entry.abort);
      this.groups.delete(entry.groupId);entry.reject(cancelled());
    }
    // Active permits are released only by their owners after async work settles.
  }
}
