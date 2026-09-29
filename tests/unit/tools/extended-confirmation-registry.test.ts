import test from 'node:test';
import assert from 'node:assert/strict';
import type { Api } from '../../../src/contracts/onebot.js';
import type { JsonObject } from '../../../src/contracts/json.js';
import type { Memory } from '../../../src/contracts/messages.js';
import type { ToolDefinition, TurnContext } from '../../../src/contracts/tools.js';
import { LISTENER_GROUP } from '../../../src/contracts/identity.js';
import { createExtendedTools, buildExtendedToolDefinitions } from '../../../src/tools/extended.js';
import { EXTENDED_TOOL_NAMES, EXTENDED_READ_ONLY_TOOLS, type ExtendedToolsConfig } from '../../../src/config/extended-tools.js';
import { GroupFileTools, GROUP_FILE_TOOL_NAMES } from '../../../src/tools/files/tools.js';
import { GroupRequestTools, GROUP_REQUEST_TOOL_NAMES } from '../../../src/tools/requests/tools.js';

const context: TurnContext = {groupId:LISTENER_GROUP, actorId:'123', selfId:'999', messageId:'11'};
const scheduledWrites = ['create_reminder','update_reminder','cancel_reminder'] as const;
const SANDBOX = ['execute_javascript','query_javascript_jobs','cancel_javascript_job'] as const;
const writes = EXTENDED_TOOL_NAMES.filter(name=>!EXTENDED_READ_ONLY_TOOLS.includes(name)&&!(scheduledWrites as readonly string[]).includes(name)&&!(SANDBOX as readonly string[]).includes(name));
const memory: Memory = {recent:()=>[],find:()=>undefined,append:()=>false,context:()=>'',async compact(){},clear(){},close(){}};
function source(){let calls=0;const api:Api={async call(){calls++;throw new Error('unexpected native call PRIVATE');}};return {api,get calls(){return calls;}};}

// Deliberately bypass the TOML loader: this guard must live in the dispatch layer.
test('all 25 write capabilities fail closed in confirm mode without a confirmation adapter',async()=>{
  assert.equal(writes.length,25);
  assert.equal(SANDBOX.length,3);
  for(const name of writes){
    const native=source(),config:ExtendedToolsConfig={[name]:'confirm'};
    const registry=createExtendedTools(native.api,memory,LISTENER_GROUP,config);
    assert.equal(registry.has(name),true,name);assert.equal(registry.isSideEffect(name),true,name);
    assert.deepEqual(await registry.execute(name,{},context),{status:'error',error:'confirmation_unavailable'},name);
    assert.equal(native.calls,0,name);
    const definitions=registry.definitions();assert.equal(definitions.length,1,name);assert.match(definitions[0]!.function.description,/当前模式confirm/);
    const schema=buildExtendedToolDefinitions(LISTENER_GROUP,config);
    assert.deepEqual(schema,definitions,name);
    assert.deepEqual(schema[0]!.function.parameters,buildExtendedToolDefinitions(LISTENER_GROUP,{[name]:'direct'})[0]!.function.parameters,name);
  }
});

test('all confirm write handlers route only to the adapter and retain original tool identity and context',async()=>{
  for(const name of writes){
    const native=source(),args={synthetic:'parent validates before proposing'},controller=new AbortController();
    let seen:{name:string;args:unknown;definition:ToolDefinition;context:TurnContext;signal?:AbortSignal}|undefined;
    const result:JsonObject={status:'confirmation_required',code:'fixture-token',expires_in_seconds:60,description:'synthetic'};
    const registry=createExtendedTools(native.api,memory,LISTENER_GROUP,{[name]:'confirm'},{
      async requestConfirmation(tool,args,definition,context,signal){seen={name:tool,args,definition,context,signal};return result;},
    });
    assert.deepEqual(await registry.execute(name,args,context,controller.signal),result,name);
    assert.equal(seen!.name,name);assert.equal(seen!.args,args);assert.deepEqual(seen!.context,context);assert.equal(seen!.signal,controller.signal);
    assert.equal(seen!.definition.function.name,name);assert.match(seen!.definition.function.description,/当前模式confirm/);assert.equal(native.calls,0,name);
  }
});

test('all read-only capabilities reject confirm rather than becoming directly executable',()=>{
  assert.equal(EXTENDED_READ_ONLY_TOOLS.length,20);
  for(const name of SANDBOX) {
    assert.equal(EXTENDED_READ_ONLY_TOOLS.includes(name),name==='query_javascript_jobs');
    assert.throws(()=>createExtendedTools(source().api,memory,LISTENER_GROUP,{[name]:'confirm'}),/(?:Read-only|Sandbox) tools do not support mutation confirmation/);
  }
  for(const name of EXTENDED_READ_ONLY_TOOLS){
    const native=source();
    assert.throws(()=>createExtendedTools(native.api,memory,LISTENER_GROUP,{[name]:'confirm'}),/(?:Read-only|Sandbox) tools do not support mutation confirmation/,name);
    assert.throws(()=>buildExtendedToolDefinitions(LISTENER_GROUP,{[name]:'confirm'}),/(?:Read-only|Sandbox) tools do not support mutation confirmation/,name);
    assert.equal(native.calls,0,name);
  }
});

test('sandbox tools publish schemas, mark only query readonly, and never support confirmation',()=>{
  for(const name of SANDBOX){
    const native=source(),registry=createExtendedTools(native.api,memory,LISTENER_GROUP,{[name]:'direct'});
    assert.equal(registry.has(name),true,name);
    assert.equal(registry.isSideEffect(name),name!=='query_javascript_jobs',name);
    const schema=buildExtendedToolDefinitions(LISTENER_GROUP,{[name]:'direct'});
    assert.deepEqual(schema,registry.definitions(),name);
    assert.equal(schema.length,1,name);assert.equal(schema[0]!.function.name,name);
    assert.equal(schema[0]!.function.parameters.additionalProperties,false,name);
    assert.throws(()=>createExtendedTools(native.api,memory,LISTENER_GROUP,{[name]:'confirm'},{async requestConfirmation(){throw new Error('must not propose');}}));
    assert.throws(()=>buildExtendedToolDefinitions(LISTENER_GROUP,{[name]:'confirm'}));assert.equal(native.calls,0,name);
  }
});

test('scheduled reminder writes reject confirm even when a confirmation adapter exists',()=>{
 for(const name of scheduledWrites){const native=source();assert.throws(()=>createExtendedTools(native.api,memory,LISTENER_GROUP,{[name]:'confirm'},{async requestConfirmation(){throw new Error('must not propose');}}));assert.throws(()=>buildExtendedToolDefinitions(LISTENER_GROUP,{[name]:'confirm'}));assert.equal(native.calls,0);}
});

test('disabled tools cannot use the adapter as a backdoor and omitted modes remain disabled',async()=>{
  for(const name of EXTENDED_TOOL_NAMES){
    for(const config of [undefined,{[name]:'off'} as ExtendedToolsConfig]){
      const native=source();let proposals=0;
      const registry=createExtendedTools(native.api,memory,LISTENER_GROUP,config,{async requestConfirmation(){proposals++;return {status:'confirmation_required'};}});
      assert.equal(registry.has(name),false,name);
      assert.deepEqual(await registry.execute(name,{},context),{status:'error',error:'tool_disabled'},name);
      assert.equal(proposals,0,name);assert.equal(native.calls,0,name);
    }
  }
});

test('adapter throws stay sanitized errors and never fall back to direct writes',async()=>{
  for(const name of writes){
    const native=source();let attempts=0;
    const registry=createExtendedTools(native.api,memory,LISTENER_GROUP,{[name]:'confirm'},{async requestConfirmation(){attempts++;throw new Error('PRIVATE https://secret');}});
    assert.deepEqual(await registry.execute(name,{},context),{status:'error',error:'confirmation_failed'},name);
    assert.equal(attempts,1,name);assert.equal(native.calls,0,name);
  }
});

test('cancelled calls never propose or dispatch and reject even when adapter exists',async()=>{
  const native=source(),controller=new AbortController();controller.abort('PRIVATE');let proposals=0;
  const config=Object.fromEntries(writes.map(name=>[name,'confirm'])) as ExtendedToolsConfig;
  const registry=createExtendedTools(native.api,memory,LISTENER_GROUP,config,{async requestConfirmation(){proposals++;return {status:'confirmation_required'};}});
  for(const name of writes)assert.deepEqual(await registry.execute(name,{},context,controller.signal),{status:'error',error:'cancelled'},name);
  assert.equal(proposals,0);assert.equal(native.calls,0);
});

test('persistent file and request instances cannot bypass the confirm wrapper',async()=>{
  const native=source(),files=new GroupFileTools(native.api,LISTENER_GROUP,[...GROUP_FILE_TOOL_NAMES]),requests=new GroupRequestTools(native.api,LISTENER_GROUP,[...GROUP_REQUEST_TOOL_NAMES]);
  const names=writes.filter(name=>GROUP_FILE_TOOL_NAMES.includes(name as typeof GROUP_FILE_TOOL_NAMES[number])||GROUP_REQUEST_TOOL_NAMES.includes(name as typeof GROUP_REQUEST_TOOL_NAMES[number]));
  assert.equal(names.length,5);
  for(const name of names){
    const registry=createExtendedTools(native.api,memory,LISTENER_GROUP,{[name]:'confirm'},{files,requests});
    assert.deepEqual(await registry.execute(name,{},context),{status:'error',error:'confirmation_unavailable'},name);
    assert.equal(native.calls,0,name);
  }
});
