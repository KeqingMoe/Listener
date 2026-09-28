import test from 'node:test';
import {withFixtureModel} from '../../support/config-fixture.js';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadAppConfig,ConfigError} from '../../../src/config/loader.js';
import type {AppConfig} from '../../../src/config/app.js';
import {TOOL_NAMES} from '../../../src/config/tool-policy.js';
import {EXTENDED_TOOL_NAMES,EXTENDED_READ_ONLY_TOOLS} from '../../../src/config/extended-tools.js';
function fixture(t:{after(fn:()=>void):void}) {
  const dir=mkdtempSync(join(tmpdir(),'tool-policy-config-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  mkdirSync(join(dir,'prompts'));writeFileSync(join(dir,'prompts/listener.md'),'synthetic persona');
  return (source:string):AppConfig=>{writeFileSync(join(dir,'config.toml'),withFixtureModel(source));return loadAppConfig({configPath:join(dir,'config.toml'),env:{ONEBOT_ACCESS_TOKEN:'fixture',OPENAI_API_KEY:'fixture-key'}});};
}
const noConfirm=new Set<string>([...EXTENDED_READ_ONLY_TOOLS,'get_group_members','get_member_info','react_message','get_reaction_users','view_images','read_forward','manage_attention']);
const scopes=['defaults.tools','groups."11".tools'] as const;
test('catalog covers existing and optional tools, defaults are complete and do not enable service',t=>{
  const expected=[...EXTENDED_TOOL_NAMES,'mute_member','unmute_member','recall_message','set_member_card','get_group_members','get_member_info','react_message','get_reaction_users','view_images','read_forward','manage_attention'];
  assert.deepEqual([...TOOL_NAMES].sort(),expected.sort());assert.equal(new Set(TOOL_NAMES).size,TOOL_NAMES.length);
  const app=fixture(t)(''),group=app.resolveGroup('11');
  assert.equal(app.defaultsEnabled,false);assert.equal(group.enabled,false);
  assert.deepEqual(Object.keys(group.tools).sort(),[...TOOL_NAMES].sort());
  const interactive=new Set(['poke_member','group_sign','send_group_image','forward_message','send_group_forward','send_group_ai_voice','send_custom_face','add_custom_face','delete_custom_face','set_custom_face_description']);
  for(const name of TOOL_NAMES)assert.equal(group.tools[name].mode,name==='leave_group'?'off':noConfirm.has(name)||interactive.has(name)?'direct':'confirm',name);
});
test('every tool validates string and object modes at both scopes including disabled groups',t=>{
  const load=fixture(t);
  for(const scope of scopes)for(const name of TOOL_NAMES)for(const mode of ['off','direct','confirm']){
    const source=`[groups."11"]\nenabled=false\n[${scope}]\n${name}="${mode}"`;
    if(mode==='confirm'&&noConfirm.has(name))assert.throws(()=>load(source),ConfigError,name);
    else assert.equal(load(source).resolveGroup('11').tools[name].mode,mode,name);
    const object=`[groups."11"]\nenabled=false\n[${scope}]\n${name}={mode="${mode}"}`;
    if(mode==='off'||(mode==='confirm'&&noConfirm.has(name)))assert.throws(()=>load(object),ConfigError,name);
    else assert.equal(load(object).resolveGroup('11').tools[name].mode,mode,name);
  }
});
test('every tool rejects coercion, implicit modes, off objects and invented options without leaking values',t=>{
  const load=fixture(t);
  for(const scope of scopes)for(const name of TOOL_NAMES)for(const value of ['true','false','0','1.5','nan','inf','[]','{}','"on"','"DIRECT"','" direct"','{mode=true}','{mode="off"}','{mode="direct",unexpected="PRIVATE_SENTINEL"}']){
    assert.throws(()=>load(`[groups."11"]\nenabled=false\n[${scope}]\n${name}=${value}`),e=>e instanceof ConfigError&&!e.message.includes('PRIVATE_SENTINEL'),`${name}=${value}`);
  }
  for(const scope of scopes)for(const name of ['moderation','extended','members','mention','reactions','send_message','read_message','finish','unknown_tool'])
    assert.throws(()=>load(`[${scope}]\n${name}="direct"`),ConfigError);
  for(const source of ['[tools.extended]\nkick_member="direct"','[defaults]\ntools=true','[groups."11"]\nenabled=false\ntools=[]'])assert.throws(()=>load(source),ConfigError);
});
test('tool union replacement resets options to branch defaults while absent tools inherit isolated copies',t=>{
  const app=fixture(t)('[defaults.tools]\nview_images={mode="direct",max_download_mb=2}\nkick_member="confirm"\n[groups."11".tools]\nview_images={mode="direct"}\nkick_member="off"\n[groups."22".tools]\nview_images="direct"\n[groups."33"]');
  assert.deepEqual(app.resolveGroup('11').tools.view_images,{mode:'direct',maxDownloadMb:10});
  assert.deepEqual(app.resolveGroup('22').tools.view_images,{mode:'direct',maxDownloadMb:10});
  const inherited=app.resolveGroup('33');assert.deepEqual(inherited.tools.view_images,{mode:'direct',maxDownloadMb:2});
  assert.equal(app.resolveGroup('11').tools.kick_member.mode,'off');assert.equal(app.resolveGroup('22').tools.kick_member.mode,'confirm');
  inherited.tools.view_images.maxDownloadMb=9;inherited.tools.kick_member.mode='direct';
  assert.equal(app.resolveGroup('33').tools.view_images.maxDownloadMb,2);assert.equal(app.resolveGroup('999').tools.kick_member.mode,'confirm');
});
test('removed image count configuration is rejected without compatibility',t=>{
  const load=fixture(t);
  for(const scope of scopes)assert.throws(()=>load(`[${scope}]\nview_images={mode="direct",max_per_turn=3}`),ConfigError);
});
test('mute duration defaults and endpoints use the platform maximum',t=>{
  const load=fixture(t);
  assert.equal(load('').resolveGroup('11').tools.mute_member.maxSeconds,2592000);
  for(const scope of scopes){
    for(const value of [601,2592000])assert.equal(load(`[${scope}]\nmute_member={mode="direct",max_seconds=${value}}`).resolveGroup('11').tools.mute_member.maxSeconds,value);
    assert.throws(()=>load(`[${scope}]\nmute_member={mode="direct",max_seconds=2592001}`),ConfigError);
  }
});
test('image option endpoints and invalid numeric or misplaced options are checked while service is disabled',t=>{
  const load=fixture(t);
  for(const scope of scopes)for(const [key,min,max,field] of [['max_download_mb',1,10,'maxDownloadMb']] as const){
    for(const value of [min,max])assert.equal(load(`[${scope}]\nview_images={mode="direct",${key}=${value}}`).resolveGroup('11').tools.view_images[field],value);
    for(const value of [String(min-1),String(max+1),'1.5','true','"1"','[]','{}','nan','inf','9007199254740992'])
      assert.throws(()=>load(`[groups."11"]\nenabled=false\n[${scope}]\nview_images={mode="direct",${key}=${value}}`),ConfigError);
    assert.throws(()=>load(`[${scope}]\npoke_member={mode="direct",${key}=1}`),ConfigError);
  }
});
