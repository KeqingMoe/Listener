import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConfigError,loadAppConfig} from '../src/config-loader.js';

function fixture(t:{after(fn:()=>void):void},source=''){
 const dir=mkdtempSync(join(tmpdir(),'listener-reactions-config-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 mkdirSync(join(dir,'prompts'));writeFileSync(join(dir,'prompts/listener.md'),'fixture persona');
 // Preserve explicit bot inputs; other fixtures use a synthetic global owner.
 const config=(text:string)=>writeFileSync(join(dir,'config.toml'),/^\s*\[bot\]/m.test(text)?text:text+'\n[bot]\nowner_id="778899"\n');config(source);
 const load=()=>loadAppConfig({configPath:join(dir,'config.toml'),env:{ONEBOT_ACCESS_TOKEN:'fixture-token',OPENAI_API_KEY:'fixture-key'}});
 return {config,load};
}

test('reactions default off and do not implicitly enable groups or AI',t=>{
 const f=fixture(t);let c=f.load();
 assert.equal(c.listener.tools?.reactions,false);assert.deepEqual(c.groups,[]);assert.equal(c.listener.enabled,false);
 assert.equal(c.listener.tools?.members,true);assert.equal(c.listener.tools?.mention,true);
 assert.equal(c.listener.tools?.moderation.mute,'off');assert.equal(c.listener.tools?.moderation.unmute,'off');assert.equal(c.listener.tools?.moderation.recall,'off');assert.equal(c.listener.tools?.moderation.memberCard,'off');
 f.config('[tools]\nreactions=true');c=f.load();assert.equal(c.listener.tools?.reactions,true);assert.deepEqual(c.groups,[]);assert.equal(c.listener.enabled,false);
 f.config('[groups."11"]\n[groups."22"]');c=f.load();assert.ok(c.groups.every(g=>g.tools?.reactions===false));
});

test('reaction overrides deeply inherit and leave siblings and other tools independent',t=>{
 const f=fixture(t,'[tools]\nreactions=true\nmembers=false\nmention=false\n[tools.moderation]\nmute="off"\nrecall="off"\nmember_card="off"\n[groups."11".tools]\nreactions=false\n[groups."22".tools]\nmembers=true\n[groups."33"]');
 const c=f.load(),a=c.groups.find(g=>g.groupId==='11')!,b=c.groups.find(g=>g.groupId==='22')!,d=c.groups.find(g=>g.groupId==='33')!;
 assert.equal(a.tools?.reactions,false);assert.equal(b.tools?.reactions,true);assert.equal(d.tools?.reactions,true);
 assert.equal(a.tools?.members,false);assert.equal(b.tools?.members,true);assert.equal(d.tools?.members,false);
 assert.ok(c.groups.every(g=>g.tools?.mention===false&&g.tools.moderation.mute==='off'&&g.tools.moderation.unmute==='off'&&g.tools.moderation.recall==='off'&&g.tools.moderation.memberCard==='off'));
 for(const group of c.groups){assert.notEqual(group.tools,c.listener.tools);assert.notEqual(group.tools?.moderation,c.listener.tools?.moderation);}
 assert.notEqual(a.tools,b.tools);b.tools!.reactions=false;
 assert.equal(c.listener.tools?.reactions,true);assert.equal(d.tools?.reactions,true);
 f.config('[tools]\nreactions=false\n[groups."11".tools]\nreactions=true\n[groups."22"]');const override=f.load();
 assert.equal(override.groups.find(g=>g.groupId==='11')!.tools?.reactions,true);assert.equal(override.groups.find(g=>g.groupId==='22')!.tools?.reactions,false);
});

test('reactions require literal booleans globally and in every group even if disabled',t=>{
 const f=fixture(t);
 for(const value of ['"true"','"false"','0','1','[]','{}','1.5','nan','inf','1979-05-27']){
  for(const source of [`[tools]\nreactions=${value}`,`[groups."11".tools]\nreactions=${value}`,`[groups."11"]\nenabled=false\n[groups."11".tools]\nreactions=${value}`,`[ai]\nenabled=false\n[groups."11".tools]\nreactions=${value}`]){
   f.config(source);assert.throws(()=>f.load(),ConfigError);
  }
 }
 for(const value of ['true','false']){
  f.config(`[tools]\nreactions=${value}\n[groups."11"]\nenabled=false\n[groups."11".tools]\nreactions=${value}`);
  assert.deepEqual(f.load().groups,[]);
 }
});

test('reaction configuration does not relax unknown tool keys or accept nested settings',t=>{
 const f=fixture(t);
 for(const header of ['tools','groups."11".tools']){
  for(const source of [`[${header}]\nreactions=true\nreaction=true`,`[${header}]\nreactions=true\nunknown_secret="do-not-echo"`,`[${header}.reactions]\nenabled=true`]){
   f.config(source);assert.throws(()=>f.load(),error=>error instanceof ConfigError&&!error.message.includes('do-not-echo'));
  }
 }
 f.config('[groups."11"]\nenabled=false\n[groups."11".tools]\nreactions=false\nunknown=true');assert.throws(()=>f.load(),ConfigError);
});

test('reaction toggles leave reply probability, attention and moderation policy defaults unchanged',t=>{
 const f=fixture(t,'[tools]\nreactions=true\n[reply]\nrandom_probability=0.42\n[groups."11"]\n[groups."22".tools]\nreactions=false');
 const c=f.load();assert.equal(c.listener.randomReplyProbability,0.42);
 for(const group of c.groups){
  assert.equal(group.randomReplyProbability,0.42);assert.deepEqual(group.attention,{enabled:false,maxPlans:16});
  assert.deepEqual(group.tools?.moderation,{mute:'off',unmute:'off',recall:'off',memberCard:'off',confirmationTtlSeconds:60,maxMuteSeconds:600});
 }
 assert.deepEqual([...c.onebot.allowedGroups],['11','22']);assert.equal(c.onebot.allowPrivate,false);
});

test('configuration example keeps reactions default off and documents independent scope',t=>{
 const source=readFileSync(new URL('../config.example.toml',import.meta.url),'utf8');const f=fixture(t,source),c=f.load();
 assert.equal(c.listener.tools?.reactions,false);assert.ok(c.groups.every(g=>g.tools?.reactions===false));
 assert.match(source,/关闭不会自动移除已有回应/);assert.match(source,/不需主人确认/);assert.match(source,/sysface（329）\+ emoji（165）/);
});
