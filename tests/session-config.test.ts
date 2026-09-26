import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadAppConfig,ConfigError} from '../src/config-loader.js';
function fixture(t:{after(fn:()=>void):void}){const dir=mkdtempSync(join(tmpdir(),'session-config-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));mkdirSync(join(dir,'prompts'));writeFileSync(join(dir,'prompts/listener.md'),'persona');return(s:string)=>{writeFileSync(join(dir,'config.toml'),s);return loadAppConfig({configPath:join(dir,'config.toml'),env:{ONEBOT_ACCESS_TOKEN:'test'}})};}
test('session transport and budgets have safe defaults',t=>{const c=fixture(t)('');assert.equal(c.listener.transport,'chat');assert.equal(c.listener.sessionMaxContextBytes,524288);assert.equal(c.listener.serverCompaction,'off');assert.equal(c.listener.compactThreshold,undefined);});
test('global session fields inherit independently and groups may override them',t=>{const c=fixture(t)('[ai]\ntransport="responses"\nsession_max_context_bytes=1048576\n[groups."1".ai]\ntransport="chat"\nsession_max_context_bytes=65536\n[groups."2".ai]\nserver_compaction="off"');assert.equal(c.listener.transport,'responses');assert.equal(c.groups[0]!.transport,'chat');assert.equal(c.groups[0]!.sessionMaxContextBytes,65536);assert.equal(c.groups[1]!.transport,'responses');assert.equal(c.groups[1]!.sessionMaxContextBytes,1048576);});
test('automatic compaction requires responses and an explicit threshold',t=>{const load=fixture(t);for(const s of ['[ai]\nserver_compaction="auto"','[ai]\nserver_compaction="auto"\ntransport="chat"\ncompact_threshold=4096','[ai]\ntransport="responses"\nserver_compaction="auto"\ncompact_threshold=1024']){if(s.includes('compact_threshold=1024'))assert.equal(load(s).listener.serverCompaction,'auto');else assert.throws(()=>load(s),ConfigError);}});
test('off compaction rejects thresholds and explicit group off clears inherited threshold',t=>{const load=fixture(t);assert.throws(()=>load('[ai]\ntransport="responses"\nserver_compaction="off"\ncompact_threshold=4096'),ConfigError);assert.throws(()=>load('[ai]\ntransport="responses"\nserver_compaction="auto"\ncompact_threshold=4096\n[groups."1".ai]\nserver_compaction="off"\ncompact_threshold=4096'),ConfigError);});
test('group off explicitly clears inherited threshold while inherited auto requires responses',t=>{
 const load=fixture(t),root='[ai]\ntransport="responses"\nserver_compaction="auto"\ncompact_threshold=4096\n';
 const c=load(root+'[groups."1".ai]\nserver_compaction="off"\ntransport="chat"\n[groups."2"]\n[groups."3".ai]\ncompact_threshold=8192');
 assert.equal(c.groups[0]!.transport,'chat');assert.equal(c.groups[0]!.serverCompaction,'off');assert.equal(c.groups[0]!.compactThreshold,undefined);
 assert.equal(c.groups[1]!.serverCompaction,'auto');assert.equal(c.groups[1]!.compactThreshold,4096);assert.equal(c.groups[2]!.compactThreshold,8192);
 assert.equal(c.listener.compactThreshold,4096);
 for(const enabled of [true,false])assert.throws(()=>load(root+`[groups."1"]\nenabled=${enabled}\n[groups."1".ai]\ntransport="chat"`),ConfigError);
});
test('all session numeric endpoints and dependencies validate in disabled groups',t=>{
 const load=fixture(t);
 for(const prefix of ['[ai]','[groups."1".ai]'])for(const value of [65536,8388608]){const c=load(`${prefix}\nsession_max_context_bytes=${value}`);assert.equal((prefix==='[ai]'?c.listener:c.groups[0]!).sessionMaxContextBytes,value);}
 for(const threshold of [1024,1000000]){const c=load(`[ai]\ntransport="responses"\nserver_compaction="auto"\ncompact_threshold=${threshold}`);assert.equal(c.listener.compactThreshold,threshold);}
 for(const fields of ['transport="responses"\nserver_compaction="auto"','transport="chat"\nserver_compaction="auto"\ncompact_threshold=2048','compact_threshold=2048'])assert.throws(()=>load('[groups."1"]\nenabled=false\n[groups."1".ai]\n'+fields),ConfigError);
 for(const key of ['session_max_context_bytes','compact_threshold'])for(const value of ['nan','inf','1.5','9007199254740992','[]','{}'])assert.throws(()=>load(`[ai]\n${key}=${value}`),ConfigError);
});
test('session values reject aliases, coercion, bad ranges and unknown group transport fields even when disabled',t=>{const load=fixture(t);for(const [key,values] of [['transport',['"openai"','true','1']],['server_compaction',['"on"','true','1']],['session_max_context_bytes',['65535','8388609','0','"524288"','true']],['compact_threshold',['1023','1000001','0','"4096"','false']]] as const)for(const value of values){assert.throws(()=>load(`[ai]\n${key}=${value}`),ConfigError);assert.throws(()=>load(`[groups."1"]\nenabled=false\n[groups."1".ai]\n${key}=${value}`),ConfigError);}for(const key of ['api_key_env','model','base_url','timeout_ms','max_output_tokens','unknown_transport'])assert.throws(()=>load(`[groups."1".ai]\n${key}="x"`),ConfigError);});
