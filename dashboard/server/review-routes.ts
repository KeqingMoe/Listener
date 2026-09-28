import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import { Repository, ResourceLimit } from './repository.js';
import { ReviewRepository } from './review-repository.js';
import { EVENT_CATEGORIES } from '../shared/review.js';
const DAY=86400000;
class BadQuery extends Error {}
const integer=(v:unknown,fallback:number)=>{if(v===undefined)return fallback;if(typeof v!=='string'||!/^\d{1,16}$/.test(v)||!Number.isSafeInteger(Number(v)))throw new BadQuery();return Number(v);};
export function registerReviewRoutes(app:FastifyInstance,base:Repository,now:()=>number):void {
  const review=new ReviewRepository(base);
  const run=(fn:(req:any,reply:any)=>unknown)=>async(req:any,reply:any)=>{base.refreshGroups();try{return fn(req,reply);}catch(e){if(e instanceof BadQuery)return reply.code(400).send({error:'invalid_query',message:'Invalid query parameters'});throw e;}};
  const group=(q:Record<string,unknown>,required=false)=>{if(q.groupId===undefined&&!required)return undefined;if(typeof q.groupId!=='string'||!base.groups.some(g=>g.groupId===q.groupId))throw new BadQuery();return q.groupId;};
  const detail=(req:any)=>{const q=req.query as Record<string,unknown>;if(Object.keys(q).some(k=>k!=='groupId'))throw new BadQuery();const id=req.params.id;if(typeof id!=='string'||!id||id.length>256||/[\x00-\x1f]/.test(id))throw new BadQuery();return {groupId:group(q,true)!,id};};
  app.get('/api/requests',run((req)=>{
    const q=req.query as Record<string,unknown>;if(Object.keys(q).some(k=>!['since','until','groupId','limit','cursor','outcome','q'].includes(k)))throw new BadQuery();
    const until=integer(q.until,now()),since=integer(q.since,Math.max(0,until-DAY)),limit=integer(q.limit,30),groupId=group(q);
    if(since>until||until-since>31*DAY||limit<1||limit>100)throw new BadQuery();
    if(q.outcome!==undefined&&(typeof q.outcome!=='string'||!['success','failed','timeout','cancelled','unknown','running','interrupted'].includes(q.outcome)))throw new BadQuery();
    if(q.q!==undefined&&(typeof q.q!=='string'||q.q.length>200))throw new BadQuery();
    const range={since,until},binding=createHash('sha256').update(JSON.stringify({range,groupId,groups:base.groups.map(g=>g.groupId).sort(),outcome:q.outcome,q:q.q})).digest('hex');let offset=0;
    if(q.cursor!==undefined){try{if(typeof q.cursor!=='string'||q.cursor.length>300||!/^[A-Za-z0-9_-]+$/.test(q.cursor))throw 0;const c=JSON.parse(Buffer.from(q.cursor,'base64url').toString());if(c.binding!==binding||!Number.isSafeInteger(c.offset)||c.offset<0||c.offset>10000)throw 0;offset=c.offset;}catch{throw new BadQuery();}}
    const search=typeof q.q==='string'?q.q.toLowerCase():'';
    const all=review.requests(range,groupId).filter(r=>(q.outcome===undefined||r.outcome===q.outcome)&&(!search||[r.requestId,r.model,r.errorCode,r.responseId,r.previousResponseId,r.providerRequestId,r.turnId,r.wakeId].some(v=>v?.toLowerCase().includes(search))));
    const hasMore=all.length>offset+limit;if(hasMore&&offset+limit>10000)throw new ResourceLimit();
    return {range,items:all.slice(offset,offset+limit),nextCursor:hasMore?Buffer.from(JSON.stringify({binding,offset:offset+limit})).toString('base64url'):null};
  }));
  app.get('/api/requests/:id',run((req,reply)=>{const {groupId,id}=detail(req);return review.detail(groupId,id)??reply.code(404).send({error:'not_found',message:'Request not found'});}));
  app.get('/api/wakes/:id/review',run((req,reply)=>{const {groupId,id}=detail(req);if(!base.session(groupId))return reply.code(503).send({error:'unavailable',message:'Session data unavailable'});return review.wake(groupId,id)??reply.code(404).send({error:'not_found',message:'Wake not found'});}));
  app.get('/api/events',run((req)=>{
    const q=req.query as Record<string,unknown>;if(Object.keys(q).some(k=>!['since','until','groupId','limit','cursor','category','q'].includes(k)))throw new BadQuery();
    const until=integer(q.until,now()),since=integer(q.since,Math.max(0,until-DAY)),limit=integer(q.limit,50),groupId=group(q);
    if(since>until||until-since>31*DAY||limit<1||limit>100)throw new BadQuery();
    if(q.category!==undefined&&(typeof q.category!=='string'||!(EVENT_CATEGORIES as readonly string[]).includes(q.category)))throw new BadQuery();
    if(q.q!==undefined&&(typeof q.q!=='string'||q.q.length>200))throw new BadQuery();
    const range={since,until},binding=createHash('sha256').update(JSON.stringify({range,groupId,groups:base.groups.map(g=>g.groupId).sort(),category:q.category,q:q.q})).digest('hex');let after=Number.MAX_SAFE_INTEGER;
    if(q.cursor!==undefined){try{if(typeof q.cursor!=='string'||q.cursor.length>300||!/^[A-Za-z0-9_-]+$/.test(q.cursor))throw 0;const c=JSON.parse(Buffer.from(q.cursor,'base64url').toString());if(c.binding!==binding||!Number.isSafeInteger(c.after)||c.after<1)throw 0;after=c.after;}catch{throw new BadQuery();}}
    const {items,hasMore}=review.events(range,groupId,q.category as string|undefined,q.q as string|undefined,after,limit);
    return {range,items,nextCursor:hasMore?Buffer.from(JSON.stringify({binding,after:items.at(-1)!.sequence})).toString('base64url'):null};
  }));
  app.get('/api/health',run((req)=>{if(Object.keys(req.query).length)throw new BadQuery();return review.health(now());}));
}
