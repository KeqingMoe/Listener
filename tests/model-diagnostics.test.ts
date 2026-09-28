import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeModelRequestDiagnostics as normalize, providerDiagnostics } from '../src/model-diagnostics.js';
import { ModelError, OpenAIModel } from '../src/model.js';
import { ResponsesModel, ResponseStateExpiredError } from '../src/responses-model.js';
import type { ModelRequestRecord } from '../src/model-usage.js';
import type { ChatMessage } from '../src/contracts.js';

const options={baseUrl:'https://invalid.example/v1',apiKey:'secret-key',model:'test',timeoutMs:1000,maxTokens:100,sessionId:'test'};
const chat=()=>new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'ok'},finish_reason:'stop'}]}));
const response=()=>new Response(JSON.stringify({id:'secret-response-id',status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:'ok'}]}]}));

test('diagnostics projects only exact own data fields without executing getters or proxies',()=>{
  let reads=0;
  const value=Object.create({abortSource:'reset'});
  Object.defineProperty(value,'providerCategory',{get(){reads++;throw Error();}});
  value.requestMode='fresh';value.requestTimeoutMs=2147483647;value.message='secret';value.failureStage='secret';
  assert.deepEqual(normalize(value),{requestMode:'fresh',requestTimeoutMs:2147483647});
  const proxy=new Proxy({}, {getOwnPropertyDescriptor(){reads++;throw Error();},get(){reads++;throw Error();},ownKeys(){reads++;throw Error();}});
  assert.equal(normalize(proxy),undefined);
  const revoked=Proxy.revocable({},{});revoked.revoke();assert.equal(normalize(revoked.proxy),undefined);
  for(const requestTimeoutMs of [0,-1,1.5,NaN,Infinity,2147483648,'100'])assert.equal(normalize({requestTimeoutMs}),undefined);
  assert.equal(reads,0);
  assert.deepEqual(providerDiagnostics({error:{code:'__proto__',type:'constructor',param:'secret',message:'context length exceeded'}}),{providerCategory:'unknown',providerParameter:'other'});
  assert.deepEqual(providerDiagnostics({error:{code:'context_length_exceeded',param:'input',message:'secret'}}),{providerCategory:'context_limit',providerParameter:'input'});
  const e=new ModelError('http_error',400,{requestMode:'fresh',...{message:'secret'}});assert.ok(!JSON.stringify(e).includes('secret'));
});

for(const transport of ['chat','responses'] as const){
  const make=(records:ModelRequestRecord[],timeoutMs=1000)=>transport==='chat'?new OpenAIModel({...options,timeoutMs,onRequest:r=>{records.push(r);throw Error('observer-secret');}}):new ResponsesModel({...options,timeoutMs,onRequest:r=>{records.push(r);throw Error('observer-secret');}});
  test(`${transport}: HTTP failure diagnostics preserve codes and reject private provider text`,async t=>{
    for(const body of ['secret non-json',JSON.stringify({error:{code:'secret-code',type:'secret-type',param:'secret-param',message:'previous_response_not_found secret',headers:'secret',cause:'secret'}}),JSON.stringify({error:{code:'context_length_exceeded',param:'input',message:'secret'}}),'x'.repeat(2200000)]){
      const records:ModelRequestRecord[]=[];t.mock.method(globalThis,'fetch',async()=>new Response(body,{status:400}));
      await assert.rejects(make(records).complete([]),(e:any)=>e.code==='http_error'&&e.httpStatus===400&&e.diagnostics.failureStage==='http_status'&&!JSON.stringify(e).includes('secret'));
      assert.equal(records.length,1);assert.equal(records[0].errorCode,'http_error');assert.ok(!JSON.stringify(records.map(({inspection,...publicRecord})=>publicRecord)).includes('secret'));assert.ok(!JSON.stringify(records).includes(options.apiKey));assert.equal(records[0].diagnostics?.requestMode,'fresh');
      if(body.startsWith('secret'))assert.ok(records[0].inspection?.errorText?.includes('secret non-json'));
      if(transport==='chat'){assert.equal(records[0].diagnostics?.providerCategory,'unknown');assert.equal(records[0].diagnostics?.providerParameter,undefined);}
      t.mock.restoreAll();
    }
  });
  test(`${transport}: abort sources are exact and first timer/upstream reason wins even with late ACK`,async t=>{
    for(const first of ['turn_timeout','disconnected','reset','shutdown','secret',new Error('secret'),'timer']){
      const records:ModelRequestRecord[]=[];const upstream=new AbortController();
      if(first!=='timer')upstream.abort(first);
      t.mock.method(globalThis,'fetch',async()=>{await new Promise(r=>setTimeout(r,15));upstream.abort('shutdown');return transport==='chat'?chat():response();});
      await assert.rejects(make(records,5).complete([],[],upstream.signal),(e:any)=>{
        assert.equal(e.code,first==='timer'?'timeout':'cancelled');
        assert.equal(e.diagnostics.abortSource,first==='timer'?'request_timeout':typeof first==='string'&&['turn_timeout','disconnected','reset','shutdown'].includes(first)?first:'external_unknown');return true;
      });
      assert.equal(records.length,1);assert.equal(records[0].diagnostics?.requestTimeoutMs,5);assert.ok(!JSON.stringify(records.map(({inspection,...publicRecord})=>publicRecord)).includes('secret'));assert.ok(!JSON.stringify(records).includes(options.apiKey));
      t.mock.restoreAll();
    }
  });
  test(`${transport}: stalled response body timeout retains first request timeout reason`,async t=>{
    const records:ModelRequestRecord[]=[];const upstream=new AbortController();
    t.mock.method(globalThis,'fetch',async(_url:unknown,init?:RequestInit)=>new Response(new ReadableStream({start(controller){
      init?.signal?.addEventListener('abort',()=>{upstream.abort('shutdown');controller.error(Error('secret-body'));},{once:true});
    }})));
    await assert.rejects(make(records,5).complete([],[],upstream.signal),(e:any)=>e.code==='timeout'&&e.diagnostics.abortSource==='request_timeout'&&e.diagnostics.failureStage==='response_body');
    assert.equal(records[0].diagnostics?.abortSource,'request_timeout');
  });
  test(`${transport}: successful late acknowledgement before budget preserves result despite observer`,async t=>{
    const records:ModelRequestRecord[]=[];
    t.mock.method(globalThis,'fetch',async()=>{await new Promise(r=>setTimeout(r,5));return transport==='chat'?chat():response();});
    assert.equal((await make(records).complete([])).content,'ok');assert.equal(records[0].status,'success');assert.equal(records[0].diagnostics?.failureStage,undefined);
  });
  test(`${transport}: parse, validation and network stages`,async t=>{
    for(const [kind,stage] of [['parse','response_parse'],['validate','response_validate'],['network','request'],['body','response_body']] as const){
      const records:ModelRequestRecord[]=[];t.mock.method(globalThis,'fetch',async()=>{if(kind==='network')throw Error('secret');return kind==='body'?new Response(null):new Response(kind==='parse'?'secret':'{}');});
      await assert.rejects(make(records).complete([]),(e:any)=>e.diagnostics.failureStage===stage);assert.equal(records[0].diagnostics?.failureStage,stage);t.mock.restoreAll();
    }
  });
}

test('Chat cancels stalled HTTP 400 body immediately without waiting for request or wake deadlines',async t=>{
  for(const wakeDeadline of [false,true]){
    const records:ModelRequestRecord[]=[];const upstream=new AbortController();let cancelled=false;
    t.mock.method(globalThis,'fetch',async(_url:unknown,init?:RequestInit)=>new Response(new ReadableStream({
      start(controller){init?.signal?.addEventListener('abort',()=>controller.error(Error('secret-body')),{once:true});},
      cancel(){cancelled=true;},
    }),{status:400}));
    const wake=wakeDeadline?setTimeout(()=>upstream.abort('turn_timeout'),100):undefined;
    try{
      const model=new OpenAIModel({...options,timeoutMs:250,onRequest:r=>records.push(r)});
      await assert.rejects(model.complete([],[],upstream.signal),(e:any)=>e.code==='http_error'&&e.httpStatus===400&&e.diagnostics.providerCategory==='unknown'&&e.diagnostics.failureStage==='http_status'&&e.diagnostics.abortSource===undefined);
      assert.equal(cancelled,true);assert.equal(upstream.signal.aborted,false);
      assert.equal(records[0].errorCode,'http_error');assert.equal(records[0].diagnostics?.abortSource,undefined);
    }finally{clearTimeout(wake);t.mock.restoreAll();}
  }
});

test('Responses records fresh/live/restored requests and preserves expiry marker without retries',async t=>{
  const records:ModelRequestRecord[]=[];let requests=0;
  t.mock.method(globalThis,'fetch',async()=>{requests++;return response();});
  const model=new ResponsesModel({...options,onRequest:r=>records.push(r)});
  const initial:ChatMessage[]=[{role:'user',content:'secret-prompt'}];
  await model.complete(initial);
  const next:ChatMessage[]=[...initial,{role:'assistant',content:'ok'},{role:'user',content:'next'}];
  await model.complete(next);
  const checkpoint=model.getContinuationCheckpoint();assert.ok(checkpoint);
  const restored=new ResponsesModel({...options,onRequest:r=>records.push(r)});restored.restoreContinuationCheckpoint(checkpoint);
  const continuation:ChatMessage[]=[...next,{role:'assistant',content:'ok'},{role:'user',content:'again'}];
  await restored.complete(continuation);
  assert.deepEqual(records.map(r=>r.diagnostics?.requestMode),['fresh','continue_live','continue_restored']);
  t.mock.restoreAll();t.mock.method(globalThis,'fetch',async()=>{requests++;return new Response(JSON.stringify({error:{code:'previous_response_not_found',param:'previous_response_id',message:'secret'}}),{status:400});});
  await assert.rejects(restored.complete([...continuation,{role:'assistant',content:'ok'},{role:'user',content:'last'}]),(e:any)=>e instanceof ResponseStateExpiredError&&e.code==='invalid_response'&&e.diagnostics?.providerCategory==='previous_response_missing');
  assert.equal(requests,4);assert.equal(records[3].errorCode,'invalid_response');assert.ok(!JSON.stringify(records.map(({inspection,...publicRecord})=>publicRecord)).includes('secret'));assert.ok(!JSON.stringify(records).includes(options.apiKey));
});

test('Responses generation mismatch diagnoses cancellation without overwriting upstream reason',async t=>{
  const records:ModelRequestRecord[]=[];const model=new ResponsesModel({...options,onRequest:r=>records.push(r)});
  t.mock.method(globalThis,'fetch',async()=>{model.reset();return response();});
  await assert.rejects(model.complete([]),(e:any)=>e.code==='cancelled'&&e.diagnostics.abortSource==='generation_changed'&&e.diagnostics.failureStage==='post_response');
  assert.equal(records[0].diagnostics?.abortSource,'generation_changed');
});
