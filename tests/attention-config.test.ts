import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConfigError,loadAppConfig} from '../src/config-loader.js';

function fixture(t:{after(fn:()=>void):void},source=''){
 const dir=mkdtempSync(join(tmpdir(),'listener-attention-config-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 mkdirSync(join(dir,'prompts'));writeFileSync(join(dir,'prompts/listener.md'),'fixture persona');
 const config=(text:string)=>writeFileSync(join(dir,'config.toml'),text);config(source);
 const load=()=>loadAppConfig({configPath:join(dir,'config.toml'),env:{ONEBOT_ACCESS_TOKEN:'fixture-token',OPENAI_API_KEY:'fixture-key'}});
 return {config,load};
}

test('attention defaults off with sixteen plans and never implicitly enables a group',t=>{
 const f=fixture(t);let c=f.load();
 assert.deepEqual(c.listener.attention,{enabled:false,maxPlans:16});assert.deepEqual(c.groups,[]);
 f.config('[attention]\nenabled=true');c=f.load();assert.equal(c.listener.attention?.enabled,true);assert.deepEqual(c.groups,[]);
 f.config('[groups."11"]\n[groups."22"]');c=f.load();
 for(const group of c.groups)assert.deepEqual(group.attention,{enabled:false,maxPlans:16});
 assert.deepEqual([...c.onebot.allowedGroups],['11','22']);
});

test('attention group overrides deeply inherit and allocate independent objects',t=>{
 const f=fixture(t,'[attention]\nenabled=true\nmax_plans=24\n[groups."11".attention]\nenabled=false\n[groups."22".attention]\nmax_plans=7\n[groups."33"]');
 const c=f.load(),a=c.groups.find(g=>g.groupId==='11')!,b=c.groups.find(g=>g.groupId==='22')!,d=c.groups.find(g=>g.groupId==='33')!;
 assert.deepEqual(a.attention,{enabled:false,maxPlans:24});assert.deepEqual(b.attention,{enabled:true,maxPlans:7});assert.deepEqual(d.attention,{enabled:true,maxPlans:24});
 for(const group of c.groups)assert.notEqual(group.attention,c.listener.attention);
 assert.notEqual(a.attention,b.attention);assert.notEqual(b.attention,d.attention);
 a.attention!.maxPlans=1;b.attention!.enabled=false;
 assert.deepEqual(c.listener.attention,{enabled:true,maxPlans:24});assert.deepEqual(d.attention,{enabled:true,maxPlans:24});
 f.config('[attention]\nenabled=false\nmax_plans=19\n[groups."11".attention]\nenabled=true');
 assert.deepEqual(f.load().groups[0]!.attention,{enabled:true,maxPlans:19});
});

test('attention accepts integer capacity endpoints globally and per group',t=>{
 const f=fixture(t);
 for(const value of [1,16,32]){
  f.config(`[attention]\nmax_plans=${value}\n[groups."11".attention]\nmax_plans=${value}`);
  const c=f.load();assert.equal(c.listener.attention?.maxPlans,value);assert.equal(c.groups[0]!.attention?.maxPlans,value);
 }
});

test('attention rejects unknown keys and incorrect table types at both scopes',t=>{
 const f=fixture(t);
 for(const header of ['attention','groups."11".attention']){
  for(const field of ['unexpected_secret="do-not-echo"','maxPlans=16','enabled="true"','enabled=1','enabled=[]','enabled={ value=true }','max_plans="16"','max_plans=true','max_plans=[]','max_plans={}']){
   f.config(`[${header}]\n${field}`);
   assert.throws(()=>f.load(),error=>error instanceof ConfigError&&!error.message.includes('do-not-echo')&&!error.message.includes('unexpected_secret'));
  }
 }
 for(const value of ['false','[]','"secret-body"','16','1979-05-27']){
  for(const prefix of ['', '[groups."11"]\n']){
   f.config(`${prefix}attention=${value}`);assert.throws(()=>f.load(),ConfigError);
  }
 }
});

test('attention validates capacity even when attention or the service group is disabled',t=>{
 const f=fixture(t);
 for(const value of ['0','33','-1','1.5','nan','inf','-inf','9007199254740992']){
  for(const source of [`[attention]\nenabled=false\nmax_plans=${value}`,`[groups."11".attention]\nenabled=false\nmax_plans=${value}`,`[groups."11"]\nenabled=false\n[groups."11".attention]\nmax_plans=${value}`]){
   f.config(source);assert.throws(()=>f.load(),ConfigError);
  }
 }
 f.config('[groups."11"]\nenabled=false\n[groups."11".attention]\nunknown=true');assert.throws(()=>f.load(),ConfigError);
 f.config('[groups."11"]\nenabled=false\n[groups."11".attention]\nenabled="false"');assert.throws(()=>f.load(),ConfigError);
});

test('attention leaves random participation settings independent and retains groups-only scope',t=>{
 const f=fixture(t,'[attention]\nenabled=true\n[reply]\nrandom_probability=0.42\n[groups."11"]\n[groups."22".reply]\nrandom_probability=0');
 const c=f.load();assert.equal(c.listener.randomReplyProbability,0.42);
 assert.equal(c.groups.find(g=>g.groupId==='11')!.randomReplyProbability,0.42);
 assert.equal(c.groups.find(g=>g.groupId==='22')!.randomReplyProbability,0);
 assert.ok(c.groups.every(g=>g.attention?.enabled));
 f.config('[bot]\ngroup_id="11"\n[attention]\nenabled=true\n[groups."11"]');assert.throws(()=>f.load(),ConfigError);
});

test('example documents a valid default-off attention configuration',t=>{
 const source=readFileSync(new URL('../config.example.toml',import.meta.url),'utf8');
 const f=fixture(t,source),c=f.load();assert.deepEqual(c.listener.attention,{enabled:false,maxPlans:16});
 assert.ok(c.groups.every(g=>g.attention?.enabled===false&&g.attention.maxPlans===16));
});
