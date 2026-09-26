import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConfigError,loadAppConfig} from '../src/config-loader.js';
import type {ModerationMode} from '../src/listener-config.js';

const fields=['mute','unmute','recall','member_card'] as const;
const keys=['mute','unmute','recall','memberCard'] as const;
const modes:ModerationMode[]=['off','confirm','direct'];
const defaults={mute:'off',unmute:'off',recall:'off',memberCard:'off',confirmationTtlSeconds:60,maxMuteSeconds:600};
function fixture(t:{after(fn:()=>void):void}){
 const dir=mkdtempSync(join(tmpdir(),'listener-moderation-config-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 mkdirSync(join(dir,'prompts'));writeFileSync(join(dir,'prompts/listener.md'),'fixture persona');
 // Preserve explicit bot inputs; other fixtures use a synthetic global owner.
 const config=(source:string)=>writeFileSync(join(dir,'config.toml'),/^\s*\[bot\]/m.test(source)?source:source+'\n[bot]\nowner_id="778899"\n');config('');
 const load=()=>loadAppConfig({configPath:join(dir,'config.toml'),env:{ONEBOT_ACCESS_TOKEN:'test-token'}});
 return {dir,config,load};
}

test('all management capabilities default off globally and per group without changing other defaults',t=>{
 const f=fixture(t);let c=f.load();assert.deepEqual(c.listener.tools?.moderation,defaults);assert.deepEqual(c.groups,[]);
 assert.equal(c.listener.tools?.members,true);assert.equal(c.listener.tools?.mention,true);assert.equal(c.listener.tools?.reactions,false);
 f.config('[groups."11"]\n[groups."22"]');c=f.load();assert.equal(c.groups.length,2);
 for(const group of c.groups)assert.deepEqual(group.tools?.moderation,defaults);
 assert.equal(existsSync(join(f.dir,'data')),false);
});

test('each capability accepts exactly three explicit modes including disabled groups',t=>{
 const f=fixture(t);
 for(const mode of modes)for(let index=0;index<fields.length;index++){
  const field=fields[index]!,key=keys[index]!;
  f.config(`[tools.moderation]\n${field}="${mode}"\n[groups."11"]`);
  let c=f.load();assert.equal(c.listener.tools!.moderation[key],mode);assert.equal(c.groups[0]!.tools!.moderation[key],mode);
  for(const sibling of keys.filter(other=>other!==key))assert.equal(c.groups[0]!.tools!.moderation[sibling],'off');
  f.config(`[groups."11".tools.moderation]\n${field}="${mode}"`);c=f.load();assert.equal(c.listener.tools!.moderation[key],'off');assert.equal(c.groups[0]!.tools!.moderation[key],mode);
  f.config(`[groups."11"]\nenabled=false\n[groups."11".tools.moderation]\n${field}="${mode}"`);assert.deepEqual(f.load().groups,[]);
 }
});

test('boolean compatibility, normalization, typo and scalar coercion are all rejected even in disabled groups',t=>{
 const f=fixture(t);
 const invalid=['true','false','0','1','1.5','nan','inf','null','[]','{}','1979-05-27','"true"','"false"','""','"OFF"','"Confirm"','"DIRECT"','" off"','"off "','"confirm\\n"','"auto"','"enabled"','"disabled"','"SENSITIVE_INVALID_MODE"'];
 for(const field of fields)for(const value of invalid){
  for(const source of [`[tools.moderation]\n${field}=${value}`,`[groups."11".tools.moderation]\n${field}=${value}`,`[groups."11"]\nenabled=false\n[groups."11".tools.moderation]\n${field}=${value}`]){
   f.config(source);assert.throws(()=>f.load(),e=>e instanceof ConfigError&&!e.message.includes('SENSITIVE_INVALID_MODE'),`${field}=${value}`);
  }
 }
});

test('mute and unmute inherit independently while overrides preserve siblings and global limits',t=>{
 const f=fixture(t);f.config('[tools.moderation]\nmute="direct"\nunmute="confirm"\nrecall="confirm"\nmember_card="off"\nconfirmation_ttl_seconds=40\nmax_mute_seconds=300\n[groups."11".tools.moderation]\nmute="off"\nunmute="direct"\nmax_mute_seconds=120\n[groups."22".tools.moderation]\nrecall="direct"\nconfirmation_ttl_seconds=15\n[groups."33"]');
 const c=f.load(),a=c.groups.find(g=>g.groupId==='11')!.tools!.moderation,b=c.groups.find(g=>g.groupId==='22')!.tools!.moderation,d=c.groups.find(g=>g.groupId==='33')!.tools!.moderation;
 assert.deepEqual(a,{mute:'off',unmute:'direct',recall:'confirm',memberCard:'off',confirmationTtlSeconds:40,maxMuteSeconds:120});
 assert.deepEqual(b,{mute:'direct',unmute:'confirm',recall:'direct',memberCard:'off',confirmationTtlSeconds:15,maxMuteSeconds:300});
 assert.deepEqual(d,c.listener.tools!.moderation);assert.notEqual(d,c.listener.tools!.moderation);assert.notEqual(a,b);
 a.unmute='off';assert.equal(b.unmute,'confirm');assert.equal(d.unmute,'confirm');assert.equal(c.listener.tools!.moderation.unmute,'confirm');
 f.config('[tools.moderation]\nmute="direct"\n[groups."11"]');assert.equal(f.load().groups[0]!.tools!.moderation.unmute,'off');
 f.config('[tools.moderation]\nunmute="direct"\n[groups."11"]');assert.equal(f.load().groups[0]!.tools!.moderation.mute,'off');
});

test('TTL and mute duration limits retain the same strict ranges for every mode',t=>{
 const f=fixture(t);
 for(const mode of modes)for(const [field,min,max] of [['confirmation_ttl_seconds',1,60],['max_mute_seconds',1,600]] as const){
  for(const value of [min,max]){
   f.config(`[tools.moderation]\nmute="${mode}"\n${field}=${value}\n[groups."11"]`);assert.equal(f.load().groups.length,1);
   f.config(`[groups."11"]\nenabled=false\n[groups."11".tools.moderation]\nunmute="${mode}"\n${field}=${value}`);assert.deepEqual(f.load().groups,[]);
  }
  for(const value of [String(min-1),String(max+1),'1.5','true','false','"1"','nan','inf'])for(const header of ['tools.moderation','groups."11".tools.moderation']){
   f.config(`[groups."11"]\nenabled=false\n[${header}]\nmute="${mode}"\n${field}=${value}`);assert.throws(()=>f.load(),ConfigError);
  }
 }
});

test('future capabilities and nested modes are rejected rather than silently authorized',t=>{
 const f=fixture(t);
 for(const header of ['tools.moderation','groups."11".tools.moderation']){
  for(const field of ['kick','announcement','ban','unmute_member','SECRET_UNKNOWN_KEY']){
   f.config(`[groups."11"]\nenabled=false\n[${header}]\n${field}="direct"`);
   assert.throws(()=>f.load(),e=>e instanceof ConfigError&&!e.message.includes('SECRET_UNKNOWN_KEY'));
  }
  for(const field of fields){f.config(`[${header}.${field}]\nmode="direct"`);assert.throws(()=>f.load(),ConfigError);}
 }
});

test('distributed example explicitly uses off for all four capabilities and documents autonomous authorization',t=>{
 const f=fixture(t),source=readFileSync(new URL('../config.example.toml',import.meta.url),'utf8');f.config(source);const c=f.load();
 assert.deepEqual(c.listener.tools?.moderation,defaults);assert.ok(c.groups.every(g=>JSON.stringify(g.tools?.moderation)===JSON.stringify(defaults)));
 assert.match(source,/不接受旧 true\/false/);assert.match(source,/direct 不要求主人先发指令/);assert.match(source,/主人 \/confirm/);
});
