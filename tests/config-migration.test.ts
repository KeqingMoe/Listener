import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseEnv } from 'dotenv';
import { parse as parseToml } from 'smol-toml';
import { migrateConfig } from '../scripts/migrate-config.js';
import { loadAppConfig } from '../src/config-loader.js';
import { LISTENER_GROUP, OWNER_ID } from '../src/contracts.js';
function fixture(extra='') {
 const root=mkdtempSync(join(tmpdir(),'listener-migration-'));
 mkdirSync(join(root,'prompts'));writeFileSync(join(root,'prompts/listener.md'),'可爱猫娘');
 const text=`ADMIN_USER_IDS=${OWNER_ID}\nALLOWED_GROUP_IDS=${LISTENER_GROUP}\nONEBOT_ACCESS_TOKEN=original-onebot-secret\nOPENAI_API_KEY=original-api-secret\nAI_ENABLED=true\nOPENAI_BASE_URL=https://example.test/v1\nOPENAI_MODEL=test-model\nAI_RANDOM_REPLY_PROBABILITY=0\nAI_DEBOUNCE_MS=1000\nAI_DELAY_MAX_MS=2800\nAI_MAX_TOKENS=999\n${extra}`;
 writeFileSync(join(root,'.env'),text,{mode:0o600});return {root,text};
}
test('one-time migration preserves chat settings/secrets, disables management and writes private backups',()=>{
 const {root,text}=fixture();try{
 migrateConfig(root,{});
 const result=loadAppConfig({configPath:join(root,'config.toml'),env:{}});
 assert.equal(result.listener.model,'test-model');assert.equal(result.listener.baseUrl,'https://example.test/v1');assert.equal(result.listener.enabled,true);
 assert.deepEqual(result.listener.tools!.moderation,{mute:'off',unmute:'off',recall:'off',memberCard:'off',confirmationTtlSeconds:60,maxMuteSeconds:600});
 assert.equal(result.listener.randomReplyProbability,0);assert.equal(result.listener.debounceMs,1000);assert.equal(result.listener.delayMaxMs,2800);assert.equal(result.listener.maxTokens,999);
 assert.equal(result.listener.maxToolCallsPerWake,96);assert.equal(result.listener.wakeTimeoutMs,90000);
 assert.equal(result.listener.transport,'chat');assert.equal(result.listener.serverCompaction,'off');assert.equal(result.listener.compactThreshold,undefined);assert.equal(result.listener.sessionMaxContextBytes,524288);
 assert.equal(result.onebot.token,'original-onebot-secret');assert.equal(result.listener.apiKey,'original-api-secret');
 const secrets=parseEnv(readFileSync(join(root,'.env'),'utf8'));assert.deepEqual(Object.keys(secrets).sort(),['ONEBOT_ACCESS_TOKEN','OPENAI_API_KEY']);
 const config=readFileSync(join(root,'config.toml'),'utf8');assert.ok(!config.includes('max_parts'));assert.ok(!config.includes('max_per_read'));assert.deepEqual(result.listener.forward,{enabled:false});assert.ok(!config.includes('original-api-secret'));assert.ok(!config.includes('original-onebot-secret'));
 const doc=parseToml(config);assert.equal(Object.hasOwn(doc.bot as object,'group_id'),false);
  assert.equal((doc.bot as Record<string,unknown>).owner_id,OWNER_ID);assert.equal(result.listener.ownerId,OWNER_ID);
  assert.equal((doc.memory as Record<string,unknown>).legacy_group_id,LISTENER_GROUP);
 assert.deepEqual(Object.keys(doc.groups as object),[LISTENER_GROUP]);
 assert.equal(((doc.groups as Record<string,unknown>)[LISTENER_GROUP] as Record<string,unknown>).enabled,true);
 assert.deepEqual([...result.onebot.allowedGroups],[LISTENER_GROUP]);assert.equal(result.groups[0]?.groupId,LISTENER_GROUP);
 assert.equal(result.groups[0]?.memoryPath,join(root,'data/listener.sqlite'));
 assert.equal(readFileSync(join(root,'data/config-migration.env.bak'),'utf8'),text);
 for(const p of ['.env','config.toml','data/config-migration.env.bak'])assert.equal(statSync(join(root,p)).mode&0o777,0o600);
 assert.throws(()=>migrateConfig(root,{}),/已存在/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('migration preserves old effective process overrides without leaking secrets into TOML',()=>{
 const {root}=fixture();try{migrateConfig(root,{OPENAI_MODEL:'override',OPENAI_API_KEY:'process-key',AI_RANDOM_REPLY_PROBABILITY:'0.2'});const c=loadAppConfig({configPath:join(root,'config.toml'),env:{}});assert.equal(c.listener.model,'override');assert.equal(c.listener.apiKey,'process-key');assert.equal(c.listener.randomReplyProbability,0.2);}finally{rmSync(root,{recursive:true,force:true});}
});
test('invalid migration validates before changing original env or creating final config',()=>{
 for(const extra of ['UNKNOWN_SETTING=secret-dont-print\n','AI_RANDOM_REPLY_PROBABILITY=NaN\n','AI_DELAY_MAX_MS=1\n','ADMIN_USER_IDS=999,888\n','ALLOWED_GROUP_IDS=22,33\n']){
 const {root,text}=fixture(extra);try{assert.throws(()=>migrateConfig(root,{}),e=>e instanceof Error&&!e.message.includes('secret-dont-print'));assert.equal(readFileSync(join(root,'.env'),'utf8'),text);assert.equal(existsSync(join(root,'config.toml')),false);assert.equal(existsSync(join(root,'data/config-migration.env.bak')),false);}finally{rmSync(root,{recursive:true,force:true});}}
});
test('migration preserves explicit nondefault local identity and legacy mapping without hardcoded admission',()=>{
 const {root}=fixture('ADMIN_USER_IDS=778899\nALLOWED_GROUP_IDS=334455\n');try{
  migrateConfig(root,{});const c=loadAppConfig({configPath:join(root,'config.toml'),env:{}});
  assert.equal(c.listener.ownerId,'778899');assert.deepEqual([...c.onebot.adminUsers],['778899']);assert.deepEqual([...c.onebot.allowedGroups],['334455']);
  assert.equal(c.groups[0]?.ownerId,'778899');assert.equal(c.groups[0]?.memoryPath,join(root,'data/listener.sqlite'));
  const doc=parseToml(readFileSync(join(root,'config.toml'),'utf8'));assert.equal((doc.memory as Record<string,unknown>).legacy_group_id,'334455');
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('migration refuses missing or malformed identity before touching legacy env, backup or config',()=>{
 for(const field of ['ADMIN_USER_IDS','ALLOWED_GROUP_IDS'])for(const value of [undefined,'','0','01','+1','1,2','" 22"','"22 "','1'.repeat(33)]){
  const {root}=fixture();try{
   const text=`ONEBOT_ACCESS_TOKEN=original-secret\nAI_ENABLED=false\n${field==='ADMIN_USER_IDS'?`ALLOWED_GROUP_IDS=${LISTENER_GROUP}`:`ADMIN_USER_IDS=${OWNER_ID}`}\n${value===undefined?'':`${field}=${value}\n`}`;
   writeFileSync(join(root,'.env'),text);assert.throws(()=>migrateConfig(root,{}),e=>e instanceof Error&&!e.message.includes('original-secret'));
   assert.equal(readFileSync(join(root,'.env'),'utf8'),text);assert.equal(existsSync(join(root,'config.toml')),false);assert.equal(existsSync(join(root,'data/config-migration.env.bak')),false);
  }finally{rmSync(root,{recursive:true,force:true});}
 }
});
test('existing config or backup is never overwritten',()=>{
 for(const target of ['config.toml','data/config-migration.env.bak']){
 const {root,text}=fixture();try{mkdirSync(join(root,'data'));writeFileSync(join(root,target),'keep');assert.throws(()=>migrateConfig(root,{}));assert.equal(readFileSync(join(root,target),'utf8'),'keep');assert.equal(readFileSync(join(root,'.env'),'utf8'),text);}finally{rmSync(root,{recursive:true,force:true});}}
});
test('disabled AI with no API key remains disabled and stores no empty secret',()=>{
 const {root}=fixture();try{writeFileSync(join(root,'.env'),`ADMIN_USER_IDS=${OWNER_ID}\nALLOWED_GROUP_IDS=${LISTENER_GROUP}\nONEBOT_ACCESS_TOKEN=test\nAI_ENABLED=false\n`);migrateConfig(root,{});const c=loadAppConfig({configPath:join(root,'config.toml'),env:{}});assert.equal(c.listener.enabled,false);assert.equal(c.listener.apiKey,'');assert.equal((parseToml(readFileSync(join(root,'config.toml'),'utf8')).ai as any).enabled,false);}finally{rmSync(root,{recursive:true,force:true});}
});
