import test from "node:test";
import assert from "node:assert/strict";
import {
  GroupActionTools,
  GROUP_ACTION_TOOL_NAMES,
} from "../../../../src/tools/actions/tools.js";
import type { Api } from "../../../../src/contracts/onebot.js";
import type { JsonObject } from "../../../../src/contracts/json.js";
import type { TurnContext } from "../../../../src/contracts/tools.js";

const groupId = "123456",
  selfId = "333",
  target = "555";
const ctx: TurnContext = { groupId, selfId, actorId: "444", messageId: "1" };
const args = { user_id: target };
function fixture(
  options: {
    enabled?: readonly string[];
    write?: (action: string, params: JsonObject) => unknown | Promise<unknown>;
    read?: (action: string, params: JsonObject) => unknown | Promise<unknown>;
  } = {},
) {
  const calls: Array<{ action: string; params: JsonObject }> = [];
  const writes: Array<{ action: string; params: JsonObject }> = [];
  const api: Api = {
    async call(action, params = {}) {
      calls.push({ action, params });
      if (["get_login_info", "get_group_member_info"].includes(action)) {
        const custom = await options.read?.(action, params);
        if (custom !== undefined) return custom;
        return action === "get_login_info"
          ? { user_id: selfId }
          : {
              group_id: groupId,
              user_id: params.user_id,
              role: params.user_id === selfId ? "owner" : "member",
            };
      }
      writes.push({ action, params });
      return options.write ? await options.write(action, params) : null;
    },
  };
  return {
    calls,
    writes,
    tools: new GroupActionTools(
      api,
      groupId,
      options.enabled ?? GROUP_ACTION_TOOL_NAMES,
    ),
  };
}
function submitted(result: JsonObject) {
  assert.equal(result.status, "ok");
  assert.equal(result.action, "poke_member");
  assert.equal(result.group_id, groupId);
  assert.equal(result.submitted, true);
  assert.equal(result.delivery_confirmed, false);
  assert.match(String(result.note), /不提供送达确认/);
  assert.equal(result.cached, undefined);
  assert.equal(result.executed, undefined);
  assert.equal(result.count, undefined);
}
for (const concurrent of [false, true]) {
  test(`ten explicit ${concurrent ? "concurrent" : "sequential"} pokes submit ten independent writes with fresh proofs`, async () => {
    const f = fixture();
    const results: JsonObject[] = [];
    if (concurrent)
      results.push(
        ...(await Promise.all(
          Array.from({ length: 10 }, () =>
            f.tools.execute("poke_member", args, ctx),
          ),
        )),
      );
    else
      for (let i = 0; i < 10; i++)
        results.push(await f.tools.execute("poke_member", args, ctx));
    results.forEach(submitted);
    assert.equal(f.writes.length, 10);
    for (const write of f.writes)
      assert.deepEqual(write, {
        action: "group_poke",
        params: { group_id: groupId, user_id: target },
      });
    assert.equal(
      f.calls.filter((c) => c.action === "get_login_info").length,
      10,
    );
    assert.equal(
      f.calls.filter(
        (c) =>
          c.action === "get_group_member_info" && c.params.user_id === selfId,
      ).length,
      10,
    );
    assert.equal(
      f.calls.filter(
        (c) =>
          c.action === "get_group_member_info" && c.params.user_id === target,
      ).length,
      10,
    );
    assert.deepEqual(
      f.calls.map((c) => c.action),
      Array.from({ length: 10 }, () => [
        "get_login_info",
        "get_group_member_info",
        "get_group_member_info",
        "group_poke",
      ]).flat(),
    );
  });
}
test("normal submission creates no member lock and does not deduplicate a later independent poke", async () => {
  const f = fixture();
  submitted(await f.tools.execute("poke_member", args, ctx));
  submitted(await f.tools.execute("poke_member", args, ctx));
  assert.equal(
    (
      await f.tools.execute(
        "set_group_admin",
        { user_id: target, enable: true },
        ctx,
      )
    ).status,
    "ok",
  );
  assert.deepEqual(
    f.writes.map((c) => c.action),
    ["group_poke", "group_poke", "set_group_admin"],
  );
});
test("poke exception remains unknown without automatic replay and only locks its own family and target", async () => {
  const f = fixture({
    write(action, params) {
      if (action === "group_poke" && params.user_id === target)
        throw new Error("PRIVATE/token");
      return null;
    },
  });
  const first = await f.tools.execute("poke_member", args, ctx);
  assert.equal(first.status, "unknown");
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE/);
  assert.equal(
    (await f.tools.execute("poke_member", args, ctx)).error,
    "previous_result_unknown",
  );
  assert.equal(f.writes.length, 1);
  submitted(await f.tools.execute("poke_member", { user_id: "666" }, ctx));
  assert.equal(
    (
      await f.tools.execute(
        "kick_member",
        { user_id: target, reject_add_request: false },
        ctx,
      )
    ).status,
    "ok",
  );
  assert.deepEqual(
    f.writes.map((c) => c.action),
    ["group_poke", "group_poke", "set_group_kick"],
  );
});
test("unknown poke does not contaminate independent member administration", async () => {
  const f = fixture({
    write(action) {
      if (action === "group_poke") return { result: 0 };
      return null;
    },
  });
  assert.equal(
    (await f.tools.execute("poke_member", args, ctx)).status,
    "unknown",
  );
  assert.equal(
    (
      await f.tools.execute(
        "set_group_admin",
        { user_id: target, enable: true },
        ctx,
      )
    ).status,
    "ok",
  );
  assert.deepEqual(
    f.writes.map((c) => c.action),
    ["group_poke", "set_group_admin"],
  );
});
test("non-null shapes never become submission or delivery confirmation, and stay locked", async () => {
  for (const shape of [
    undefined,
    {},
    { result: 0 },
    { status: "ok" },
    { message_id: 1 },
    false,
    0,
    [],
  ]) {
    const f = fixture({ write: () => shape });
    const first = await f.tools.execute("poke_member", args, ctx);
    assert.equal(first.status, "unknown");
    assert.equal(first.submitted, undefined);
    assert.equal(first.delivery_confirmed, undefined);
    assert.equal(
      (await f.tools.execute("poke_member", args, ctx)).error,
      "previous_result_unknown",
    );
    assert.equal(f.writes.length, 1);
  }
});
test("concurrent pokes after the first uncertain exception cannot retry the target automatically", async () => {
  const f = fixture({
    write() {
      throw new Error("private native failure");
    },
  });
  const results = await Promise.all(
    Array.from({ length: 10 }, () => f.tools.execute("poke_member", args, ctx)),
  );
  assert.ok(results.every((r) => r.status === "unknown"));
  assert.equal(f.writes.length, 1);
});
test("late null after dispatch records submission even when the caller aborts", async () => {
  const controller = new AbortController();
  const f = fixture({
    write() {
      controller.abort();
      return null;
    },
  });
  const result = await f.tools.execute(
    "poke_member",
    args,
    ctx,
    controller.signal,
  );
  submitted(result);
  assert.equal(result.cancelled_after_dispatch, true);
  assert.equal(f.writes.length, 1);
  // No lock was installed: another explicit call with a live context remains independent.
  submitted(await f.tools.execute("poke_member", args, ctx));
  assert.equal(f.writes.length, 2);
});
test("disabled, cross-group, invented count and pre-dispatch cancellation never write", async () => {
  const off = fixture({ enabled: [] });
  assert.equal(
    (await off.tools.execute("poke_member", args, ctx)).error,
    "tool_disabled",
  );
  assert.equal(off.calls.length, 0);
  const f = fixture();
  assert.equal(
    (await f.tools.execute("poke_member", args, { ...ctx, groupId: "999" }))
      .error,
    "forbidden_group",
  );
  assert.equal(
    (await f.tools.execute("poke_member", { ...args, count: 10 }, ctx)).error,
    "invalid_arguments",
  );
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    (await f.tools.execute("poke_member", args, ctx, controller.signal)).error,
    "cancelled",
  );
  assert.equal(f.calls.length, 0);
  const during = new AbortController();
  const pending = fixture({
    read(action) {
      if (action === "get_group_member_info") during.abort();
    },
  });
  assert.equal(
    (await pending.tools.execute("poke_member", args, ctx, during.signal))
      .error,
    "cancelled",
  );
  assert.equal(pending.writes.length, 0);
});
test("every accepted poke revalidates live target identity before the next independent intent", async () => {
  let present = true;
  const f = fixture({
    read(action, params) {
      if (
        action === "get_group_member_info" &&
        params.user_id === target &&
        !present
      )
        return { group_id: "999", user_id: target, role: "member" };
    },
  });
  submitted(await f.tools.execute("poke_member", args, ctx));
  present = false;
  assert.equal(
    (await f.tools.execute("poke_member", args, ctx)).error,
    "verification_failed",
  );
  assert.equal(f.writes.length, 1);
});
test('uncertain sign or kick protects its family without freezing unrelated pokes; leave protects membership',async()=>{
 for(const [name,parameters] of [['kick_member',{user_id:target,reject_add_request:false}],['group_sign',{}],['leave_group',{}]] as const){
  const f=fixture({write:action=>action==='group_poke'?null:undefined});
  assert.equal((await f.tools.execute(name,parameters,ctx)).status,'unknown');
  assert.equal((await f.tools.execute(name,parameters,ctx)).error,'previous_result_unknown');
  const poke=await f.tools.execute('poke_member',args,ctx);
  if(name==='leave_group'){assert.equal(poke.error,'previous_result_unknown');assert.equal(f.writes.length,1);}
  else{submitted(poke);assert.equal(f.writes.length,2);}
 }
});
