import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, symlinkSync, linkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadAppConfig } from '../src/config-loader.js';
import { LISTENER_GROUP, OWNER_ID } from '../src/contracts.js';

function fixture(t:{after(fn:()=>void):void}, source='') {
 const dir=mkdtempSync(join(tmpdir(),'listener-multigroup-config-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 mkdirSync(join(dir,'prompts'));writeFileSync(join(dir,'prompts/listener.md'),'global persona');
 const config=(text:string)=>writeFileSync(join(dir,'config.toml'),text);config(source);
 const load=()=>loadAppConfig({configPath:join(dir,'config.toml'),env:{ONEBOT_ACCESS_TOKEN:'fixture-token',OPENAI_API_KEY:'fixture-key'}});
 return {dir,config,load};
}

test('explicit original group preserves its database and new groups derive independent paths',t=>{
 const f=fixture(t,`[groups."${LISTENER_GROUP}"]`);let c=f.load();
 assert.deepEqual([...c.onebot.allowedGroups],[LISTENER_GROUP]);assert.equal(c.groups[0]!.memoryPath,c.listener.memoryPath);
 assert.equal(c.groups[0]!.groupId,LISTENER_GROUP);assert.equal(c.listener.groupId,undefined);
 f.config('[groups."22"]');c=f.load();
 assert.equal(c.listener.memoryPath,join(f.dir,'data/listener.sqlite'));
 assert.equal(c.groups[0]!.memoryPath,join(f.dir,'data/groups/22/listener.sqlite'));
 assert.equal(existsSync(join(f.dir,'data')),false);
 f.config('[groups."22"]\n[memory]\npath="custom/history.db"');c=f.load();
 assert.equal(c.groups[0]!.memoryPath,join(f.dir,'custom/groups/22/listener.sqlite'));
});

test('explicit groups exclusively define enabled scope while AI enabled remains global',t=>{
 const f=fixture(t,'[ai]\nenabled=true\nmodel="test"\nmax_concurrent_turns=8\n[groups."22"]\n[groups."33"]\nenabled=false');
 const c=f.load();assert.deepEqual([...c.onebot.allowedGroups],['22']);assert.deepEqual(c.groups.map(g=>g.groupId),['22']);
 assert.equal(c.listener.enabled,true);assert.equal(c.groups[0]!.enabled,true);assert.equal(c.maxConcurrentTurns,8);
 assert.equal(c.groups[0]!.model,c.listener.model);assert.equal(c.groups[0]!.apiKey,c.listener.apiKey);
 assert.deepEqual([...c.onebot.adminUsers],[OWNER_ID]);assert.equal(c.onebot.allowPrivate,false);assert.deepEqual([...c.onebot.allowedUsers],[]);
 f.config('[ai]\nenabled=false\n[groups."22"]');const disabledAI=f.load();assert.equal(disabledAI.groups.length,1);assert.equal(disabledAI.groups[0]!.enabled,false);
 for(const source of ['','[groups]','[groups."22"]\nenabled=false']){f.config(source);const empty=f.load();assert.deepEqual(empty.groups,[]);assert.equal(empty.onebot.allowedGroups.size,0);}
});

test('nested group overrides inherit defaults deeply without mutating siblings or global defaults',t=>{
 const f=fixture(t,`[reply]\nrandom_probability=0.15\ndelay_ms=[1000,2500]\n[reply.random]\ncooldown_ms=10000\nmax_per_minute=6\n[tools]\nmembers=false\n[tools.moderation]\nmute="off"\nrecall="confirm"\nmax_mute_seconds=100\n[images]\nenabled=true\nmax_per_turn=2\n[forward]\nenabled=true\n[memory]\nretention_days=12\ncontext_chars=32000\n[groups."22".reply.random]\nmax_per_minute=4\n[groups."22".tools.moderation]\nrecall="off"\n[groups."22".images]\nmax_download_mb=2\n[groups."22".forward]\nenabled=true\n[groups."22".memory]\nretention_days=3\n[groups."33"]`);
 const {listener,groups}=f.load();const a=groups.find(g=>g.groupId==='22')!,b=groups.find(g=>g.groupId==='33')!;
 assert.equal(a.maxToolCallsPerWake,96);assert.equal(a.wakeTimeoutMs,90000);assert.equal(a.randomReplyProbability,0.15);assert.equal(a.randomCooldownMs,10000);assert.equal(a.randomMaxPerMinute,4);
 assert.equal(a.debounceMs,1000);assert.equal(a.delayMaxMs,2500);
 assert.deepEqual(a.tools,{members:false,mention:true,reactions:false,moderation:{mute:'off',unmute:'off',recall:'off',memberCard:'off',confirmationTtlSeconds:60,maxMuteSeconds:100}});
 assert.deepEqual(a.images,{enabled:true,maxPerTurn:2,maxDownloadMb:2});assert.deepEqual(a.forward,{enabled:true});
 assert.equal(a.retentionDays,3);assert.equal(a.maxContextChars,32000);assert.equal(b.retentionDays,12);
 a.tools!.moderation.mute='direct';a.images!.enabled=false;a.forward!.enabled=false;
 assert.equal(listener.tools!.moderation.mute,'off');assert.equal(b.tools!.moderation.mute,'off');assert.equal(b.tools!.moderation.recall,'confirm');
 assert.equal(listener.images!.enabled,true);assert.equal(b.images!.enabled,true);assert.equal(b.forward!.enabled,true);
});

test('all disabled groups still validate unknown tables, forbidden overrides and value types',t=>{
 const f=fixture(t);
 for(const name of ['ai','model','api_key','base_url','owner_id','owner_name','name','onebot','logging','group_id']){
  f.config(`[groups."22"]\nenabled=false\n${name}="SENSITIVE_CONFIG_BODY"`);
  assert.throws(()=>f.load(),e=>e instanceof ConfigError&&!e.message.includes('SENSITIVE_CONFIG_BODY'));
 }
 for(const section of ['reply','reply.random','tools','tools.moderation','images','forward','memory','persona']){
  f.config(`[groups."22"]\nenabled=false\n[groups."22".${section}]\nSECRET_UNKNOWN_KEY="secret-body"`);
  assert.throws(()=>f.load(),e=>e instanceof ConfigError&&!e.message.includes('SECRET_UNKNOWN_KEY')&&!e.message.includes('secret-body'));
 }
 for(const field of ['reply','tools','images','forward','memory','persona'])for(const v of ['true','[]','42','"secret"']){
  f.config(`[groups."22"]\nenabled=false\n${field}=${v}`);assert.throws(()=>f.load(),ConfigError);
 }
 f.config('[groups."22"]\nenabled="false"');assert.throws(()=>f.load(),ConfigError);
});

test('canonical IDs and maximum32 groups are enforced even for disabled groups',t=>{
 const f=fixture(t);
 for(const id of ['0','01',' 22','22 ','-1','+1','1.0','secret-key','__proto__','constructor','prototype','1'.repeat(33)]){
  f.config(`[groups."${id}"]\nenabled=false`);
  assert.throws(()=>f.load(),e=>e instanceof ConfigError&&!e.message.includes(id));
 }
 for(const source of ['groups=true','groups=[]','groups="secret"','[groups]\n"22"=true']){f.config(source);assert.throws(()=>f.load(),ConfigError);}
 f.config(Array.from({length:32},(_,i)=>`[groups."${i+1}"]\nenabled=false`).join('\n'));assert.equal(f.load().groups.length,0);
 f.config(Array.from({length:33},(_,i)=>`[groups."${i+1}"]\nenabled=false`).join('\n'));assert.throws(()=>f.load(),ConfigError);
 f.config(`[groups."${'9'.repeat(32)}"]`);assert.equal(f.load().groups[0]!.groupId,'9'.repeat(32));
});

test('group numeric ranges and boolean types match global bounds',t=>{
 const f=fixture(t);
 const ranges:Array<[string,string,number,number]>=[['reply','cooldown_ms',1000,60000],['reply.random','cooldown_ms',1000,3600000],['reply.random','max_per_minute',1,10],['tools.moderation','confirmation_ttl_seconds',1,60],['tools.moderation','max_mute_seconds',1,600],['images','max_per_turn',1,3],['images','max_download_mb',1,10],['memory','retention_days',1,30],['memory','context_chars',8000,100000]];
 for(const [section,key,min,max] of ranges)for(const v of [String(min-1),String(max+1),'1.5','inf','nan','true','"2"']){
  f.config(`[groups."22"]\nenabled=false\n[groups."22".${section}]\n${key}=${v}`);assert.throws(()=>f.load(),ConfigError,`${section}.${key}=${v}`);
 }
 for(const [section,key] of [['reply','mention'],['reply','quote_bot'],['tools','members'],['tools','mention'],['tools.moderation','mute'],['tools.moderation','recall'],['tools.moderation','member_card'],['images','enabled'],['forward','enabled']]){
  f.config(`[groups."22".${section}]\n${key}="true"`);assert.throws(()=>f.load(),ConfigError);
 }
 for(const v of ['-0.1','1.1','nan','true','"0.5"']){f.config(`[groups."22".reply]\nrandom_probability=${v}`);assert.throws(()=>f.load(),ConfigError);}
 for(const v of ['[]','[100]','[99,1000]','[5001,7000]','[100,10001]','[3000,1000]','[100,1.5]']){f.config(`[groups."22".reply]\ndelay_ms=${v}`);assert.throws(()=>f.load(),ConfigError);}
});

test('persona append is bounded UTF8, relative, independent and validated for disabled groups',t=>{
 const f=fixture(t,'[groups."22".persona]\nappend_file="prompts/extra.md"\n[groups."33"]');
 writeFileSync(join(f.dir,'prompts/extra.md'),'extra style');let c=f.load();
 assert.match(c.groups[0]!.persona!,/^global persona\n\n---/);assert.ok(c.groups[0]!.persona!.endsWith('extra style'));
 assert.equal(c.groups[1]!.persona,'global persona');assert.equal(c.listener.persona,'global persona');
 f.config('[groups."22"]\nenabled=false\n[groups."22".persona]\nappend_file="missing-secret-file"');
 assert.throws(()=>f.load(),e=>e instanceof ConfigError&&!e.message.includes('missing-secret-file'));
 f.config('[groups."22".persona]\nappend_file="prompts/extra.md"');
 for(const body of ['', 'x'.repeat(16*1024+1),Buffer.from([0xff])]){writeFileSync(join(f.dir,'prompts/extra.md'),body);assert.throws(()=>f.load(),ConfigError);}
 writeFileSync(join(f.dir,'prompts/extra.md'),'x'.repeat(16*1024));c=f.load();assert.ok(c.groups[0]!.persona!.length>16*1024);
 f.config('[groups."22".persona]\nfile="prompts/listener.md"');assert.throws(()=>f.load(),ConfigError);
 f.config('[groups."22".persona]\nappend_file="prompts"');assert.throws(()=>f.load(),ConfigError);
});

test('per-group memory overrides anchor to config and enabled paths must differ',t=>{
 const f=fixture(t,`[memory]\npath="custom/history.db"\n[groups."${LISTENER_GROUP}"]\n[groups."22"]\n[groups."33".memory]\npath="elsewhere/third.db"`);
 let c=f.load();assert.equal(c.groups.find(g=>g.groupId===LISTENER_GROUP)!.memoryPath,join(f.dir,'custom/history.db'));
 assert.equal(c.groups.find(g=>g.groupId==='22')!.memoryPath,join(f.dir,'custom/groups/22/listener.sqlite'));
 assert.equal(c.groups.find(g=>g.groupId==='33')!.memoryPath,join(f.dir,'elsewhere/third.db'));
 f.config('[groups."22".memory]\npath="same.db"\n[groups."33".memory]\npath="sub/../same.db"');assert.throws(()=>f.load(),ConfigError);
 f.config('[groups."22".memory]\npath="same.db"\n[groups."33"]\nenabled=false\n[groups."33".memory]\npath="same.db"');assert.equal(f.load().groups.length,1);
 for(const path of [':memory:','https://secret.invalid/db','']){f.config(`[groups."22".memory]\npath="${path}"`);assert.throws(()=>f.load(),ConfigError);}
 assert.equal(existsSync(join(f.dir,'custom')),false);
});

test('existing hardlinks, file symlinks and symlinked ancestors cannot alias enabled group storage',t=>{
 const f=fixture(t);writeFileSync(join(f.dir,'first.db'),'unchanged database marker');
 linkSync(join(f.dir,'first.db'),join(f.dir,'hard.db'));symlinkSync(join(f.dir,'first.db'),join(f.dir,'symbolic.db'));
 for(const path of ['hard.db','symbolic.db']){
  f.config(`[groups."22".memory]\npath="first.db"\n[groups."33".memory]\npath="${path}"`);assert.throws(()=>f.load(),ConfigError);
 }
 mkdirSync(join(f.dir,'real'));symlinkSync(join(f.dir,'real'),join(f.dir,'alias'));
 f.config('[groups."22".memory]\npath="real/new/nested.db"\n[groups."33".memory]\npath="alias/new/nested.db"');assert.throws(()=>f.load(),ConfigError);
 assert.equal(readFileSync(join(f.dir,'first.db'),'utf8'),'unchanged database marker');assert.equal(existsSync(join(f.dir,'real/new')),false);
});

test('explicit reuse of an old database is not silently rewritten or migrated by config loading',t=>{
 const f=fixture(t,'[groups."22".memory]\npath="old.db"');writeFileSync(join(f.dir,'old.db'),'old group identity placeholder');
 const c=f.load();assert.equal(c.groups[0]!.memoryPath,join(f.dir,'old.db'));assert.equal(readFileSync(join(f.dir,'old.db'),'utf8'),'old group identity placeholder');
});
