import test from 'node:test';
import {withFixtureModel} from '../../support/config-fixture.js';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadAppConfig,ConfigError} from '../../../src/config/loader.js';
import type {AppConfig} from '../../../src/config/app.js';
function fixture(t:{after(fn:()=>void):void}){
  const dir=mkdtempSync(join(tmpdir(),'execution-policy-config-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  mkdirSync(join(dir,'prompts'));writeFileSync(join(dir,'prompts/listener.md'),'persona');
  return(source:string):AppConfig=>{writeFileSync(join(dir,'config.toml'),withFixtureModel(source));return loadAppConfig({configPath:join(dir,'config.toml'),env:{ONEBOT_ACCESS_TOKEN:'fixture',OPENAI_API_KEY:'fixture-model-key'}});};
}
test('execution defaults are 96 calls and 240 seconds for configured and dynamic groups',t=>{
  const app=fixture(t)('[groups."11"]\n[groups."22"]');
  for(const id of ['11','22','99']){const g=app.resolveGroup(id);assert.deepEqual(g.execution,{maxToolCallsPerWake:96,wakeTimeoutMs:240000});assert.equal(g.enabled,false);}
  assert.equal(app.model.maxTokens,32768);assert.equal(app.runtime.maxConcurrentTurns,2);
});
test('execution inherits ordinary fields independently and contains no model credentials',t=>{
  const app=fixture(t)('[model]\nmodel="synthetic-model"\nmax_output_tokens=16384\ntransport="responses"\n[runtime]\nmax_concurrent_turns=3\n[defaults.execution]\nmax_tool_calls_per_wake=128\nwake_timeout_ms=100000\n[groups."11".execution]\nmax_tool_calls_per_wake=64\n[groups."22".execution]\nwake_timeout_ms=120000');
  assert.deepEqual(app.resolveGroup('11').execution,{maxToolCallsPerWake:64,wakeTimeoutMs:100000});assert.deepEqual(app.resolveGroup('22').execution,{maxToolCallsPerWake:128,wakeTimeoutMs:120000});assert.deepEqual(app.resolveGroup('99').execution,{maxToolCallsPerWake:128,wakeTimeoutMs:100000});
  assert.equal(app.model.model,'synthetic-model');assert.equal(app.model.apiKey,'fixture-model-key');assert.equal(app.model.maxTokens,16384);assert.equal(app.runtime.maxConcurrentTurns,3);
  for(const id of ['11','22','99']){const g=app.resolveGroup(id);assert.equal(app.model.transport,'responses');assert.equal(Object.hasOwn(g.session,'transport'),false);for(const key of ['model','apiKey','baseUrl','ownerId','onebot','runtime'])assert.equal(Object.hasOwn(g,key),false);}
  const snapshot=app.resolveGroup('11');snapshot.execution.maxToolCallsPerWake=7;assert.equal(app.resolveGroup('11').execution.maxToolCallsPerWake,64);assert.equal(app.resolveGroup('99').execution.maxToolCallsPerWake,128);
});
test('execution endpoints are accepted at defaults and disabled group scope',t=>{
  const load=fixture(t);
  for(const scope of ['defaults.execution','groups."11".execution'])for(const [key,values,field] of [['max_tool_calls_per_wake',[1,4097,600001,Number.MAX_SAFE_INTEGER],'maxToolCallsPerWake'],['wake_timeout_ms',[1000,600000],'wakeTimeoutMs']] as const)for(const value of values)
    assert.equal(load(`[groups."11"]\nenabled=false\n[${scope}]\n${key}=${value}`).resolveGroup('11').execution[field],value);
});
test('execution budgets reject coercion, fractional, nonfinite, zero and out-of-range values even when disabled',t=>{
  const load=fixture(t);
  for(const scope of ['defaults.execution','groups."11".execution'])for(const [key,invalid] of [['max_tool_calls_per_wake',['0','-1']],['wake_timeout_ms',['0','999','600001']]] as const)for(const value of [...invalid,'1.5','true','false','"96"','[]','{}','nan','inf','-inf','9007199254740992'])
    assert.throws(()=>load(`[groups."11"]\nenabled=false\n[${scope}]\n${key}=${value}`),ConfigError,`${key}=${value}`);
});
test('execution rejects misplaced model/global settings, unknown fields, old ai sections and invalid table types',t=>{
  const load=fixture(t);
  for(const scope of ['defaults.execution','groups."11".execution'])for(const field of ['model','api_key_env','api_key','base_url','timeout_ms','enabled','max_concurrent_turns','max_output_tokens','max_tool_calls','maxToolCallsPerWake','unlimited'])
    assert.throws(()=>load(`[groups."11"]\nenabled=false\n[${scope}]\n${field}="PRIVATE_VALUE"`),e=>e instanceof ConfigError&&!e.message.includes('PRIVATE_VALUE'));
  for(const scope of ['defaults','groups."11"'])for(const value of ['true','false','[]','96','"execution"'])assert.throws(()=>load(`[${scope}]\nexecution=${value}`),ConfigError);
  for(const scope of ['ai','groups."11".ai'])assert.throws(()=>load(`[${scope}]\nmax_tool_calls_per_wake=96`),ConfigError);
});
test('model, identity, connection, logging and process concurrency cannot be set by group/default policies',t=>{
  const load=fixture(t);
  for(const scope of ['defaults','groups."11"'])for(const [section,field,value] of [['model','api_key_env','"PRIVATE_VALUE"'],['model','model','"PRIVATE_VALUE"'],['model','base_url','"https://example.test"'],['runtime','max_concurrent_turns','3'],['runtime','ai_enabled','true'],['bot','owner_id','"778899"'],['onebot','token_env','"PRIVATE_VALUE"'],['logging','level','"debug"']] as const)
    assert.throws(()=>load(`[groups."11"]\nenabled=false\n[${scope}.${section}]\n${field}=${value}`),e=>e instanceof ConfigError&&!e.message.includes('PRIVATE_VALUE'));
  for(const field of ['api_key_env','api_key','model','owner_id','max_concurrent_turns'])assert.throws(()=>load(`[groups."11"]\nenabled=false\n${field}="PRIVATE_VALUE"`),e=>e instanceof ConfigError&&!e.message.includes('PRIVATE_VALUE'));
});
