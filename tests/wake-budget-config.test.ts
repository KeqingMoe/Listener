import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadAppConfig,ConfigError} from '../src/config-loader.js';
function fixture(t:{after(fn:()=>void):void}){
 const dir=mkdtempSync(join(tmpdir(),'wake-budget-config-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 mkdirSync(join(dir,'prompts'));writeFileSync(join(dir,'prompts/listener.md'),'test persona');
 return (toml:string)=>{writeFileSync(join(dir,'config.toml'),/^\s*\[bot\]/m.test(toml)?toml:toml+'\n[bot]\nowner_id="778899"\n');return loadAppConfig({configPath:join(dir,'config.toml'),env:{ONEBOT_ACCESS_TOKEN:'test'}});};
}
test('wake budgets default to 96 calls and 90 seconds in every group',t=>{
 const load=fixture(t),c=load('[groups."123"]\nenabled=true\n[groups."456"]\nenabled=true');
 for(const config of [c.listener,...c.groups]){assert.equal(config.maxToolCallsPerWake,96);assert.equal(config.wakeTimeoutMs,90000);}
});
test('per-group wake limits independently inherit each global field without changing model transport',t=>{
 const load=fixture(t),c=load('[ai]\nmax_tool_calls_per_wake=128\nwake_timeout_ms=100000\n[groups."123".ai]\nmax_tool_calls_per_wake=64\n[groups."456".ai]\nwake_timeout_ms=120000\n[groups."789"]\nenabled=true');
 const configs=c.groups.map(g=>({id:g.groupId,calls:g.maxToolCallsPerWake,timeout:g.wakeTimeoutMs}));
 assert.deepEqual(configs,[{id:'123',calls:64,timeout:100000},{id:'456',calls:128,timeout:120000},{id:'789',calls:128,timeout:100000}]);
 for(const group of c.groups){assert.equal(group.model,c.listener.model);assert.equal(group.apiKey,c.listener.apiKey);assert.equal(group.timeoutMs,c.listener.timeoutMs);}
 c.groups[0]!.maxToolCallsPerWake=7;assert.equal(c.groups[1]!.maxToolCallsPerWake,128);assert.equal(c.listener.maxToolCallsPerWake,128);
});
test('wake limit endpoints are accepted globally and per group',t=>{
 const load=fixture(t);
 for(const prefix of ['[ai]','[groups."123".ai]'])for(const [key,values,field] of [['max_tool_calls_per_wake',[1,4096],'maxToolCallsPerWake'],['wake_timeout_ms',[1000,600000],'wakeTimeoutMs']] as const){
  for(const value of values){const c=load(`${prefix}\n${key}=${value}`);assert.equal((prefix==='[ai]'?c.listener:c.groups[0]!)[field],value);}
 }
});
test('wake budgets reject wrong types, fractions, infinities, zero and out-of-range integers even in disabled groups',t=>{
 const load=fixture(t);
 for(const [key,invalid] of [['max_tool_calls_per_wake',['0','-1','4097']],['wake_timeout_ms',['0','999','600001']]] as const){
  for(const value of [...invalid,'1.5','true','false','"96"','[]','{}','nan','inf','-inf','9007199254740992']){
   for(const prefix of ['[ai]', '[groups."123".ai]', '[groups."123"]\nenabled=false\n[groups."123".ai]']){
    assert.throws(()=>load(`${prefix}\n${key}=${value}`),ConfigError,`${prefix}.${key}=${value}`);
   }
  }
 }
});
test('group ai rejects model connection overrides and unlimited wake budget aliases',t=>{
 const load=fixture(t);
 for(const field of ['model','api_key_env','base_url','timeout_ms','enabled','max_concurrent_turns','max_output_tokens','max_tool_calls','maxToolCallsPerWake','unlimited']){
  assert.throws(()=>load(`[groups."123".ai]\n${field}="secret-must-not-leak"`),e=>e instanceof ConfigError&&!e.message.includes('secret-must-not-leak'));
 }
 for(const field of ['max_tool_calls','maxToolCallsPerWake','unlimited'])assert.throws(()=>load(`[ai]\n${field}=96`),ConfigError);
 for(const value of ['true','[]','96','"ai"'])assert.throws(()=>load(`[groups."123"]\nai=${value}`),ConfigError);
});
