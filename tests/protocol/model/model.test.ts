import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { OpenAIModel } from '../../../src/model/chat.ts';
import type { ToolDefinition } from '../../../src/contracts/tools.ts';

test('request observer sees charged truncated usage once and cannot mask model errors',async()=>{
  const fixture=await server((_req,res)=>res.end(JSON.stringify({...reply({role:'assistant',content:'secret-body'},'length'),usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_cache_hit_tokens:60}})));
  const records:import('../../../src/observability/model-usage.ts').ModelRequestRecord[]=[];
  try {const model=new OpenAIModel({baseUrl:fixture.url,apiKey:secret,model:'test-model',timeoutMs:1000,maxTokens:100,onRequest:r=>{records.push(r);throw Error('observer secret');}});
    await assert.rejects(model.complete([{role:'user',content:'secret-prompt'}]),(e:unknown)=>(e as any).code==='truncated_response');
    assert.equal(records.length,1);assert.equal(records[0]!.usage.cachedInputTokens,60);assert.equal(records[0]!.errorCode,'truncated_response');assert.ok(!JSON.stringify(records.map(({inspection,...publicRecord})=>publicRecord)).includes('secret'));assert.ok(records[0]!.inspection?.requestJson?.includes('secret-prompt'));assert.ok(records[0]!.inspection?.responseJson?.includes('secret-body'));assert.ok(!JSON.stringify(records).includes(secret));
  }finally{stop(fixture.server);}
});
test('observer throwing does not alter successful completion',async()=>{
  const fixture=await server((_req,res)=>res.end(JSON.stringify(reply({role:'assistant',content:'ok'}))));let calls=0;
  try{const model=new OpenAIModel({baseUrl:fixture.url,apiKey:secret,model:'test-model',timeoutMs:1000,maxTokens:100,onRequest:r=>{calls++;assert.equal(r.status,'success');assert.equal(r.usage.inputTokens,null);throw Error();}});assert.equal((await model.complete([])).content,'ok');assert.equal(calls,1);}finally{stop(fixture.server);}
});
const secret = 'secret-test-token-never-log';
const tool: ToolDefinition = { type: 'function', function: { name: 'lookup', description: 'lookup', parameters: { type: 'object' } } };
const reply = (message: unknown, finish_reason = 'stop') => ({ choices: [{ message, finish_reason }] });
async function server(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ server: Server; model: OpenAIModel; url: string }> {
  const server = createServer((req,res)=>{
    const end=res.end.bind(res);
    res.end=((value?:any,...args:any[])=>{if(res.statusCode===200&&typeof value==='string'){try{const raw=JSON.parse(value);if(raw?.choices){res.setHeader('content-type','text/event-stream');value='data: '+JSON.stringify({...raw,choices:raw.choices.map((c:any)=>({...c,index:0,delta:{...c.message,tool_calls:Array.isArray(c.message?.tool_calls)?c.message.tool_calls.map((t:any,index:number)=>({...t,index})):c.message?.tool_calls},message:undefined}))})+'\n\ndata: [DONE]\n\n';}}catch{}}return end(value,...args);}) as any;
    handler(req,res);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/v1`;
  return { server, url, model: new OpenAIModel({ baseUrl: url, apiKey: secret, model: 'test-model', timeoutMs: 1000, maxTokens: 100 }) };
}
function stop(server: Server): void { server.closeAllConnections(); server.close(); }

test('native HTTP sends compatible tools and parses content/tool calls', async () => {
  let captured: Record<string, any> = {};
  const fixture = await server((req, res) => {
    assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      captured = JSON.parse(body);
      res.end(JSON.stringify(reply({ role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{"id":"1"}' } }] }, 'tool_calls')));
    });
  });
  try {
    const result = await fixture.model.complete([{ role: 'user', content: 'hello' }], [tool]);
    assert.equal(result.tool_calls[0]?.function.name, 'lookup'); assert.equal(result.content, null);
    assert.equal(captured.stream, true);assert.deepEqual(captured.stream_options,{include_usage:true}); assert.equal(captured.max_tokens, 100); assert.deepEqual(captured.tools, [tool]);
  } finally { stop(fixture.server); }
});

test('native image content arrays are serialized as image_url blocks, not text', async () => {
  let captured: any;
  const image='data:image/jpeg;base64,/9j/2Q==';
  const fixture=await server((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{captured=JSON.parse(body);res.end(JSON.stringify(reply({role:'assistant',content:'看到了'})));});});
  try {
    await fixture.model.complete([{role:'user',content:[{type:'text',text:'附件来源：消息123'},{type:'image_url',image_url:{url:image}}]}]);
    assert.equal(captured.model,'test-model');assert.ok(Array.isArray(captured.messages[0].content));
    assert.deepEqual(captured.messages[0].content[1],{type:'image_url',image_url:{url:image}});
  } finally {stop(fixture.server);}
});

test('rejects malformed envelopes, oversized, excessive and truncated responses without leaking secrets', async () => {
  const call = { id: 'x', type: 'function', function: { name: 'lookup', arguments: '{}' } };
  const cases: unknown[] = [
    { error: secret }, reply({ role: 'assistant', content: 42 }),
    reply({ role: 'assistant', content: null, tool_calls: null }),
    reply({ role: 'assistant', content: 'partial' }, 'length'),
    reply({ role: 'assistant', content: null, tool_calls: Array.from({ length: 9 }, (_, n) => ({ ...call, id: String(n) })) }, 'tool_calls'),
    ...['', 'x'.repeat(129), 'lookup\n'].map(name => reply({ role: 'assistant', tool_calls: [{ ...call, function: { name, arguments: '{}' } }] }, 'tool_calls')),
    reply({ role: 'assistant', tool_calls: [{ ...call, function: { name: 'lookup', arguments: {} } }] }, 'tool_calls'),
    reply({ role: 'assistant', content: null, tool_calls: [{ ...call, function: { name: 'lookup', arguments: JSON.stringify({ x: 'a'.repeat(17000) }) } }] }, 'tool_calls'),
    reply({ role: 'assistant', content: null, tool_calls: [call, call] }, 'tool_calls'),
    reply({ role: 'assistant', content: 'a'.repeat(270000) }),
  ];
  for (const value of cases) {
    let requests = 0;
    const fixture = await server((_req, res) => { requests++; res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify(value)+'\n\ndata: [DONE]\n\n'); });
    try {
      await assert.rejects(fixture.model.complete([], [tool]), e => e instanceof Error && e.message === 'Model request failed' && !String(e).includes(secret));
      assert.equal(requests, 1);
    } finally { stop(fixture.server); }
  }
});

test('bounded unknown tools and invalid argument JSON reach the dispatcher unchanged',async()=>{
 for(const name of ['lookup','not_advertised'])for(const args of ['{','[]','null','42','"literal"','']){
  const toolCall={id:'x',type:'function',function:{name,arguments:args}};
  const fixture=await server((_req,res)=>res.end(JSON.stringify(reply({role:'assistant',tool_calls:[toolCall]},'tool_calls'))));
  try{const result=await fixture.model.complete([],[tool]);assert.deepEqual(result.tool_calls,[toolCall]);}finally{stop(fixture.server);}
 }
});

test('plain summary completion omits tools; invalid JSON and chunked oversized bodies fail', async () => {
  for (const kind of ['plain', 'invalid', 'oversized']) {
    const fixture = await server((req, res) => {
      let body = ''; req.on('data', c => body += c); req.on('end', () => {
        assert.equal(JSON.parse(body).tools, undefined);
        if (kind === 'plain') res.end(JSON.stringify(reply({ role: 'assistant', content: 'summary' })));
        else if (kind === 'invalid') res.end('{not JSON: ' + secret);
        else { res.write('x'.repeat(270000)); res.end(); }
      });
    });
    try {
      if (kind === 'plain') assert.deepEqual(await fixture.model.complete([]), { content: 'summary', tool_calls: [] });
      else await assert.rejects(fixture.model.complete([]), /Model request failed/);
    } finally { stop(fixture.server); }
  }
});

test('HTTP errors and redirects are safe and never retried or followed', async () => {
  for (const status of [401, 429, 500, 302]) {
    let requests = 0;
    const fixture = await server((_req, res) => { requests++; res.writeHead(status, { location: '/stolen' }); res.end(secret); });
    try { await assert.rejects(fixture.model.complete([]), /Model request failed/); assert.equal(requests, 1); }
    finally { stop(fixture.server); }
  }
});

test('timeout covers stalled body and caller abort is redacted', async () => {
  const fixture = await server((_req, res) => { res.writeHead(200,{'content-type':'text/event-stream'}); res.write('data: {'); });
  try {
    const model = new OpenAIModel({ baseUrl: fixture.url, apiKey: secret, model: 'test', timeoutMs: 40, maxTokens: 10 });
    await assert.rejects(model.complete([]), /aborted or timed out/);
    const controller = new AbortController(); controller.abort(new Error(secret));
    await assert.rejects(model.complete([], [], controller.signal), e => e instanceof Error && !e.message.includes(secret) && /aborted/.test(e.message));
  } finally { stop(fixture.server); }
});

test('streamed reasoning and text are timed across distinct reads; one buffered batch still records completion interval',async()=>{
 for(const delayed of [false,true]){const records:import('../../../src/observability/model-usage.ts').ModelRequestRecord[]=[];
 const fixture=await server((_req,res)=>{res.setHeader('content-type','text/event-stream');const a='data: '+JSON.stringify({choices:[{index:0,delta:{reasoning_content:'think'},finish_reason:null}]})+'\n\n';const b='data: '+JSON.stringify({choices:[{index:0,delta:{content:'answer'},finish_reason:'stop'}],usage:{completion_tokens:4}})+'\n\ndata: [DONE]\n\n';if(delayed){res.write(a);setTimeout(()=>res.end(b),30);}else res.end(a+b);});
 try{const m=new OpenAIModel({baseUrl:fixture.url,apiKey:secret,model:'x',maxTokens:100,timeoutMs:1000,onRequest:r=>records.push(r)});assert.equal((await m.complete([])).content,'answer');assert.ok(records[0].ttftMs!>=0);if(delayed)assert.ok(records[0].decodeDurationMs!>=10);else assert.equal(records[0].decodeDurationMs,0);assert.equal(records[0].inspection?.reasoningText,'think');}finally{stop(fixture.server);}
 }
});
test('rejects JSON success, missing DONE, missing finish and malformed SSE without retries',async()=>{
 for(const text of ['{}','data: {}\n\n','data: '+JSON.stringify({choices:[{index:0,delta:{content:'x'}}]})+'\n\ndata: [DONE]\n\n','data: not-json\n\n']){const fixture=await server((_req,res)=>{res.setHeader('content-type','text/event-stream');res.end(text);});try{await assert.rejects(fixture.model.complete([]));}finally{stop(fixture.server);}}
});

test('rejects wrong choice, function type, conflicting ids, post-finish output and MIME substring',async()=>{
 const frame=(delta:any,index=0,finish_reason:any=null)=>({choices:[{index,delta,finish_reason}]});
 const tool=(id:string,type='function')=>({tool_calls:[{index:0,id,type,function:{name:'lookup',arguments:'{}'}}]});
 const cases=[ [frame({content:'x'},1,'stop')], [frame(tool('a','custom'),0,'tool_calls')], [frame(tool('a')),frame(tool('b'),0,'tool_calls')], [frame({content:'a'},0,'stop'),frame({content:'b'})] ];
 for(const events of cases){const fixture=await server((_q,res)=>{res.setHeader('content-type','text/event-stream');res.end(events.map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+'data: [DONE]\n\n');});try{await assert.rejects(fixture.model.complete([]));}finally{stop(fixture.server);}}
 const fixture=await server((_q,res)=>{res.setHeader('content-type','application/text/event-stream-fake');res.end('data: '+JSON.stringify(frame({content:'x'},0,'stop'))+'\n\ndata: [DONE]\n\n');});try{await assert.rejects(fixture.model.complete([]));}finally{stop(fixture.server);}
});
test('charged reasoning remains measurable and repeated equal tool IDs are not concatenated',async()=>{
 for(const hidden of [false,true]){let record:import('../../../src/observability/model-usage.ts').ModelRequestRecord|undefined;
 const fixture=await server((_q,res)=>{res.setHeader('content-type','text/event-stream');res.write('data: '+JSON.stringify({choices:[{index:0,delta:{tool_calls:[{index:0,id:'call-a',type:'function',function:{name:'lookup',arguments:'{'}}]},finish_reason:null}]})+'\n\n');setTimeout(()=>res.end('data: '+JSON.stringify({choices:[{index:0,delta:{tool_calls:[{index:0,id:'call-a',function:{arguments:'}'}}]},finish_reason:'tool_calls'}],usage:{completion_tokens:10,completion_tokens_details:{reasoning_tokens:hidden?5:0}}})+'\n\ndata: [DONE]\n\n'),30);});
 try{const model=new OpenAIModel({baseUrl:fixture.url,apiKey:secret,model:'x',maxTokens:100,timeoutMs:1000,onRequest:r=>{record=r;}});const out=await model.complete([]);assert.equal(out.tool_calls[0].id,'call-a');assert.equal(out.tool_calls[0].function.arguments,'{}');assert.ok(record!.decodeDurationMs!>10);}finally{stop(fixture.server);}}
});

test('accepts large SSE framing when assembled content stays bounded',async()=>{
 const text='x';const fixture=await server((_q,res)=>{res.setHeader('content-type','text/event-stream');const events=Array.from({length:4000},()=>`data: ${JSON.stringify({choices:[{index:0,delta:{content:text},finish_reason:null}]})}\n\n`).join('');res.end(events+`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{completion_tokens:400000}})}\n\ndata: [DONE]\n\n`);});
 try{const result=await fixture.model.complete([]);assert.equal(result.content,text.repeat(4000));}finally{stop(fixture.server);}
});
test('validates trusted endpoint URL policy without echoing credentials', () => {
  for (const baseUrl of ['http://example.com/v1', 'https://user:password@example.com', 'https://example.com/?token=' + secret, 'https://example.com/#' + secret, 'file:///tmp/model', 'not a URL']) {
    assert.throws(() => new OpenAIModel({ baseUrl, apiKey: secret, model: 'test', timeoutMs: 1, maxTokens: 1 }), /Invalid model configuration/);
  }
  for (const baseUrl of ['http://localhost:1234/v1', 'http://[::1]:1234/v1', 'https://example.com/v1']) {
    assert.doesNotThrow(() => new OpenAIModel({ baseUrl, apiKey: secret, model: 'test', timeoutMs: 1, maxTokens: 1 }));
  }
});
