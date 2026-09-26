import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildApp } from "../server/app.js";
import { status as statusLabel } from "../web/src/api/client.js";
const sentinel = "PRIVATE_ARGUMENT_RESULT_MESSAGE_CHECKPOINT_PATH";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-"));
  const telemetryPath = join(dir, "telemetry.sqlite"),
    sessionPath = join(dir, "session.sqlite");
  const t = new DatabaseSync(telemetryPath);
  t.exec(
    "CREATE TABLE model_requests(request_id TEXT,group_id TEXT,turn_id TEXT,started_at INTEGER,ended_at INTEGER,duration_ms REAL,status TEXT,transport TEXT,input_tokens INTEGER,output_tokens INTEGER,cached_input_tokens INTEGER)",
  );
  const insert = t.prepare(
    "INSERT INTO model_requests VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  );
  insert.run(
    "request-one",
    "11",
    "NOT_WAKE_ID",
    100,
    120,
    20,
    "success",
    "responses",
    100,
    10,
    50,
  );
  insert.run(
    "request-two",
    "11",
    "NOT_WAKE_ID",
    200,
    240,
    40,
    "error",
    "responses",
    900,
    20,
    810,
  );
  insert.run(
    "request-three",
    "11",
    "NOT_WAKE_ID",
    250,
    300,
    50,
    "success",
    "responses",
    100,
    null,
    null,
  );
  insert.run(
    "foreign",
    "22",
    "wake-one",
    100,
    120,
    20,
    "success",
    "responses",
    100000,
    10,
    100000,
  );
  t.close();
  const s = new DatabaseSync(sessionPath);
  s.exec(
    "CREATE TABLE model_session_meta(singleton INTEGER,group_id TEXT,checkpoint TEXT);CREATE TABLE model_session_journal(seq INTEGER PRIMARY KEY,session_id TEXT,wake_id TEXT,kind TEXT,payload TEXT,created_at INTEGER);CREATE TABLE model_session_messages(seq INTEGER,session_id TEXT,wake_id TEXT,request_id TEXT,message TEXT);CREATE TABLE model_tool_ledger(ordinal INTEGER,name TEXT,wake_id TEXT,state TEXT,arguments TEXT,result TEXT,proposed_at INTEGER,started_at INTEGER,finished_at INTEGER)",
  );
  s.prepare("INSERT INTO model_session_meta VALUES(1,?,?)").run("11", sentinel);
  s.prepare("INSERT INTO model_session_journal VALUES(1,?,?,?,?,?)").run(
    "session",
    "wake-one",
    "wake_begin",
    JSON.stringify({ private: sentinel }),
    90,
  );
  s.prepare("INSERT INTO model_session_journal VALUES(2,?,?,?,?,?)").run(
    "session",
    "wake-one",
    "wake_finish",
    JSON.stringify({ reason: "completed", private: sentinel }),
    130,
  );
  s.prepare("INSERT INTO model_session_journal VALUES(3,?,?,?,?,?)").run(
    "session",
    "wake-two",
    "wake_begin",
    "{}",
    190,
  );
  s.prepare("INSERT INTO model_session_messages VALUES(1,?,?,?,?)").run(
    "session",
    "wake-one",
    "request-one",
    sentinel,
  );
  s.prepare("INSERT INTO model_session_messages VALUES(2,?,?,?,?)").run(
    "session",
    "wake-two",
    "request-two",
    sentinel,
  );
  s.prepare("INSERT INTO model_tool_ledger VALUES(1,?,?,?,?,?,?,?,?)").run(
    "read_events",
    "wake-one",
    "finished",
    sentinel,
    JSON.stringify({ status: "ok", private: sentinel }),
    105,
    106,
    110,
  );
  s.close();
  return {
    dir,
    sessionPath,
    telemetryPath,
    options: {
      groups: [{ groupId: "11", sessionPath }],
      telemetryPath,
      now: () => 300,
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
for (const [outcome, label] of [["operation_submitted", "操作已提交"], ["message_submitted", "消息已提交"], ["reaction_submitted", "回应已提交"]]) {
  test(`normal ${outcome} remains submitted rather than unknown in dashboard projection`, async () => {
    const f=fixture();
    const db=new DatabaseSync(f.sessionPath);
    db.prepare("UPDATE model_session_journal SET payload=? WHERE kind='wake_finish'").run(JSON.stringify({reason:outcome,private:sentinel}));
    db.close();
    const app=buildApp(f.options);
    try {
      const response=await app.inject("/api/wakes/wake-one?groupId=11");
      assert.equal(response.statusCode,200);
      assert.equal(response.json().wake.outcome,outcome);
      assert.equal(statusLabel(outcome!),label);
      assert.doesNotMatch(response.body,new RegExp(sentinel));
    } finally { await app.close();f.cleanup(); }
  });
}

test("safe metadata, weighted usage, missing coverage, and enabled-group isolation", async () => {
  const f = fixture(),
    app = buildApp(f.options);
  try {
    const r = await app.inject("/api/overview?since=0&until=300");
    assert.equal(r.statusCode, 200);
    const b = r.json();
    assert.equal(b.summary.requests, 3);
    assert.equal(b.summary.inputTokens, 1100);
    assert.equal(b.summary.cacheHitRate, 0.86);
    assert.equal(b.summary.cacheCoverage, 2 / 3);
    assert.equal(b.summary.uncachedInputTokens, 140);
    assert.equal(b.groups.length, 1);
    assert.doesNotMatch(r.body, new RegExp(sentinel + "|NOT_WAKE_ID|foreign"));
    assert.equal(
      (await app.inject("/api/overview?groupId=22")).statusCode,
      400,
    );
    assert.equal(
      (await app.inject("/api/meta")).json().groups[0].groupId,
      "11",
    );
  } finally {
    await app.close();
    f.cleanup();
  }
});
test("wake correlation uses request IDs, safe detail projection, bound pagination", async () => {
  const f = fixture(),
    app = buildApp(f.options);
  try {
    const r = await app.inject("/api/wakes?since=0&until=300&limit=1"),
      b = r.json();
    assert.equal(r.statusCode, 200);
    assert.equal(b.items[0].wakeId, "wake-two");
    assert.equal(b.items[0].modelRequests, 1);
    assert.equal(b.items[0].inputTokens, 900);
    assert.ok(b.nextCursor);
    const next = (
      await app.inject(
        `/api/wakes?since=0&until=300&limit=1&cursor=${b.nextCursor}`,
      )
    ).json();
    assert.equal(next.items[0].wakeId, "wake-one");
    assert.equal(next.nextCursor, null);
    assert.equal(
      (await app.inject(`/api/wakes?since=1&until=300&cursor=${b.nextCursor}`))
        .statusCode,
      400,
    );
    const detail = await app.inject("/api/wakes/wake-one?groupId=11");
    assert.equal(detail.statusCode, 200);
    const d = detail.json();
    assert.equal(d.wake.outcome, "completed");
    assert.equal(d.wake.trigger, null);
    assert.equal(d.requests[0].requestId, "request-one");
    assert.equal(d.tools[0].name, "read_events");
    assert.equal(d.wake.durationMs, 40);
    assert.doesNotMatch(
      detail.body,
      new RegExp(sentinel + "|arguments|checkpoint|NOT_WAKE_ID"),
    );
    assert.equal((await app.inject("/api/wakes/wake-one")).statusCode, 400);
    assert.equal(
      (await app.inject("/api/wakes/nope?groupId=11")).statusCode,
      404,
    );
    const tools = (await app.inject("/api/tools?since=0&until=300")).json();
    assert.equal(tools.items[0].calls, 1);
  } finally {
    await app.close();
    f.cleanup();
  }
});
test("read-only connections do not mutate files and missing files are not created", async () => {
  const f = fixture(),
    before = readFileSync(f.sessionPath),
    app = buildApp({
      ...f.options,
      groups: [
        ...f.options.groups,
        { groupId: "33", sessionPath: join(f.dir, "missing.sqlite") },
      ],
    });
  try {
    assert.equal(
      (await app.inject("/api/meta")).json().availability.sessions[1].available,
      false,
    );
    assert.equal(
      (await app.inject("/api/wakes/any?groupId=33")).statusCode,
      503,
    );
    assert.equal(existsSync(join(f.dir, "missing.sqlite")), false);
    assert.deepEqual(readFileSync(f.sessionPath), before);
  } finally {
    await app.close();
    f.cleanup();
  }
});
test("rejects DNS rebinding, foreign origins, mutation and invalid range parameters", async () => {
  const f = fixture(),
    app = buildApp(f.options);
  try {
    for (const headers of [
      { host: "evil.example" },
      { host: "localhost.evil.example" },
      { host: "127.0.0.1", origin: "http://evil.example" },
      { host: "127.0.0.1", "sec-fetch-site": "cross-site" },
    ])
      assert.equal(
        (await app.inject({ url: "/api/meta", headers })).statusCode,
        403,
      );
    assert.equal(
      (await app.inject({ method: "POST", url: "/api/meta" })).statusCode,
      403,
    );
    for (const query of [
      "since=-1",
      "until=Infinity",
      "since=2&until=1",
      "since=0&until=2678400001",
      "groupId=11%27",
      "limit=101",
      "limit=0",
      "cursor=bad",
      "foo=bar",
    ])
      assert.equal(
        (await app.inject("/api/wakes?" + query)).statusCode,
        400,
        query,
      );
    const r = await app.inject("/api/meta");
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers["access-control-allow-origin"], undefined);
  } finally {
    await app.close();
    f.cleanup();
  }
});
test("static SPA stays same-origin and unknown APIs do not return HTML", async () => {
  const f = fixture(),
    web = join(f.dir, "web");
  mkdirSync(web);
  writeFileSync(
    join(web, "index.html"),
    "<!doctype html><title>Dashboard fixture</title>",
  );
  writeFileSync(join(web, ".secret"), "SENTINEL");
  const app = buildApp({ ...f.options, webRoot: web });
  try {
    const r = await app.inject({
      url: "/wakes",
      headers: { host: "localhost:3210", origin: "http://localhost:3210" },
    });
    assert.equal(r.statusCode, 200);
    assert.match(r.body, /Dashboard fixture/);
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal((await app.inject("/api/unknown")).statusCode, 404);
    assert.equal((await app.inject("/.secret")).statusCode, 404);
    assert.equal(
      (
        await app.inject({
          url: "/api/meta",
          headers: { host: "localhost:3210", origin: "http://localhost:9999" },
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
    f.cleanup();
  }
});
test("query resource bounds report unavailable rather than partial totals", async () => {
  const f = fixture();
  const db = new DatabaseSync(f.telemetryPath);
  db.exec(
    "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10001) INSERT INTO model_requests SELECT 'bulk-'||x,'11','private',100,101,1,'success','chat',1,1,0 FROM n",
  );
  db.close();
  const app = buildApp(f.options);
  try {
    const r = await app.inject("/api/overview?since=0&until=300");
    assert.equal(r.statusCode, 503);
    assert.match(r.json().message, /narrower/);
    assert.doesNotMatch(r.body, /sqlite|SELECT|private/);
  } finally {
    await app.close();
    f.cleanup();
  }
});
test("terminal tool outcomes distinguish finished unknown, skipped, errors and future statuses", async () => {
  const f = fixture(),
    db = new DatabaseSync(f.sessionPath);
  const insert = db.prepare(
    "INSERT INTO model_tool_ledger VALUES(?,?,?,?,?,?,?,?,?)",
  );
  for (const [i, status] of [
    "unknown",
    "skipped",
    "error",
    "future",
    "executed",
  ].entries())
    insert.run(
      i + 2,
      "read_events",
      "wake-one",
      "finished",
      sentinel,
      JSON.stringify({ status }),
      110,
      111,
      112,
    );
  db.close();
  const app = buildApp(f.options);
  try {
    const summary = (await app.inject("/api/tools?since=0&until=300")).json()
      .items[0];
    assert.equal(summary.calls, 6);
    assert.equal(summary.finished, 6);
    assert.equal(summary.unknown, 2);
    assert.equal(summary.skipped, 1);
    assert.equal(summary.errors, 1);
  } finally {
    await app.close();
    f.cleanup();
  }
});
test("unavailable telemetry and wrong group identity remain honest", async () => {
  const f = fixture(),
    app = buildApp({
      ...f.options,
      telemetryPath: join(f.dir, "absent"),
      groups: [{ groupId: "22", sessionPath: f.sessionPath }],
    });
  try {
    const meta = (await app.inject("/api/meta")).json();
    assert.equal(meta.availability.telemetry, false);
    assert.equal(meta.availability.sessions[0].available, false);
    const summary = (await app.inject("/api/overview")).json().summary;
    assert.equal(summary.inputTokens, null);
    assert.equal(summary.cacheHitRate, null);
    assert.equal(summary.cacheCoverage, null);
    assert.equal(existsSync(join(f.dir, "absent")), false);
  } finally {
    await app.close();
    f.cleanup();
  }
});
