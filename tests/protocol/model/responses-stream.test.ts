import test from 'node:test';
import assert from 'node:assert/strict';
import { ResponsesModel } from '../../../src/model/responses.ts';
import type { ModelRequestRecord } from '../../../src/observability/model-usage.ts';
const encode=(value:unknown)=>new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
const options={baseUrl:'https://fixture.invalid/v1',apiKey:'fixture',model:'fixture',timeoutMs:1000,maxTokens:100,sessionId:'fixture'};
const output=[{id:'msg',type:'message',role:'assistant',content:[{type:'output_text',text:'hello'}]}];
const terminal=(extra:Record<string,unknown>={})=>({type:'response.completed',response:{id:'r',status:'completed',output,usage:{output_tokens:10},...extra}});
const delta=(text:string)=>({type:'response.output_text.delta',output_index:0,content_index:0,item_id:'msg',delta:text});
function stream(events:unknown[], delayed=true){let i=0;return new Response(new ReadableStream<Uint8Array>({async pull(c){if(i===events.length){c.close();return;}if(delayed)await new Promise(r=>setTimeout(r,10));c.enqueue(encode(events[i++]));}}),{headers:{'content-type':'text/event-stream; charset=utf-8'}});}
test('Responses measures first output through terminal completion and accepts charset',async t=>{
 const records:ModelRequestRecord[]=[];
 t.mock.method(globalThis,'fetch',async()=>stream([delta('he'),delta('llo'),terminal()]));
 assert.equal((await new ResponsesModel({...options,onRequest:r=>records.push(r)}).complete([])).content,'hello');
 const r=records[0]!;assert.ok(r.ttftMs!>=0);assert.ok(r.decodeDurationMs!>0);assert.ok(r.durationMs>r.ttftMs!+r.decodeDurationMs!);
});
test('Responses preserves reasoning and zero-duration measurements; snapshot-only has no first output',async t=>{
 for(const kind of ['snapshot','reasoning','buffered']){
  const records:ModelRequestRecord[]=[];
  const end=terminal(kind==='reasoning'?{usage:{output_tokens:20,output_tokens_details:{reasoning_tokens:10}},output:[...output,{type:'reasoning',encrypted_content:'opaque'}]}:{});
  t.mock.method(globalThis,'fetch',async()=>kind==='buffered'?new Response(new Uint8Array([...encode(delta('he')),...encode(delta('llo')),...encode(end)]),{headers:{'content-type':'text/event-stream'}}):stream(kind==='snapshot'?[end]:[delta('he'),delta('llo'),end]));
  await new ResponsesModel({...options,onRequest:r=>records.push(r)}).complete([]);
  if(kind==='snapshot'){assert.equal(records[0]!.decodeDurationMs,null);assert.equal(records[0]!.ttftMs,null);}else if(kind==='buffered'){assert.equal(records[0]!.decodeDurationMs,0);}else{assert.ok(records[0]!.decodeDurationMs!>0);assert.equal(records[0]!.usage.reasoningTokens,10);}
  t.mock.restoreAll();
 }
});
test('Responses rejects conflicting delta, missing terminal, JSON and oversized snapshot',async t=>{
 for(const kind of ['conflict','eof','json','oversized']){
  t.mock.method(globalThis,'fetch',async()=>kind==='json'?Response.json(terminal().response):stream(kind==='conflict'?[delta('wrong'),terminal()]:kind==='eof'?[delta('hello')]:[terminal({padding:'x'.repeat(2*1024*1024)})],false));
  await assert.rejects(new ResponsesModel(options).complete([]),(e:any)=>e.code===(kind==='oversized'?'response_too_large':'invalid_response'));
  t.mock.restoreAll();
 }
});
test('Responses cancellation keeps observed TTFT and never commits partial output',async t=>{
 const abort=new AbortController(),records:ModelRequestRecord[]=[];
 t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream<Uint8Array>({start(c){c.enqueue(encode(delta('he')));setTimeout(()=>abort.abort('reset'),10);}}),{headers:{'content-type':'text/event-stream'}}));
 const model=new ResponsesModel({...options,onRequest:r=>records.push(r)});
 await assert.rejects(model.complete([],[],abort.signal),(e:any)=>e.code==='cancelled');
 assert.ok(records[0]!.ttftMs!==null);assert.equal(records[0]!.decodeDurationMs,null);assert.equal(model.getCheckpoint(),undefined);
});
