import test from 'node:test';
import {withFixtureModel} from '../../support/config-fixture.js';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadAppConfig,ConfigError} from '../../../src/config/loader.js';
import type {AppConfig} from '../../../src/config/app.js';
function fixture(t:{after(fn:()=>void):void}){
  const dir=mkdtempSync(join(tmpdir(),'reaction-policy-config-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  mkdirSync(join(dir,'prompts'));writeFileSync(join(dir,'prompts/listener.md'),'persona');
  return(source:string):AppConfig=>{writeFileSync(join(dir,'config.toml'),withFixtureModel(source));return loadAppConfig({configPath:join(dir,'config.toml'),env:{ONEBOT_ACCESS_TOKEN:'fixture',OPENAI_API_KEY:'fixture-key'}});};
}
test('background observation and reaction tools default on without enabling a group',t=>{
  const app=fixture(t)(''),g=app.resolveGroup('11');
  assert.deepEqual(g.observation,{reactions:true});assert.equal(g.tools.react_message.mode,'direct');assert.equal(g.tools.get_reaction_users.mode,'direct');
  assert.equal(g.enabled,false);assert.equal(g.messages.mentions,true);assert.equal(g.tools.get_group_members.mode,'direct');
});
test('all observation/tool combinations are independently expressible without implicit service enablement',t=>{
  const load=fixture(t);
  for(const observe of [false,true])for(const react of ['off','direct'])for(const users of ['off','direct']){
    const app=load(`[defaults.observation]\nreactions=${observe}\n[defaults.tools]\nreact_message="${react}"\nget_reaction_users="${users}"`),g=app.resolveGroup('11');
    assert.equal(g.observation.reactions,observe);assert.equal(g.tools.react_message.mode,react);assert.equal(g.tools.get_reaction_users.mode,users);
    assert.equal(g.enabled,false);assert.equal(g.reply.random,false);assert.deepEqual([...app.onebot.allowedGroups],[]);
  }
});
test('group overrides keep observation, actions, user lookup, mentions and member lookup separate',t=>{
  const app=fixture(t)('[defaults.observation]\nreactions=true\n[defaults.messages]\nmentions=false\n[defaults.tools]\nreact_message="direct"\nget_reaction_users="direct"\nget_group_members="off"\n[groups."11".observation]\nreactions=false\n[groups."22".tools]\nreact_message="off"\nget_group_members="direct"\n[groups."33".tools]\nget_reaction_users="off"');
  assert.equal(app.resolveGroup('11').observation.reactions,false);assert.equal(app.resolveGroup('11').tools.react_message.mode,'direct');assert.equal(app.resolveGroup('11').tools.get_reaction_users.mode,'direct');
  assert.equal(app.resolveGroup('22').observation.reactions,true);assert.equal(app.resolveGroup('22').tools.react_message.mode,'off');assert.equal(app.resolveGroup('22').tools.get_reaction_users.mode,'direct');assert.equal(app.resolveGroup('22').tools.get_group_members.mode,'direct');
  assert.equal(app.resolveGroup('33').tools.get_reaction_users.mode,'off');assert.equal(app.resolveGroup('33').tools.get_group_members.mode,'off');
  for(const id of ['11','22','33']){const g=app.resolveGroup(id);assert.equal(g.messages.mentions,false);assert.equal(g.tools.mute_member.mode,'confirm');}
  const snapshot=app.resolveGroup('99');snapshot.observation.reactions=false;snapshot.tools.react_message.mode='off';assert.equal(app.resolveGroup('99').observation.reactions,true);assert.equal(app.resolveGroup('99').tools.react_message.mode,'direct');
});
test('observation requires literal booleans and rejects tables, unknown keys and old switches even in disabled groups',t=>{
  const load=fixture(t);
  for(const scope of ['defaults','groups."11"']){
    for(const value of ['"true"','"false"','0','1','[]','{}','1.5','nan','inf','1979-05-27'])assert.throws(()=>load(`[groups."11"]\nenabled=false\n[${scope}.observation]\nreactions=${value}`),ConfigError);
    for(const value of ['true','false'])assert.equal(load(`[${scope}.observation]\nreactions=${value}`).resolveGroup('11').observation.reactions,value==='true');
    for(const value of ['false','[]','"secret"'])assert.throws(()=>load(`[${scope}]\nobservation=${value}`),ConfigError);
    assert.throws(()=>load(`[${scope}.observation]\nreactions=true\nunknown="PRIVATE_VALUE"`),e=>e instanceof ConfigError&&!e.message.includes('PRIVATE_VALUE'));
    assert.throws(()=>load(`[${scope}.tools]\nreactions=true`),ConfigError);
    assert.throws(()=>load(`[${scope}.messages]\nmentions="false"`),ConfigError);
  }
});
test('reaction tools accept off/direct or direct objects, never confirmation, boolean modes or object off',t=>{
  const load=fixture(t);
  for(const scope of ['defaults.tools','groups."11".tools'])for(const name of ['react_message','get_reaction_users']){
    assert.equal(load(`[${scope}]\n${name}={mode="direct"}`).resolveGroup('11').tools[name as 'react_message'|'get_reaction_users'].mode,'direct');
    for(const value of ['true','false','"confirm"','{mode="confirm"}','{mode="off"}','{mode="direct",enabled=true}','{mode="direct",max_per_turn=1}'])assert.throws(()=>load(`[groups."11"]\nenabled=false\n[${scope}]\n${name}=${value}`),ConfigError);
  }
});
