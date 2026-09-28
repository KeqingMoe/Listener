import test from 'node:test';
import {withFixtureModel} from './config-fixture.js';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {ConfigError,loadAppConfig,dashboardPassword} from '../src/config/loader.js';
import { OWNER_ID } from '../src/contracts/identity.js';
function fixture(t:{after(fn:()=>void):void},source=''){
 const dir=mkdtempSync(join(tmpdir(),'config-schema-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));mkdirSync(join(dir,'prompts'));writeFileSync(join(dir,'prompts/listener.md'),'默认人设');
 const config=(s:string)=>writeFileSync(join(dir,'config.toml'),withFixtureModel(s));config(source);
 return {dir,config,dotenv:(s:string)=>writeFileSync(join(dir,'.env'),s),load:(env:NodeJS.ProcessEnv={ONEBOT_ACCESS_TOKEN:'token',OPENAI_API_KEY:'fixture-key'},envPath?:string)=>loadAppConfig({configPath:join(dir,'config.toml'),env,envPath})};
}
test('complete app/group defaults have no credentials in resolved policy and no implicit enabled group',t=>{
 const f=fixture(t),c=f.load(),g=c.resolveGroup('22');assert.equal(Object.hasOwn(c.runtime,'aiEnabled'),false);assert.equal(c.runtime.maxConcurrentTurns,2);assert.equal(c.model.maxTokens,8192);assert.equal(c.defaultsEnabled,false);assert.deepEqual(c.configuredGroupIds,[]);assert.equal(g.enabled,false);assert.equal(g.persona,'默认人设');assert.equal(g.personaPath,join(f.dir,'prompts/listener.md'));assert.equal(g.storage.databasePath,join(f.dir,'data/groups/22/listener.sqlite'));assert.equal(c.storage.telemetryPath,join(f.dir,'data/telemetry.sqlite'));assert.equal(c.storage.registryPath,join(f.dir,'data/group-registry.json'));assert.equal(c.identity.ownerId,OWNER_ID);assert.equal(c.onebot.allowPrivate,false);assert.deepEqual([...c.onebot.allowedGroups],[]);assert.equal(g.reply.random,false);assert.equal(g.session.compaction,false);assert.equal(g.execution.maxToolCallsPerWake,96);assert.equal(g.tools.mute_member.mode,'confirm');assert.equal(g.tools.get_member_info.mode,'direct');assert.equal('apiKey'in g,false);assert.equal('model'in g,false);assert.equal(existsSync(join(f.dir,'data')),false);
});
test('old root fields, version, and every unknown nested field are rejected without echoing input',t=>{
 const f=fixture(t);
 for(const key of ['version','ai','memory','persona','reply','tools','images','forward','attention','SENSITIVE_KEY']){f.config(`${key}="SENSITIVE_VALUE"`);assert.throws(()=>f.load(),e=>e instanceof ConfigError&&!e.message.includes('SENSITIVE'));}
 for(const scope of ['bot','onebot','model','runtime','storage','logging','defaults','defaults.reply','defaults.reply.random','defaults.session','defaults.session.compaction','defaults.execution','defaults.messages','defaults.observation','defaults.history','defaults.confirmation','defaults.storage','defaults.tools','groups."22"','groups."22".tools']){f.config(`[${scope}]\nSENSITIVE_KEY="SENSITIVE_VALUE"`);assert.throws(()=>f.load(),e=>e instanceof ConfigError&&!e.message.includes('SENSITIVE'));}
 for(const field of ['random_probability','max_parts']){f.config(`[defaults.reply]\n${field}=1`);assert.throws(()=>f.load(),ConfigError);}
 for(const source of ['[defaults.tools.moderation]\nmute="off"','[defaults.tools.extended]\nget_group_info="direct"','[defaults.persona]\nappend_file="private.md"']){f.config(source);assert.throws(()=>f.load(),ConfigError);}
});
test('unknown and malformed tables including dates cannot masquerade as policy objects',t=>{
 const f=fixture(t);for(const scope of ['bot','model','runtime','storage','logging','defaults','groups'])for(const value of ['true','[]','"x"','123','1979-05-27']){f.config(`${scope}=${value}`);assert.throws(()=>f.load(),ConfigError);}
 for(const field of ['reply','session','execution','storage','tools','messages','observation','history','confirmation'])for(const value of ['true','[]','123','"x"']){f.config(`[defaults]\n${field}=${value}`);assert.throws(()=>f.load(),ConfigError);}
});
test('numeric policy and application limits reject coercion, unsafe integers and nonfinite values',t=>{
 const f=fixture(t);const ranges:Array<[string,string,number,number]>=[['onebot','api_timeout_ms',1,2147483647],['onebot','heartbeat_ms',1,2147483647],['onebot','reconnect_base_ms',1,2147483647],['onebot','reconnect_max_ms',1,2147483647],['model','timeout_ms',1000,120000],['model','max_output_tokens',1,Number.MAX_SAFE_INTEGER],['runtime','max_concurrent_turns',1,8],['defaults.reply','cooldown_ms',1000,60000],['defaults.reply.random','cooldown_ms',1000,3600000],['defaults.reply.random','max_per_minute',1,10],['defaults.history','retention_days',1,30],['defaults.confirmation','ttl_seconds',1,60],['logging.file','retention_days',1,30],['logging.file','max_file_mb',1,100],['logging.file','max_total_mb',1,1000]];
 for(const [scope,key,min,max]of ranges)for(const value of [String(min-1),String(max+1),'1.5','nan','inf','true','"123"','[]']){f.config(`[${scope}]\n${key}=${value}`);assert.throws(()=>f.load(),ConfigError,`${scope}.${key}=${value}`);}
 for(const tokens of [1,8192,32768,Number.MAX_SAFE_INTEGER]){f.config(`[model]\nmax_output_tokens=${tokens}`);assert.equal(f.load().model.maxTokens,tokens);}
});
test('reply arrays replace entirely, accept zero delay, reject malformed shapes/order',t=>{
 const f=fixture(t);for(const value of ['[]','[100]','[1,2,3]','[-1,0]','[1,0]','[5001,6000]','[0,10001]','[0,"2"]','[0,1.5]','[0,inf]']){f.config(`[defaults.reply]\ndelay_ms=${value}`);assert.throws(()=>f.load(),ConfigError);}
 f.config('[defaults.reply]\ndelay_ms=[1000,2000]\n[groups."22".reply]\ndelay_ms=[0,0]');assert.deepEqual(f.load().resolveGroup('22').reply.delayMs,[0,0]);assert.deepEqual(f.load().resolveGroup('33').reply.delayMs,[1000,2000]);
 f.config('[onebot]\nreconnect_base_ms=2000\nreconnect_max_ms=1000');assert.throws(()=>f.load(),ConfigError);
});
test('random uses false-or-object union with independent branch defaults',t=>{
 const f=fixture(t);f.config('[defaults.reply]\nrandom={probability=0.8,cooldown_ms=1000,max_per_minute=9}\n[groups."22".reply]\nrandom={probability=0}\n[groups."33".reply]\nrandom=false');const c=f.load();assert.deepEqual(c.resolveGroup('22').reply.random,{probability:0,cooldownMs:60000,maxPerMinute:2});assert.equal(c.resolveGroup('33').reply.random,false);assert.deepEqual(c.resolveGroup('44').reply.random,{probability:0.8,cooldownMs:1000,maxPerMinute:9});
 for(const value of ['true','1','"off"','[]','{enabled=false}','{probability=-0.1}','{probability=1.1}','{probability=nan}','{probability=inf}','{probability="0.5"}']){f.config(`[groups."22".reply]\nrandom=${value}`);assert.throws(()=>f.load(),ConfigError);}
});
test('owner is canonical global configuration and is required for either admission mode',t=>{
 const f=fixture(t);for(const source of ['[defaults]\nenabled=true','[groups."22"]\nenabled=true']){f.config(source);assert.throws(()=>f.load(),e=>e instanceof ConfigError&&e.message.includes('bot.owner_id'));}
 for(const source of ['','[groups."22"]','[groups."22"]\nenabled=false']){f.config(source);assert.equal(f.load().identity.ownerId,OWNER_ID);}
 f.config('[bot]\nowner_id="778899"\n[defaults]\nenabled=true');const c=f.load();assert.deepEqual([...c.onebot.adminUsers],['778899']);assert.equal(c.resolveGroup('99').enabled,true);
 for(const value of ['1','true','[]','""','"0"','"01"','" 9"','"9 "','"9\\n"','"-9"',`"${'1'.repeat(33)}"`]){f.config(`[bot]\nowner_id=${value}`);assert.throws(()=>f.load(),ConfigError);}
});
test('strings and booleans have no coercion; removed bot group_id never grants scope',t=>{
 const f=fixture(t);for(const [scope,key]of [['runtime','ai_enabled'],['defaults','enabled'],['defaults.reply','mention'],['defaults.reply','quote_bot'],['defaults.messages','mentions'],['defaults.observation','reactions']]){f.config(`[${scope}]\n${key}="true"`);assert.throws(()=>f.load(),ConfigError);}
 for(const key of ['name','owner_name'])for(const value of ['123','""','"   "']){f.config(`[bot]\n${key}=${value}`);assert.throws(()=>f.load(),ConfigError);}
 f.config('[bot]\ngroup_id="22"');assert.throws(()=>f.load(),ConfigError);
});
test('URL security rejects credentials, query, fragment, unsupported schemes and nonlocal plaintext model URL',t=>{
 const f=fixture(t);for(const [scope,key,values]of [['onebot','url',['https://example.com','ws://user:SENSITIVE@example.com','ws://example.com/?','wss://example.com/#x','bad']],['model','base_url',['http://example.com','https://user:SENSITIVE@example.com','https://example.com/?SENSITIVE','https://example.com/#','ftp://localhost']]] as const)for(const value of values){f.config(`[${scope}]\n${key}="${value}"`);assert.throws(()=>f.load(),e=>e instanceof ConfigError&&!e.message.includes(value)&&!e.message.includes('SENSITIVE'));}
 for(const value of ['https://example.com/v1','http://localhost:8000/v1','http://127.0.0.1:8000/v1','http://[::1]:8000/v1']){f.config(`[model]\nbase_url="${value}"`);assert.equal(f.load().model.baseUrl,value);}
});
test('selected secrets remain only secrets, process environment wins without mutation',t=>{
 const f=fixture(t,'[onebot]\ntoken_env="CUSTOM_TOKEN"\n[model]\nmodel="test-model"\napi_key_env="CUSTOM_KEY"');f.dotenv('CUSTOM_TOKEN=file-token\nCUSTOM_KEY=file-key');assert.equal(f.load({}).onebot.token,'file-token');const env={CUSTOM_TOKEN:' env-token ',CUSTOM_KEY:'env-key',AI_ENABLED:'false',OPENAI_MODEL:'ignored'};const c=f.load(env);assert.equal(c.onebot.token,'env-token');assert.equal(c.model.apiKey,'env-key');assert.equal(c.model.model,'test-model');assert.deepEqual(c.runtime,{maxConcurrentTurns:2});assert.equal(env.CUSTOM_TOKEN,' env-token ');
 for(const name of ['lower','A-B','1KEY','秘密']){f.config(`[onebot]\ntoken_env="${name}"`);assert.throws(()=>f.load(),ConfigError);}
});
test('missing, empty, multiline and hidden malformed secret sources are rejected safely',t=>{
 const f=fixture(t);assert.throws(()=>f.load({}),ConfigError);for(const value of ['',' ','\nSENSITIVE','SENSITIVE\r','x\ny']){assert.throws(()=>f.load({ONEBOT_ACCESS_TOKEN:value}),ConfigError);assert.throws(()=>f.load({ONEBOT_ACCESS_TOKEN:'t',OPENAI_API_KEY:value}),ConfigError);}
 f.dotenv('ONEBOT_ACCESS_TOKEN="line\\nbreak"');assert.throws(()=>f.load({ONEBOT_ACCESS_TOKEN:'override'}),ConfigError);f.dotenv('ONEBOT_ACCESS_TOKEN=token');f.config('[model]\nmodel="test"');assert.throws(()=>f.load({}),e=>e instanceof ConfigError&&e.message.includes('model.api_key_env'));writeFileSync(join(f.dir,'config.toml'),'');assert.throws(()=>f.load({OPENAI_API_KEY:'key'}),e=>e instanceof ConfigError&&e.message.includes('model.model'));
});
test('model credentials and name are required even with no enabled groups; no AI-off field remains',t=>{
 const f=fixture(t);
 for(const source of ['', '[model]', '[model]\nmodel=""', '[model]\nmodel="   "', '[model]\nmodel=false']){
  writeFileSync(join(f.dir,'config.toml'),source);
  assert.throws(()=>f.load(),e=>e instanceof ConfigError&&e.message.includes('model.model'));
 }
 f.config('[defaults]\nenabled=false');
 assert.throws(()=>f.load({ONEBOT_ACCESS_TOKEN:'fixture-token'}),e=>e instanceof ConfigError&&e.message.includes('model.api_key_env'));
 for(const value of ['false','true']){
  f.config(`[runtime]\nai_enabled=${value}`);
  assert.throws(()=>f.load(),e=>e instanceof ConfigError&&e.message.includes('runtime')&&e.message.includes('未知字段'));
 }
});
test('dashboard dotenv credential is a private startup snapshot with explicit environment precedence',t=>{
 const f=fixture(t),value='synthetic-dashboard-secret';
 assert.equal(dashboardPassword(f.load()),undefined);
 f.dotenv(`DASHBOARD_PASSWORD=" ${value} "`);
 const loaded=f.load();assert.equal(dashboardPassword(loaded),` ${value} `);
 assert.equal(JSON.stringify(loaded).includes(value),false);
 assert.equal(JSON.stringify(loaded.resolveGroup('22')).includes(value),false);
 const env={ONEBOT_ACCESS_TOKEN:'token',OPENAI_API_KEY:'key',DASHBOARD_PASSWORD:'environment-secret'};
 assert.equal(dashboardPassword(f.load(env)),'environment-secret');
 assert.equal(dashboardPassword(f.load({...env,DASHBOARD_PASSWORD:''})), '');
 assert.equal(env.DASHBOARD_PASSWORD,'environment-secret');
 f.dotenv('DASHBOARD_PASSWORD=changed-file-secret');
 assert.equal(dashboardPassword(loaded),` ${value} `);
 for(const invalid of ['','short','line\\nbreak']){
   f.dotenv(`DASHBOARD_PASSWORD="${invalid}"`);
   assert.equal(typeof dashboardPassword(f.load()),'string');
 }
 writeFileSync(join(f.dir,'alternate.env'),'DASHBOARD_PASSWORD=alternate-secret');
 assert.equal(dashboardPassword(f.load({ONEBOT_ACCESS_TOKEN:'token',OPENAI_API_KEY:'key'},'alternate.env')),'alternate-secret');
 f.dotenv(`DASHBOARD_PASSWORD=${value}\nUNRELATED=PRIVATE_SENTINEL`);
 assert.throws(()=>f.load(),e=>e instanceof ConfigError&&!e.message.includes(value)&&!e.message.includes('PRIVATE_SENTINEL'));
});
test('dotenv rejects behavioral and unrelated entries; process variables cannot supply policy',t=>{
 const f=fixture(t);for(const key of ['AI_ENABLED','OPENAI_MODEL','ONEBOT_WS_URL','UNRELATED','OPENAI_API_KEY_OLD']){f.dotenv(`ONEBOT_ACCESS_TOKEN=token\n${key}=SENSITIVE_VALUE`);assert.throws(()=>f.load(),e=>e instanceof ConfigError&&!e.message.includes('SENSITIVE_VALUE')&&!e.message.includes(key));}
 f.dotenv('ONEBOT_ACCESS_TOKEN=token\nOPENAI_API_KEY=fixture-key');const c=f.load({AI_ENABLED:'true',ALLOWED_GROUP_IDS:'1'});assert.equal(Object.hasOwn(c.runtime,'aiEnabled'),false);assert.equal(c.resolveGroup('1').enabled,false);
});
test('persona path replaces entirely, is bounded strict UTF8 and anchored at config directory',t=>{
 const f=fixture(t,'[defaults]\npersona="default.md"\n[groups."22"]\npersona="group.md"');writeFileSync(join(f.dir,'default.md'),'default text');writeFileSync(join(f.dir,'group.md'),'replacement text');const c=f.load();assert.equal(c.resolveGroup('22').persona,'replacement text');assert.equal(c.resolveGroup('33').persona,'default text');assert.equal(c.resolveGroup('22').personaPath,join(f.dir,'group.md'));
 for(const value of ['',Buffer.alloc(16385,65),Buffer.from([0xff])]){writeFileSync(join(f.dir,'group.md'),value);assert.throws(()=>f.load(),ConfigError);}writeFileSync(join(f.dir,'group.md'),Buffer.alloc(16384,65));assert.equal(f.load().resolveGroup('22').persona.length,16384);rmSync(join(f.dir,'group.md'));assert.throws(()=>f.load(),e=>e instanceof ConfigError&&!e.message.includes('group.md'));
});
test('storage paths reject special URIs and logging validates bounds without creating outputs',t=>{
 const f=fixture(t);for(const path of ['',':memory:','file:db.sqlite?mode=memory','https://secret.invalid/db']){f.config(`[defaults.storage]\ndatabase="${path}"`);assert.throws(()=>f.load(),ConfigError);}
 f.config('[logging]\nlevel="debug"\nconsole=false\nfile={directory="private-logs",max_file_mb=1,max_total_mb=2}');const c=f.load();assert.equal(c.logging.level,'debug');assert.equal(c.logging.file,true);assert.equal(existsSync(c.logging.directory),false);
 for(const value of ['level="verbose"','level=1','console="true"','file=0','directory="https://example.test"','max_file_mb=20\nmax_total_mb=10']){f.config('[logging]\n'+value);assert.throws(()=>f.load(),ConfigError);}
});
test('logging.file is false or a strict enabled object with unchanged internal defaults',t=>{
 const f=fixture(t),defaults={level:'info',console:true,file:true,directory:join(f.dir,'data/logs'),retentionDays:7,maxFileMb:20,maxTotalMb:200};
 assert.deepEqual(f.load().logging,defaults);
 for(const source of ['[logging]\nfile={}','[logging.file]']){f.config(source);assert.deepEqual(f.load().logging,defaults);}
 f.config('[logging]\nfile=false');assert.deepEqual(f.load().logging,{...defaults,file:false});
 f.config('[storage]\ndirectory="state"\n[logging]\nfile=false');assert.equal(f.load().logging.directory,join(f.dir,'state/logs'));
 f.config('[logging]\nfile={directory="custom",retention_days=1,max_file_mb=1,max_total_mb=1}');assert.deepEqual(f.load().logging,{...defaults,directory:join(f.dir,'custom'),retentionDays:1,maxFileMb:1,maxTotalMb:1});assert.equal(existsSync(join(f.dir,'custom')),false);
 f.config('[logging.file]\nretention_days=30\nmax_file_mb=100\nmax_total_mb=1000');assert.equal(f.load().logging.maxTotalMb,1000);
 for(const value of ['true','0','[]','"off"','1979-05-27','{enabled=false}','{mode="off"}','{SENSITIVE_KEY="SENSITIVE_VALUE"}','{directory=""}','{directory="https://example.test"}','{max_file_mb=20,max_total_mb=10}']){f.config(`[logging]\nfile=${value}`);assert.throws(()=>f.load(),e=>e instanceof ConfigError&&!e.message.includes('SENSITIVE'));}
 for(const field of ['directory','retention_days','max_file_mb','max_total_mb'])for(const branch of ['false','{}']){f.config(`[logging]\nfile=${branch}\n${field}="SENSITIVE_VALUE"`);assert.throws(()=>f.load(),e=>e instanceof ConfigError&&!e.message.includes('SENSITIVE'));}
});
test('distributed example requires a model name and validates once filled without creating storage',t=>{
 const source=readFileSync(new URL('../config.example.toml',import.meta.url),'utf8'),f=fixture(t,source);
 assert.throws(()=>f.load(),e=>e instanceof ConfigError&&e.message.includes('model.model'));
 f.config(source.replace(/^model = ""/m,'model = "fixture-model"'));
 const c=f.load();assert.equal(c.defaultsEnabled,false);assert.equal(c.model.maxTokens,8192);assert.equal(existsSync(c.storage.directory),false);for(const id of c.configuredGroupIds)assert.equal('apiKey'in c.resolveGroup(id),false);
});
test('multiline inline tables and trailing commas are accepted with same semantics as dotted keys',t=>{
 const f=fixture(t,'[defaults]\nreply = {\n mention=false,\n random={probability=0.2,},\n}\n');assert.equal(f.load().resolveGroup('22').reply.mention,false);assert.deepEqual(f.load().resolveGroup('22').reply.random,{probability:0.2,cooldownMs:60000,maxPerMinute:2});
});
test('syntax errors and check CLI never expose snippets or secret markers',t=>{
 const f=fixture(t),cli=resolve('src/cli/config-check.ts'),tsx=resolve('node_modules/tsx/dist/loader.mjs'),env={PATH:process.env.PATH,ONEBOT_ACCESS_TOKEN:'SENSITIVE_TOKEN',OPENAI_API_KEY:'SENSITIVE_MODEL_KEY'};
 const ok=spawnSync(process.execPath,['--import',tsx,cli],{cwd:f.dir,env,encoding:'utf8'});assert.equal(ok.status,0,ok.stderr);assert.match(ok.stdout,/config valid/);assert.doesNotMatch(ok.stdout+ok.stderr,/SENSITIVE/);
 f.config('[model]\nmodel="SENSITIVE_PARSE');assert.throws(()=>f.load(),e=>e instanceof ConfigError&&!e.message.includes('SENSITIVE'));const bad=spawnSync(process.execPath,['--import',tsx,cli],{cwd:f.dir,env,encoding:'utf8'});assert.equal(bad.status,1);assert.doesNotMatch(bad.stderr,/SENSITIVE/);
});
