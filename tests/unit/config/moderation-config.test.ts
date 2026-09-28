import test from 'node:test';
import {withFixtureModel} from '../../support/config-fixture.js';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConfigError,loadAppConfig} from '../../../src/config/loader.js';
import type {AppConfig} from '../../../src/config/app.js';
const names=['mute_member','unmute_member','recall_message','set_member_card'] as const;
function fixture(t:{after(fn:()=>void):void}){
  const dir=mkdtempSync(join(tmpdir(),'moderation-policy-config-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  mkdirSync(join(dir,'prompts'));writeFileSync(join(dir,'prompts/listener.md'),'persona');
  return {dir,load(source:string):AppConfig{writeFileSync(join(dir,'config.toml'),withFixtureModel(source));return loadAppConfig({configPath:join(dir,'config.toml'),env:{ONEBOT_ACCESS_TOKEN:'fixture',OPENAI_API_KEY:'fixture-key'}});}};
}
test('management defaults confirm with separate confirmation policy and no implicit group enablement',t=>{
  const f=fixture(t),app=f.load('[groups."11"]\n[groups."22"]');
  for(const id of ['11','22','99']){const g=app.resolveGroup(id);assert.equal(g.enabled,false);for(const name of names)assert.equal(g.tools[name].mode,'confirm');assert.equal(g.tools.mute_member.maxSeconds,2592000);assert.deepEqual(g.confirmation,{ttlSeconds:60});}
  assert.equal(existsSync(join(f.dir,'data')),false);
});
test('all four management tools accept three string modes and only active object branches',t=>{
  const {load}=fixture(t);
  for(const scope of ['defaults.tools','groups."11".tools'])for(const name of names)for(const mode of ['off','confirm','direct']){
    const app=load(`[groups."11"]\nenabled=false\n[${scope}]\n${name}="${mode}"`),g=app.resolveGroup('11');
    assert.equal(g.tools[name].mode,mode);for(const sibling of names.filter(x=>x!==name))assert.equal(g.tools[sibling].mode,'confirm');
    const object=`[${scope}]\n${name}={mode="${mode}"}`;
    if(mode==='off')assert.throws(()=>load(object),ConfigError);else assert.equal(load(object).resolveGroup('11').tools[name].mode,mode);
  }
});
test('management rejects invalid scalar types, normalization and unknown parameters in all scopes',t=>{
  const {load}=fixture(t);
  for(const scope of ['defaults.tools','groups."11".tools'])for(const name of names)for(const value of ['true','false','0','1','1.5','nan','inf','[]','{}','1979-05-27','"true"','""','"OFF"','"Confirm"','" off"','"off "','"confirm\\n"','"auto"','"PRIVATE_INVALID_MODE"','{mode="off",max_seconds=10}','{mode="direct",SECRET_UNKNOWN_KEY="PRIVATE_INVALID_MODE"}'])
    assert.throws(()=>load(`[groups."11"]\nenabled=false\n[${scope}]\n${name}=${value}`),e=>e instanceof ConfigError&&!e.message.includes('PRIVATE_INVALID_MODE')&&!e.message.includes('SECRET_UNKNOWN_KEY'),`${name}=${value}`);
  for(const scope of ['defaults.tools','groups."11".tools'])for(const name of ['mute','unmute','recall','member_card','moderation'])assert.throws(()=>load(`[${scope}]\n${name}="direct"`),ConfigError);
});
test('mute options replace as a union, unmute is independent, and confirmation TTL inherits separately',t=>{
  const app=fixture(t).load('[defaults.tools]\nmute_member={mode="direct",max_seconds=300}\nunmute_member="confirm"\nrecall_message="confirm"\n[defaults.confirmation]\nttl_seconds=40\n[groups."11".tools]\nmute_member="confirm"\nunmute_member="direct"\n[groups."22".tools]\nmute_member={mode="direct",max_seconds=120}\n[groups."22".confirmation]\nttl_seconds=15\n[groups."33".tools]\nmute_member="off"');
  assert.deepEqual(app.resolveGroup('11').tools.mute_member,{mode:'confirm',maxSeconds:2592000});
  assert.deepEqual(app.resolveGroup('22').tools.mute_member,{mode:'direct',maxSeconds:120});
  assert.equal(app.resolveGroup('33').tools.mute_member.mode,'off');
  assert.equal(app.resolveGroup('11').tools.unmute_member.mode,'direct');assert.equal(app.resolveGroup('22').tools.unmute_member.mode,'confirm');
  assert.equal(app.resolveGroup('11').confirmation.ttlSeconds,40);assert.equal(app.resolveGroup('22').confirmation.ttlSeconds,15);
  const snapshot=app.resolveGroup('99');snapshot.tools.mute_member.maxSeconds=1;snapshot.confirmation.ttlSeconds=1;
  assert.equal(app.resolveGroup('99').tools.mute_member.maxSeconds,300);assert.equal(app.resolveGroup('99').confirmation.ttlSeconds,40);
});
test('TTL and mute duration strict endpoints and invalid ranges apply even to disabled groups',t=>{
  const {load}=fixture(t);
  for(const scope of ['defaults','groups."11"']){
    for(const ttl of [1,60])assert.equal(load(`[${scope}.confirmation]\nttl_seconds=${ttl}`).resolveGroup('11').confirmation.ttlSeconds,ttl);
    for(const mode of ['confirm','direct'])for(const seconds of [1,601,2592000])assert.equal(load(`[${scope}.tools]\nmute_member={mode="${mode}",max_seconds=${seconds}}`).resolveGroup('11').tools.mute_member.maxSeconds,seconds);
    for(const value of ['0','61','1.5','true','false','"1"','nan','inf','[]','{}'])assert.throws(()=>load(`[groups."11"]\nenabled=false\n[${scope}.confirmation]\nttl_seconds=${value}`),ConfigError);
    for(const value of ['0','2592001','-1','1.5','true','"1"','nan','inf','[]','{}','9007199254740992'])for(const mode of ['confirm','direct'])assert.throws(()=>load(`[groups."11"]\nenabled=false\n[${scope}.tools]\nmute_member={mode="${mode}",max_seconds=${value}}`),ConfigError);
    for(const name of ['unmute_member','recall_message','set_member_card'])assert.throws(()=>load(`[${scope}.tools]\n${name}={mode="direct",max_seconds=10}`),ConfigError);
    for(const value of ['true','[]','"secret"'])assert.throws(()=>load(`[${scope}]\nconfirmation=${value}`),ConfigError);
    assert.throws(()=>load(`[${scope}.confirmation]\nconfirmation_ttl_seconds=60`),ConfigError);
    assert.throws(()=>load(`[${scope}.tools]\nmax_mute_seconds=600`),ConfigError);
  }
});
