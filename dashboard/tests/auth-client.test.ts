import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/dashboard/server/app.js';
import { AuthStore } from '../../src/dashboard/server/auth.js';
import { auth, authenticated } from '../../src/dashboard/web/src/composables/useAuth.js';

test('real frontend auth requests pass actual Fastify parsing, retain login and revoke logout',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'auth-client-')),password='synthetic-long-password';
 const store=new AuthStore({path:join(dir,'auth.sqlite'),password:password});
 const app=buildApp({telemetryPath:join(dir,'missing.sqlite'),groups:[],auth:store});
 const originalFetch=globalThis.fetch;let cookie='';const packets:{method:string;hasJsonBody:boolean}[]=[];
 globalThis.fetch=async(input,init)=>{
  const headers=Object.fromEntries(new Headers(init?.headers));headers.host='localhost';headers.cookie=cookie;
  const method=init?.method==='POST'?'POST':'GET';if(method==='POST')headers.origin='http://localhost';
  if(method==='POST'){assert.equal(typeof init?.body,'string');assert.equal(typeof JSON.parse(String(init?.body)),'object');}
  packets.push({method,hasJsonBody:typeof init?.body==='string'});
  const result=await app.inject({method,url:String(input),headers,...(init?.body!==undefined?{payload:String(init.body)}:{})});
  const setCookie=result.headers['set-cookie'];if(typeof setCookie==='string')cookie=setCookie.split(';')[0]!;
  return new Response(result.body,{status:result.statusCode,headers:{'content-type':'application/json'}});
 };
 try{
  await auth();assert.equal(authenticated.value,false);
  await auth('login',{password});assert.equal(authenticated.value,true);
  await auth();assert.equal(authenticated.value,true);
  await auth('logout');assert.equal(authenticated.value,false);
  await auth();assert.equal(authenticated.value,false);
  assert.ok(packets.filter(p=>p.method==='POST').every(p=>p.hasJsonBody));
 }finally{globalThis.fetch=originalFetch;authenticated.value=null;await app.close();store.close();rmSync(dir,{recursive:true,force:true});}
});
