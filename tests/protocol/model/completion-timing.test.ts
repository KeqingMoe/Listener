import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIModel } from '../../../src/model/chat.ts';
import { ResponsesModel } from '../../../src/model/responses.ts';
import type { ModelRequestRecord } from '../../../src/observability/model-usage.ts';
const options={baseUrl:'https://fixture.invalid/v1',apiKey:'fixture',model:'fixture',timeoutMs:1000,maxTokens:100,sessionId:'fixture'};
const event=(value:unknown)=>`data: ${JSON.stringify(value)}\n\n`;
const output=[{id:'msg',type:'message',role:'assistant',content:[{type:'output_text',text:'hello'}]}];
for(const transport of ['chat','responses'] as const) {
 const first=transport==='chat'?event({choices:[{index:0,delta:{content:'he'},finish_reason:null}]}):event({type:'response.output_text.delta',output_index:0,content_index:0,delta:'he'});
 const last=transport==='chat'?event({choices:[{index:0,delta:{content:'llo'},finish_reason:'stop'}]}):event({type:'response.output_text.delta',output_index:0,content_index:0,delta:'llo'});
 const terminal=transport==='chat'?'data: [DONE]\n\n':event({type:'response.completed',response:{id:'r',status:'completed',output,usage:{output_tokens:56}}});
 const usage=transport==='chat'?event({choices:[],usage:{completion_tokens:56}}):': keepalive\n\n';
 for(const scenario of ['success','single-delta','buffered-delayed-terminal','same-batch','reasoning','missing-terminal','failed','bad-final'] as const) test(`${transport}: completion timing ${scenario}`,async t=>{
  let now=0,index=0;const records:ModelRequestRecord[]=[];
  t.mock.method(performance,'now',()=>now);
  // Reproduce production's tiny first-to-last-delta interval; delayed usage and
  // protocol completion must be in the denominator, not mistaken for output.
  let chunks:Array<[number,string]>=scenario==='buffered-delayed-terminal'?[[1207,first+last],[1350,usage],[1375,terminal]]:[[1207,first],[1207.3669,last],[1350,usage],[1375,terminal]];
  if(scenario==='single-delta')chunks=[[1207,transport==='chat'?event({choices:[{index:0,delta:{content:'hello'},finish_reason:'stop'}]}):event({type:'response.output_text.delta',output_index:0,content_index:0,delta:'hello'})],[1350,usage],[1375,terminal]];
  if(scenario==='same-batch')chunks=[[1207,first+last+usage+terminal]];
  if(scenario==='reasoning'){
   const reasoning=transport==='chat'?event({choices:[{index:0,delta:{reasoning_content:'think'},finish_reason:null}]}):event({type:'response.reasoning_text.delta',output_index:1,content_index:0,delta:'think'});
   const reasoningUsage=transport==='chat'?event({choices:[],usage:{completion_tokens:56,completion_tokens_details:{reasoning_tokens:30}}}):usage;
   const reasoningEnd=transport==='chat'?terminal:event({type:'response.completed',response:{id:'r',status:'completed',output:[...output,{type:'reasoning',content:[{type:'reasoning_text',text:'think'}],encrypted_content:'opaque'}],usage:{output_tokens:56,output_tokens_details:{reasoning_tokens:30}}}});
   chunks=[[1207,reasoning],[1210,first+last],[1350,reasoningUsage],[1375,reasoningEnd]];
  }
  if(scenario==='missing-terminal')chunks=chunks.slice(0,-1);
  if(scenario==='failed')chunks[chunks.length-1]=[1375,transport==='chat'?event({error:{message:'failure'}}):event({type:'response.failed',response:{id:'r',status:'failed',error:{message:'failure'},output}})];
  if(scenario==='bad-final')chunks[chunks.length-1]=[1375,transport==='chat'?event({choices:[{index:0,delta:{content:'after finish'},finish_reason:null}]})+terminal:event({type:'response.completed',response:{id:'r',status:'completed',output:[{...output[0],content:[{type:'output_text',text:'conflict'}]}]}})];
  t.mock.method(globalThis,'fetch',async()=>new Response(new ReadableStream<Uint8Array>({pull(c){if(index===chunks.length){c.close();return;}const [at,text]=chunks[index++]!;now=at;c.enqueue(new TextEncoder().encode(text));}},{highWaterMark:0}),{headers:{'content-type':'text/event-stream'}}));
  const model=transport==='chat'?new OpenAIModel({...options,onRequest:r=>records.push(r)}):new ResponsesModel({...options,onRequest:r=>records.push(r)});
  if(['failed','missing-terminal','bad-final'].includes(scenario))await assert.rejects(model.complete([]));else assert.equal((await model.complete([])).content,'hello');
  assert.equal(records.length,1);assert.equal(records[0]!.ttftMs,1207);
  assert.equal(records[0]!.decodeDurationMs,['failed','missing-terminal','bad-final'].includes(scenario)?null:scenario==='same-batch'?0:168);
  if(scenario==='reasoning'){assert.equal(records[0]!.usage.reasoningTokens,30);assert.equal(records[0]!.usage.outputTokens,56);}
  if(scenario==='success')assert.equal(records[0]!.usage.outputTokens,56);
 });
}
