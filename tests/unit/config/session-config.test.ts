import test from 'node:test';
import {withFixtureModel} from '../../support/config-fixture.ts';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadAppConfig,ConfigError} from '../../../src/config/loader.ts';
import type {AppConfig} from '../../../src/config/app.ts';
import {toListenerConfig} from '../../../src/config/runtime.ts';
function fixture(t:{after(fn:()=>void):void}){
  const dir=mkdtempSync(join(tmpdir(),'session-policy-config-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  mkdirSync(join(dir,'prompts'));writeFileSync(join(dir,'prompts/listener.md'),'persona');
  return(source:string):AppConfig=>{writeFileSync(join(dir,'config.toml'),withFixtureModel(source));return loadAppConfig({configPath:join(dir,'config.toml'),env:{ONEBOT_ACCESS_TOKEN:'fixture',OPENAI_API_KEY:'fixture-key'}});};
}
test('global model transport strictly accepts strings or an explicit responses incremental object',t=>{
  const load=fixture(t);
  assert.equal(load('').model.transport,'chat');
  for(const value of ['chat','responses'])assert.equal(load(`[model]\ntransport="${value}"`).model.transport,value);
  for(const incremental of [false,true])for(const source of [
    `transport={type="responses",incremental=${incremental},}`,
    `transport={\n type="responses",\n incremental=${incremental},\n}`,
    `[model.transport]\ntype="responses"\nincremental=${incremental}`,
  ]){
    const app=load(`[model]\n${source}\n[groups."11"]`);
    assert.deepEqual(app.model.transport,{type:'responses',incremental});
    for(const id of ['11','99']){
      const group=app.resolveGroup(id);
      assert.equal(Object.hasOwn(group.session,'transport'),false);
      assert.deepEqual(toListenerConfig(app,group).transport,{type:'responses',incremental});
    }
  }
  for(const value of ['"Responses"','"openai"','true','false','1','[]','{}','{type="chat"}','{type="chat",incremental=false}','{type="responses"}','{incremental=true}','{type="responses",incremental="false"}','{type="responses",incremental=0}','{type="responses",incremental=false,unknown="PRIVATE_VALUE"}'])
    assert.throws(()=>load(`[model]\ntransport=${value}`),e=>e instanceof ConfigError&&e.message.includes('model.transport')&&!e.message.includes('PRIVATE_VALUE'));
  for(const scope of ['defaults','groups."11"'])for(const body of ['transport="chat"','model.transport="responses"','session.transport="responses"'])
    assert.throws(()=>load(`[${scope}]\nenabled=false\n${body}`),ConfigError);
  for(const incremental of [false,true])assert.deepEqual(load(`[model]\ntransport={type="responses",incremental=${incremental}}\n[defaults.session]\ncompaction={threshold_tokens=100}`).resolveGroup('11').session.compaction,{thresholdTokens:100});
});
test('session defaults are local transcript bounds, not provider compaction or group enablement',t=>{
  const app=fixture(t)(''),g=app.resolveGroup('11');
  assert.deepEqual(g.session,{maxTranscriptBytes:524288,compaction:false});assert.equal(g.enabled,false);assert.equal(app.model.model,'fixture-model');
});
test('ordinary session fields inherit independently across configured and dynamic groups',t=>{
  const app=fixture(t)('[model]\ntransport="responses"\n[defaults.session]\nmax_transcript_bytes=1048576\n[groups."11".session]\n[groups."22".session]\nmax_transcript_bytes=65536');
  assert.equal(app.model.transport,'responses');
  assert.deepEqual(app.resolveGroup('11').session,{maxTranscriptBytes:1048576,compaction:false});
  assert.deepEqual(app.resolveGroup('22').session,{maxTranscriptBytes:65536,compaction:false});
  const g=app.resolveGroup('99');assert.equal(g.session.maxTranscriptBytes,1048576);g.session.maxTranscriptBytes=65536;assert.equal(app.resolveGroup('99').session.maxTranscriptBytes,1048576);
});
test('responses compaction object is accepted as configuration, never a user supplied runtime verification claim',t=>{
  const load=fixture(t);
  for(const scope of ['defaults.session','groups."11".session'])for(const threshold of [1,65536,1000001,Number.MAX_SAFE_INTEGER]){
    const app=load(`[model]\ntransport="responses"\n[${scope}]\ncompaction={threshold_tokens=${threshold}}`);
    assert.deepEqual(app.resolveGroup('11').session.compaction,{thresholdTokens:threshold});
    assert.equal(app.model.model,'fixture-model'); // Parsing is not evidence that a provider supports compression.
  }
  for(const scope of ['defaults.session','groups."11".session'])for(const body of ['compaction={threshold_tokens=100,verified=true}','compaction={threshold_tokens=100,server_compaction_verified=true}','compaction={threshold_tokens=100,enabled=true}','verified=true'])
    assert.throws(()=>load(`[model]\ntransport="responses"\n[${scope}]\n${body}`),ConfigError);
});
test('compaction is a whole union: false clears inherited options and object replacement requires its own threshold',t=>{
  const load=fixture(t),base='[model]\ntransport="responses"\n[defaults.session]\ncompaction={threshold_tokens=4096}\n';
  const app=load(base+'[groups."11".session]\ncompaction=false\n[groups."22".session]\ncompaction={threshold_tokens=8192}');
  assert.equal(app.resolveGroup('11').session.compaction,false);assert.equal(app.model.transport,'responses');
  assert.deepEqual(app.resolveGroup('22').session.compaction,{thresholdTokens:8192});assert.deepEqual(app.resolveGroup('99').session.compaction,{thresholdTokens:4096});
  const snapshot=app.resolveGroup('99').session.compaction;assert.notEqual(snapshot,false);if(snapshot!==false)snapshot.thresholdTokens=1;
  assert.deepEqual(app.resolveGroup('99').session.compaction,{thresholdTokens:4096});
  assert.throws(()=>load(base+'[groups."11".session]\ncompaction={}'),ConfigError);
  assert.throws(()=>load(base+'[groups."11"]\nenabled=false\n[groups."11".session]\ntransport="chat"'),ConfigError);
  assert.throws(()=>load(base+'[bot]\nowner_id="778899"\n[groups."11"]\nenabled=true\n[groups."11".session]\ntransport="chat"'),ConfigError);
});
test('compaction rejects product-state aliases, missing thresholds, malformed values and chat combinations',t=>{
  const load=fixture(t);
  for(const scope of ['defaults.session','groups."11".session']){
    for(const value of ['true','0','1','[]','{}','"off"','"auto"','{enabled=false,threshold_tokens=1024}'])assert.throws(()=>load(`[model]\ntransport="responses"\n[groups."11"]\nenabled=false\n[${scope}]\ncompaction=${value}`),ConfigError);
    for(const value of ['0','-1','1.5','"4096"','false','[]','{}','nan','inf','-inf','9007199254740992'])assert.throws(()=>load(`[model]\ntransport="responses"\n[groups."11"]\nenabled=false\n[${scope}]\ncompaction={threshold_tokens=${value}}`),ConfigError);
    for(const body of ['compaction={threshold_tokens=1}','transport="chat"\ncompaction={threshold_tokens=4096}','compaction=false\nthreshold_tokens=4096','compaction=false\ncompact_threshold=4096','server_compaction="off"'])assert.throws(()=>load(`[${scope}]\n${body}`),ConfigError);
  }
});
test('session transport, transcript numeric endpoints, unknown fields and invalid table types remain strict',t=>{
  const load=fixture(t);
  for(const scope of ['defaults.session','groups."11".session']){
    for(const value of [65536,8388608])assert.equal(load(`[${scope}]\nmax_transcript_bytes=${value}`).resolveGroup('11').session.maxTranscriptBytes,value);
    for(const value of ['65535','8388609','0','"524288"','true','1.5','nan','inf','[]','{}'])assert.throws(()=>load(`[groups."11"]\nenabled=false\n[${scope}]\nmax_transcript_bytes=${value}`),ConfigError);
    for(const value of ['"chat"','"responses"','{type="responses",incremental=false}','"openai"','"Responses"','true','1','[]','{}'])assert.throws(()=>load(`[${scope}]\ntransport=${value}`),ConfigError);
    for(const field of ['api_key_env','api_key','base_url','model','timeout_ms','max_output_tokens','max_concurrent_turns','session_max_context_bytes','unknown_transport'])assert.throws(()=>load(`[groups."11"]\nenabled=false\n[${scope}]\n${field}="PRIVATE_VALUE"`),e=>e instanceof ConfigError&&!e.message.includes('PRIVATE_VALUE'));
  }
  for(const scope of ['defaults','groups."11"'])for(const value of ['false','true','[]','"chat"','1'])assert.throws(()=>load(`[${scope}]\nsession=${value}`),ConfigError);
  assert.throws(()=>load('[ai]\ntransport="responses"'),ConfigError);
});
