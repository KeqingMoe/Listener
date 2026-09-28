import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync, symlinkSync, linkSync, chmodSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, scryptSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { AuthStore, SESSION_COOKIE, validPassword } from "../../../src/dashboard/server/auth.js";
import { buildApp } from "../../../src/dashboard/server/app.js";
const password = "test-admin-password-strong";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-auth-"));
  let now = 100000;
  const path = join(dir, "auth.sqlite");
  const auth = new AuthStore({ path, password, now: () => now });
  return {dir, path, auth, tick: (ms: number) => now += ms, cleanup: () => {auth.close(); rmSync(dir, {recursive:true, force:true});}};
}
function login(auth: AuthStore, ip = "127.0.0.1", value = password) {
  const result = auth.login(value, ip); assert.equal(result.status, "ok");
  if (result.status !== "ok") throw new Error("login failed");
  return result.token;
}
test("invalid passwords are explicitly unconfigured without exposing supplied values", () => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-invalid-"));
  try {
    for (const value of ["short", " ".repeat(12), "\u3000".repeat(12), "x".repeat(257), ...[0,9,10,13,27,31,127,128,159,0x2028,0x2029].map(code => password + String.fromCodePoint(code))]) {
      assert.equal(validPassword(value), false);
      const auth = new AuthStore({path:join(dir,"auth"),password:value});
      try {
        assert.equal(auth.configured,false);
        assert.equal(auth.configurationError,"password_invalid_configuration");
        assert.deepEqual(auth.login(value,"local"),{status:"password_invalid_configuration"});
      } finally {auth.close();}
    }
    assert.equal(validPassword("合法中文密码与空格 passphrase"), true);
    const spaced = ` ${password} `;
    const auth = new AuthStore({path:join(dir,"auth"),password:spaced});
    try {
      assert.equal(auth.configured,true);
      assert.equal(auth.login(password,"trimmed").status,"invalid");
      assert.equal(auth.login(spaced,"exact").status,"ok");
    } finally {auth.close();}
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test("persistent session digests, private files and unchanged startup credentials survive restart", () => {
  const f = fixture();
  try {
    const token = login(f.auth);
    assert.match(f.auth.cookie(token), /HttpOnly; SameSite=Strict; Path=\/; Max-Age=604800/);
    assert.doesNotMatch(f.auth.cookie(token), /Secure/);
    assert.equal(statSync(f.path).mode & 0o777, 0o600);
    assert.equal(readFileSync(f.path).includes(Buffer.from(password)), false);
    assert.equal(readFileSync(f.path).includes(Buffer.from(token)), false);
    const second = new AuthStore({path:f.path, password, now:()=>100000});
    try {assert.equal(second.authenticated(token), true);} finally {second.close();}
  } finally {f.cleanup();}
});
test("changed, removed and invalid startup environment credentials revoke all old sessions", () => {
  for (const next of ["different-strong-password", undefined, "", "short"]) {
    const f = fixture();
    try {
      const token = login(f.auth);
      const second = new AuthStore({path:f.path,password:next,now:()=>100000});
      try {
        assert.equal(second.authenticated(token),false);
        assert.equal(f.auth.authenticated(token),false);
        assert.equal(f.auth.login(password,"old-process").status,"invalid");
        if (next === "different-strong-password") {
          assert.equal(second.login(password,"old-value").status,"invalid");
          const newToken = login(second,"new-value",next);
          assert.equal(second.authenticated(newToken),true);
          assert.equal(f.auth.authenticated(newToken),false);
        } else assert.equal(second.configured,false);
      } finally {second.close();}
      const restored = new AuthStore({path:f.path,password,now:()=>100000});
      try {assert.equal(restored.authenticated(token),false);} finally {restored.close();}
    } finally {f.cleanup();}
  }
});
test("missing environment never generates a password file, and old account passwords cannot authorize", () => {
  for (const value of [undefined,password]) {
    const dir = mkdtempSync(join(tmpdir(), "dashboard-legacy-"));
    const path = join(dir,"auth.sqlite"), legacy = "legacy-database-password", token = "a".repeat(43);
    try {
      writeFileSync(path,"",{mode:0o600});
      const db = new DatabaseSync(path);
      db.exec("CREATE TABLE account(id INTEGER PRIMARY KEY,password_hash TEXT); CREATE TABLE sessions(digest TEXT PRIMARY KEY,expires INTEGER);");
      db.prepare("INSERT INTO account VALUES(1,?)").run(`salt:${scryptSync(legacy,"salt",64).toString("hex")}`);
      db.prepare("INSERT INTO sessions VALUES(?,?)").run(createHash("sha256").update(token).digest("hex"),Date.now()+86400000);
      db.close();
      const auth = new AuthStore({path,password:value});
      try {
        assert.equal(auth.configured,value !== undefined);
        assert.equal(auth.authenticated(token),false);
        assert.equal(auth.login(legacy,"legacy").status,value ? "invalid" : "password_not_configured");
        if(value) login(auth);
        assert.deepEqual(readdirSync(dir),["auth.sqlite"]);
        assert.equal("changePassword" in auth,false);
        assert.equal("resetPassword" in auth,false);
        assert.equal("initialPasswordCreated" in auth,false);
      } finally {auth.close();}
    } finally {rmSync(dir,{recursive:true,force:true});}
  }
  const dir=mkdtempSync(join(tmpdir(),"dashboard-empty-"));
  try {
    const path=join(dir,"private","auth.sqlite"),auth=new AuthStore({path});
    try {
      assert.equal(auth.configured,false);
      assert.equal(statSync(join(dir,"private")).mode & 0o777,0o700);
      assert.deepEqual(readdirSync(join(dir,"private")),["auth.sqlite"]);
    } finally {auth.close();}
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test("symlinks, hard links, permissive files and journal traps fail closed", () => {
  const dir = mkdtempSync(join(tmpdir(),"dashboard-boundary-"));
  try {
    const target=join(dir,"target"); writeFileSync(target,"",{mode:0o600});
    const symlink=join(dir,"symlink"); symlinkSync(target,symlink);
    assert.throws(()=>new AuthStore({path:symlink,password}));
    const hard=join(dir,"hard"); linkSync(target,hard);
    assert.throws(()=>new AuthStore({path:hard,password}));
    const publicFile=join(dir,"public"); writeFileSync(publicFile,"",{mode:0o644}); chmodSync(publicFile,0o644);
    assert.throws(()=>new AuthStore({path:publicFile,password}));
    const sub=join(dir,"real"); mkdirSync(sub); symlinkSync(sub,join(dir,"alias"));
    assert.throws(()=>new AuthStore({path:join(dir,"alias","auth"),password}));
    const authPath=join(dir,"auth"); const auth=new AuthStore({path:authPath,password});
    try { symlinkSync(target,authPath+"-journal"); assert.throws(()=>auth.login(password,"local")); }
    finally {auth.close();}
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test("bounded per-IP and global login rate limits and seven-day expiration", () => {
  const f=fixture();
  try {
    const a=login(f.auth);
    f.tick(7*86400000-1); assert.equal(f.auth.authenticated(a),true);
    f.tick(1); assert.equal(f.auth.authenticated(a),false);
    for(let i=0;i<5;i++) assert.equal(f.auth.login("wrong-password","bad").status,"invalid");
    assert.equal(f.auth.login("wrong-password","bad").status,"limited");
    for(let i=0;i<34;i++) f.auth.login("wrong-password",`ip${i}`);
    assert.equal(f.auth.login("wrong-password","new-ip").status,"limited");
    f.tick(60001); assert.equal(f.auth.login("wrong-password","bad").status,"invalid");
  } finally {f.cleanup();}
});
test("HTTP auth gates every API; exact auth mutations, CSRF, removed password route and cookie behavior", async () => {
  const f=fixture();
  const options={groups:[],telemetryPath:join(f.dir,"missing")};
  assert.throws(()=>buildApp(options),/authentication/);
  const web=join(f.dir,"web");mkdirSync(web);writeFileSync(join(web,"index.html"),"<title>Login shell</title>");
  const app=buildApp({...options,auth:f.auth,webRoot:web});
  const headers={host:"localhost",origin:"http://localhost"};
  try {
    assert.equal((await app.inject("/")).statusCode,200);
    for (const url of ["/api/meta","/api/overview","/api/wakes/secret","/api/tools","/api/unknown"]) assert.equal((await app.inject(url)).statusCode,401);
    assert.deepEqual((await app.inject("/api/auth/session")).json(),{authenticated:false,configured:true});
    for(const url of ["/api/auth/login?x=1","/api/auth/login/","/api/meta","/api/auth/password"]) assert.equal((await app.inject({method:"POST",url,headers,payload:{password}})).statusCode,403);
    for(const badHeaders of [{host:"evil.example",origin:"http://evil.example"},{host:"localhost"},{host:"localhost",origin:"https://localhost"},{...headers,"sec-fetch-site":"cross-site"}])
      assert.equal((await app.inject({method:"POST",url:"/api/auth/login",headers:badHeaders,payload:{password}})).statusCode,403);
    const response=await app.inject({method:"POST",url:"/api/auth/login",headers:{...headers,"x-forwarded-proto":"https"},payload:{password}});
    assert.equal(response.statusCode,200);assert.deepEqual(response.json(),{authenticated:true});
    const setCookie=String(response.headers["set-cookie"]);assert.doesNotMatch(setCookie,/Secure/);
    const cookie=setCookie.split(";")[0]!;
    assert.ok(cookie.startsWith(SESSION_COOKIE+"="));
    assert.equal((await app.inject({url:"/api/meta",headers:{cookie}})).statusCode,200);
    assert.deepEqual((await app.inject({url:"/api/auth/session",headers:{cookie}})).json(),{authenticated:true,configured:true});
    assert.equal((await app.inject({method:"POST",url:"/api/auth/password",headers:{...headers,cookie},payload:{currentPassword:password,newPassword:"new-password-long"}})).statusCode,403);
    assert.equal((await app.inject({url:"/api/auth/password",headers:{cookie}})).statusCode,404);
    assert.deepEqual((await app.inject({method:"POST",url:"/api/auth/logout",headers:{...headers,cookie}})).json(),{authenticated:false});
    assert.equal((await app.inject({url:"/api/meta",headers:{cookie}})).statusCode,401);
  } finally {await app.close();f.cleanup();}
});
test("unconfigured and invalid credentials serve the shell and explicitly fail closed for APIs", async () => {
  for (const value of [undefined,"","short"," ".repeat(12)]) {
    const dir=mkdtempSync(join(tmpdir(),"dashboard-disabled-"));
    const auth=new AuthStore({path:join(dir,"auth"),password:value});
    const web=join(dir,"web");mkdirSync(web);writeFileSync(join(web,"index.html"),"<title>Setup required</title>");
    const app=buildApp({auth,webRoot:web,groups:[],telemetryPath:join(dir,"missing")});
    const error=value ? "password_invalid_configuration" : "password_not_configured";
    try {
      assert.equal((await app.inject("/")).statusCode,200);
      assert.deepEqual((await app.inject("/api/auth/session")).json(),{authenticated:false,configured:false,...(value?{error}:{})});
      for(const url of ["/api/meta","/api/requests","/api/tools","/api/unknown","/%61pi/meta","/API/meta"]){
        const response=await app.inject(url);assert.equal(response.statusCode,503);assert.equal(response.json().error,error);
      }
      const response=await app.inject({method:"POST",url:"/api/auth/login",headers:{host:"localhost",origin:"http://localhost"},payload:{password}});
      assert.equal(response.statusCode,503);assert.equal(response.json().error,error);
      assert.equal(response.headers["set-cookie"],undefined);
      assert.doesNotMatch(response.body,/short|length|12|256/);
    } finally {await app.close();auth.close();rmSync(dir,{recursive:true,force:true});}
  }
});
test("real restart preserves session and detects database inode replacement", () => {
  const dir=mkdtempSync(join(tmpdir(),"dashboard-restart-")), path=join(dir,"auth");
  let auth=new AuthStore({path,password});
  try {
    const token=login(auth); auth.close();
    auth=new AuthStore({path,password});
    assert.equal(auth.authenticated(token),true);
    renameSync(path,path+"-old");writeFileSync(path,"",{mode:0o600});
    assert.throws(()=>auth.authenticated(token),/replaced/);
  } finally {auth.close();rmSync(dir,{recursive:true,force:true});}
});
test("secure cookie is explicit and does not depend on forwarded headers", () => {
  const dir=mkdtempSync(join(tmpdir(),"dashboard-secure-"));
  const auth=new AuthStore({path:join(dir,"auth"),password,secureCookie:true});
  try {assert.match(auth.cookie(),/; Secure$/);} finally {auth.close();rmSync(dir,{recursive:true,force:true});}
});
