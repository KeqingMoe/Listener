import test from "node:test";
import assert from "node:assert/strict";
import {
  GROUP_ACTION_TOOL_NAMES,
  GroupActionTools,
} from "../src/group-action-tools.js";
import type {
  Api,
  JsonObject,
  Memory,
  TimelineEntry,
  TurnContext,
} from "../src/contracts.js";
const groupId = "123456",
  selfId = "333",
  actorId = "444",
  target = "555";
const ctx: TurnContext = { groupId, selfId, actorId, messageId: "1" };
const entry = (
  messageId = "1",
  userId = target,
  replyTo?: string,
): TimelineEntry => ({
  messageId,
  userId,
  nickname: "private nickname",
  text: "private message",
  time: 1,
  ...(replyTo ? { replyTo } : {}),
});
function setup(
  options: {
    enabled?: readonly string[];
    botRole?: string;
    targetRole?: string;
    write?: unknown;
    hook?: (action: string, params: JsonObject) => unknown | Promise<unknown>;
    memory?: TimelineEntry[];
  } = {},
) {
  const calls: Array<{ action: string; params: JsonObject }> = [],
    writes: Array<{ action: string; params: JsonObject }> = [];
  let entries = options.memory ?? [entry()];
  const api: Api = {
    async call(action, params = {}) {
      calls.push({ action, params });
      if (options.hook) {
        const override = await options.hook(action, params);
        if (override !== undefined) return override;
      }
      if (action === "get_login_info") return { user_id: selfId };
      if (action === "get_group_member_info")
        return {
          group_id: groupId,
          user_id: params.user_id,
          role:
            params.user_id === selfId
              ? (options.botRole ?? "owner")
              : (options.targetRole ?? "member"),
        };
      if (action === "get_msg")
        return {
          message_type: "group",
          message_id: params.message_id,
          group_id: groupId,
          user_id: target,
          sender: { user_id: target },
          message: "private raw body",
        };
      if (action === "_get_group_notice")
        return [
          {
            notice_id: "notice-1",
            sender_id: target,
            message: { text: "private notice", image: [] },
          },
        ];
      writes.push({ action, params });
      return Object.hasOwn(options, "write") ? options.write : null;
    },
  };
  const memory: Pick<Memory, "recent" | "find"> = {
    recent: () => entries,
    find: (id) => entries.find((e) => e.messageId === id),
  };
  const tools = new GroupActionTools(
    api,
    groupId,
    options.enabled ?? GROUP_ACTION_TOOL_NAMES,
    memory,
  );
  return {
    tools,
    calls,
    writes,
    setEntries: (value: TimelineEntry[]) => {
      entries = value;
    },
    api,
    memory,
  };
}
test("default off, explicit immutable capabilities and strict tool schemas", async () => {
  const f = setup(),
    off = new GroupActionTools(f.api, groupId);
  assert.deepEqual(off.definitions(), []);
  assert.equal(
    (await off.execute("poke_member", { user_id: target }, ctx)).error,
    "tool_disabled",
  );
  assert.equal(f.calls.length, 0);
  assert.equal(GROUP_ACTION_TOOL_NAMES.length, 12);
  assert.ok(
    !(GROUP_ACTION_TOOL_NAMES as readonly string[]).includes("dismiss_group"),
  );
  const enabled = ["poke_member"];
  const instance = new GroupActionTools(f.api, groupId, enabled, f.memory);
  enabled.push("leave_group");
  assert.equal(instance.definitions().length, 1);
  const defs = instance.definitions();
  defs[0]!.function.parameters.required = [];
  assert.deepEqual(instance.definitions()[0]!.function.parameters.required, [
    "user_id",
  ]);
  for (const definition of f.tools.definitions()) {
    const p = definition.function.parameters;
    assert.equal(p.additionalProperties, false);
    assert.deepEqual(p.required, Object.keys(p.properties as object));
    assert.ok(!("group_id" in (p.properties as object)));
  }
  assert.throws(() => new GroupActionTools(f.api, groupId, ["dismiss_group"]));
});
test("exact fields and plain data reject prototypes getters controls invalid IDs and unsafe sizes without API calls", async () => {
  const f = setup();
  let getterCalled = false;
  const getter = Object.defineProperty({}, "user_id", {
    get() {
      getterCalled = true;
      return target;
    },
    enumerable: true,
  });
  const invalid: Array<[string, unknown]> = [
    ["poke_member", getter],
    ["poke_member", Object.assign(Object.create({}), { user_id: target })],
    ["poke_member", { user_id: 555 }],
    ["poke_member", { user_id: "0555" }],
    ["poke_member", { user_id: target, group_id: groupId }],
    ["group_sign", { unused: true }],
    ["set_group_whole_mute", {}],
    ["set_group_whole_mute", { enable: "false" }],
    ["kick_member", { user_id: target }],
    ["set_group_name", { name: " " }],
    ["set_group_name", { name: "abc\n" }],
    ["set_group_title", { user_id: target, title: "\u0000" }],
    ["publish_group_notice", { text: "🙂".repeat(4097) }],
    ["delete_group_notice", { notice_id: "../secret" }],
    ["set_group_essence", { message_id: "9007199254740992" }],
  ];
  for (const [name, args] of invalid)
    assert.equal(
      (await f.tools.execute(name, args, ctx)).error,
      "invalid_arguments",
    );
  assert.equal(getterCalled, false);
  assert.equal(f.calls.length, 0);
});
test("context group, self and actor proofs fail closed before mutations", async () => {
  const f = setup();
  for (const bad of [
    { ...ctx, groupId: "999" },
    { ...ctx, selfId: "" },
    { ...ctx, actorId: "actor" },
    { ...ctx, messageId: "fwdn_123" },
  ])
    assert.equal(
      (await f.tools.execute("group_sign", {}, bad)).status,
      "error",
    );
  assert.equal(f.calls.length, 0);
  const wrongLogin = setup({
    hook: (action) =>
      action === "get_login_info" ? { user_id: "888" } : undefined,
  });
  assert.equal(
    (await wrongLogin.tools.execute("group_sign", {}, ctx)).error,
    "identity_mismatch",
  );
  assert.equal(wrongLogin.writes.length, 0);
  for (const row of [
    { group_id: "999", user_id: selfId, role: "owner" },
    { group_id: groupId, user_id: "999", role: "owner" },
    { group_id: groupId, user_id: selfId, role: "superadmin" },
  ]) {
    const g = setup({
      hook: (action) => (action === "get_group_member_info" ? row : undefined),
    });
    assert.equal(
      (await g.tools.execute("set_group_name", { name: "name" }, ctx)).error,
      "verification_failed",
    );
    assert.equal(g.writes.length, 0);
  }
});
test("role checks use actual QQ authority without owner-account immunity", async () => {
  for (const name of ["set_group_title", "set_group_admin"] as const) {
    const f = setup({ botRole: "admin" });
    const args =
      name === "set_group_title"
        ? { user_id: target, title: "title" }
        : { user_id: target, enable: true };
    assert.equal(
      (await f.tools.execute(name, args, ctx)).error,
      "permission_denied",
    );
    assert.equal(f.writes.length, 0);
  }
  for (const role of ["owner", "admin"]) {
    const f = setup({ botRole: "admin", targetRole: role });
    assert.equal(
      (
        await f.tools.execute(
          "kick_member",
          { user_id: target, reject_add_request: false },
          ctx,
        )
      ).error,
      "permission_denied",
    );
    assert.equal(f.writes.length, 0);
  }
  const owner = setup({ botRole: "owner", targetRole: "admin" });
  assert.equal(
    (
      await owner.tools.execute(
        "kick_member",
        { user_id: "100000001", reject_add_request: true },
        ctx,
      )
    ).status,
    "unknown",
  );
  assert.equal(owner.writes.length, 1);
  assert.deepEqual(owner.writes[0], {
    action: "set_group_kick",
    params: {
      group_id: groupId,
      user_id: "100000001",
      reject_add_request: true,
    },
  });
  const member = setup({ botRole: "member" });
  assert.equal(
    (await member.tools.execute("set_group_whole_mute", { enable: true }, ctx))
      .error,
    "permission_denied",
  );
  assert.equal(member.writes.length, 0);
  const poke = setup({ botRole: "member", targetRole: "owner" });
  assert.equal(
    (await poke.tools.execute("poke_member", { user_id: target }, ctx)).status,
    "unknown",
  );
  assert.equal(poke.writes.length, 1);
});
test("target membership identity is verified before targeted actions", async () => {
  for (const row of [
    { group_id: "999", user_id: target, role: "member" },
    { group_id: groupId, user_id: "666", role: "member" },
    { group_id: groupId, user_id: target, role: "bad" },
  ]) {
    const f = setup({
      hook: (action, params) =>
        action === "get_group_member_info" && params.user_id === target
          ? row
          : undefined,
    });
    assert.equal(
      (await f.tools.execute("poke_member", { user_id: target }, ctx)).error,
      "verification_failed",
    );
    assert.equal(f.writes.length, 0);
  }
});
test("verified null ACKs execute with explicit native fields and literal text preserved", async () => {
  const literal =
    "纯文字 https://example.test/path /tmp/example [CQ:image,file=private]";
  for (const [name, args, action, params] of [
    [
      "set_group_name",
      { name: "群名" },
      "set_group_name",
      { group_id: groupId, group_name: "群名" },
    ],
    [
      "set_group_whole_mute",
      { enable: false },
      "set_group_whole_ban",
      { group_id: groupId, enable: false },
    ],
    [
      "publish_group_notice",
      { text: literal },
      "_send_group_notice",
      {
        group_id: groupId,
        content: literal,
        pinned: 0,
        type: 1,
        confirm_required: 1,
        is_show_edit_card: 0,
        tip_window_type: 0,
      },
    ],
  ] as const) {
    const f = setup();
    assert.equal((await f.tools.execute(name, args, ctx)).status, "executed");
    assert.deepEqual(f.writes, [{ action, params }]);
  }
});
test("packet-only and discarded native results never become fake confirmations", async () => {
  for (const [name, args, action] of [
    ["poke_member", { user_id: target }, "group_poke"],
    ["group_sign", {}, "set_group_sign"],
    [
      "set_group_title",
      { user_id: target, title: "" },
      "set_group_special_title",
    ],
    [
      "kick_member",
      { user_id: target, reject_add_request: false },
      "set_group_kick",
    ],
    ["set_group_admin", { user_id: target, enable: false }, "set_group_admin"],
    ["leave_group", {}, "set_group_leave"],
  ] as const) {
    const f = setup();
    const result = await f.tools.execute(name, args, ctx);
    assert.equal(result.status, "unknown");
    assert.equal(result.retry_allowed, false);
    assert.equal(f.writes[0]?.action, action);
    assert.equal(
      (await f.tools.execute(name, args, ctx)).error,
      "previous_result_unknown",
    );
    assert.equal(f.writes.length, 1);
    if (name === "leave_group")
      assert.equal(f.writes[0]!.params.is_dismiss, false);
    if (name === "set_group_title")
      assert.deepEqual(f.writes[0]!.params, {
        group_id: groupId,
        user_id: target,
        special_title: "",
      });
  }
});
test("unverified native results including synthetic result zero never confirm or permit retry", async () => {
  for (const [name, args] of [
    ["set_group_essence", { message_id: "1" }],
    ["remove_group_essence", { message_id: "1" }],
    ["delete_group_notice", { notice_id: "notice-1" }],
  ] as const) {
    for (const value of [
      null,
      {},
      undefined,
      { result: 0, errMsg: "PRIVATE SECRET URL" },
      { result: 5, errMsg: "PRIVATE SECRET URL" },
      { result: "0" },
      { result: false },
      { status: "ok", retcode: 0 },
      { errCode: 0 },
      { ec: 0 },
    ]) {
      const f = setup({ write: value });
      const result = await f.tools.execute(name, args, ctx);
      assert.equal(result.status, "unknown");
      assert.equal(result.retry_allowed, false);
      assert.doesNotMatch(JSON.stringify(result), /PRIVATE|SECRET|URL/);
      assert.equal(
        (await f.tools.execute(name, args, ctx)).error,
        "previous_result_unknown",
      );
      assert.equal(f.writes.length, 1);
      if (name !== "delete_group_notice") {
        const reverse =
          name === "set_group_essence"
            ? "remove_group_essence"
            : "set_group_essence";
        assert.equal(
          (await f.tools.execute(reverse, args, ctx)).error,
          "previous_result_unknown",
        );
        assert.equal(f.writes.length, 1);
      }
    }
  }
});
test("write and read errors never leak sensitive details", async () => {
  const thrown = setup({
    hook: (action) => {
      if (action === "set_group_name") throw new Error("PRIVATE SECRET");
    },
  });
  assert.equal(
    (await thrown.tools.execute("set_group_name", { name: "a" }, ctx)).status,
    "unknown",
  );
  assert.doesNotMatch(
    JSON.stringify(
      await thrown.tools.execute("set_group_name", { name: "b" }, ctx),
    ),
    /PRIVATE|SECRET/,
  );
  const readFail = setup({
    hook: (action) => {
      if (action === "get_login_info") throw new Error("PRIVATE SECRET");
    },
  });
  assert.deepEqual(await readFail.tools.execute("group_sign", {}, ctx), {
    status: "error",
    error: "verification_unavailable",
  });
});
test("essence only authorizes live local messages and verified direct references", async () => {
  const guessed = setup({ memory: [] });
  assert.equal(
    (
      await guessed.tools.execute(
        "set_group_essence",
        { message_id: "999" },
        ctx,
      )
    ).error,
    "forbidden_reference",
  );
  assert.equal(guessed.calls.length, 0);
  const quote = setup({
    memory: [entry("2", "444", "1")],
    write: { result: 0 },
  });
  assert.equal(
    (
      await quote.tools.execute(
        "remove_group_essence",
        { message_id: "1" },
        ctx,
      )
    ).status,
    "unknown",
  );
  assert.deepEqual(quote.writes[0], {
    action: "delete_essence_msg",
    params: { message_id: "1" },
  });
  for (const data of [
    {
      message_type: "private",
      message_id: "1",
      group_id: groupId,
      sender: { user_id: target },
    },
    {
      message_type: "group",
      message_id: "1",
      group_id: "999",
      sender: { user_id: target },
    },
    {
      message_type: "group",
      message_id: "2",
      group_id: groupId,
      sender: { user_id: target },
    },
    {
      message_type: "group",
      message_id: "1",
      group_id: groupId,
      sender: { user_id: "999" },
    },
    {
      message_type: "group",
      message_id: "1",
      group_id: groupId,
      user_id: "999",
      sender: { user_id: target },
    },
  ]) {
    const f = setup({
      write: { result: 0 },
      hook: (action) => (action === "get_msg" ? data : undefined),
    });
    assert.equal(
      (await f.tools.execute("set_group_essence", { message_id: "1" }, ctx))
        .error,
      "verification_failed",
    );
    assert.equal(f.writes.length, 0);
  }
  const live = setup({ memory: [], write: { result: 0 } });
  live.setEntries([entry()]);
  assert.equal(
    (await live.tools.execute("set_group_essence", { message_id: "1" }, ctx))
      .status,
    "unknown",
  );
});
test("notice removal proves current group list membership and rejects guessed IDs", async () => {
  const f = setup({ write: { result: 0 } });
  assert.equal(
    (await f.tools.execute("delete_group_notice", { notice_id: "other" }, ctx))
      .error,
    "forbidden_reference",
  );
  assert.equal(f.writes.length, 0);
  assert.equal(
    (
      await f.tools.execute(
        "delete_group_notice",
        { notice_id: "notice-1" },
        ctx,
      )
    ).status,
    "unknown",
  );
  assert.deepEqual(f.writes[0], {
    action: "_del_group_notice",
    params: { group_id: groupId, notice_id: "notice-1" },
  });
  const foreign = setup({
    hook: (action) =>
      action === "_get_group_notice"
        ? [{ notice_id: "notice-1", group_id: "999" }]
        : undefined,
  });
  assert.equal(
    (
      await foreign.tools.execute(
        "delete_group_notice",
        { notice_id: "notice-1" },
        ctx,
      )
    ).error,
    "verification_failed",
  );
  assert.equal(foreign.writes.length, 0);
});
test("confirmed latest calls deduplicate while reverse changes invalidate stale confirmation", async () => {
  const f = setup();
  const args = { enable: true };
  assert.equal(
    (await f.tools.execute("set_group_whole_mute", args, ctx)).status,
    "executed",
  );
  assert.equal(
    (await f.tools.execute("set_group_whole_mute", args, ctx)).cached,
    true,
  );
  await f.tools.execute("set_group_whole_mute", { enable: false }, ctx);
  await f.tools.execute("set_group_whole_mute", args, ctx);
  assert.deepEqual(
    f.writes.map((c) => c.params.enable),
    [true, false, true],
  );
  const mute = setup();
  await mute.tools.execute("set_group_whole_mute", { enable: true }, ctx);
  await mute.tools.execute("set_group_whole_mute", { enable: false }, ctx);
  await mute.tools.execute("set_group_whole_mute", { enable: true }, ctx);
  assert.equal(mute.writes.length, 3);
});
test("unknown locks target across related tools but does not invent confirmation", async () => {
  const f = setup();
  await f.tools.execute("set_group_essence", { message_id: "1" }, ctx);
  assert.equal(
    (await f.tools.execute("remove_group_essence", { message_id: "1" }, ctx))
      .error,
    "previous_result_unknown",
  );
  assert.equal(f.writes.length, 1);
  const member = setup();
  await member.tools.execute("poke_member", { user_id: target }, ctx);
  assert.equal(
    (
      await member.tools.execute(
        "set_group_admin",
        { user_id: target, enable: true },
        ctx,
      )
    ).error,
    "previous_result_unknown",
  );
  assert.equal(member.writes.length, 1);
});
test("cancellation before and during reads prevents dispatch; late write ACK is not reported as unexecuted", async () => {
  const early = new AbortController();
  early.abort();
  const f = setup();
  assert.equal(
    (await f.tools.execute("group_sign", {}, ctx, early.signal)).error,
    "cancelled",
  );
  assert.equal(f.calls.length, 0);
  const mid = new AbortController();
  const reading = setup({
    hook: (action) => {
      if (action === "get_login_info") mid.abort();
    },
  });
  assert.equal(
    (await reading.tools.execute("group_sign", {}, ctx, mid.signal)).error,
    "cancelled",
  );
  assert.equal(reading.writes.length, 0);
  const late = new AbortController();
  const writing = setup({
    hook: (action) => {
      if (action === "set_group_name") late.abort();
    },
  });
  const result = await writing.tools.execute(
    "set_group_name",
    { name: "a" },
    ctx,
    late.signal,
  );
  assert.equal(result.status, "executed");
  assert.equal(result.cancelled_after_dispatch, true);
  assert.equal(writing.writes.length, 1);
  const uncertain = new AbortController();
  const unknown = setup({
    hook: (action) => {
      if (action === "group_poke") uncertain.abort();
    },
  });
  assert.equal(
    (
      await unknown.tools.execute(
        "poke_member",
        { user_id: target },
        ctx,
        uncertain.signal,
      )
    ).status,
    "unknown",
  );
});
test("unverified deletion remains unknown and locked even after notice disappears", async () => {
  let deleted = false,
    reads = 0;
  const f = setup({
    write: { result: 0 },
    hook: (action) => {
      if (action === "_get_group_notice") {
        reads++;
        return deleted ? [] : [{ notice_id: "notice-1" }];
      }
      if (action === "_del_group_notice") deleted = true;
    },
  });
  assert.equal(
    (
      await f.tools.execute(
        "delete_group_notice",
        { notice_id: "notice-1" },
        ctx,
      )
    ).status,
    "unknown",
  );
  assert.equal(
    (
      await f.tools.execute(
        "delete_group_notice",
        { notice_id: "notice-1" },
        ctx,
      )
    ).error,
    "previous_result_unknown",
  );
  assert.equal(f.writes.length, 1);
  assert.equal(reads, 1);
  assert.equal(f.calls.filter((c) => c.action === "get_login_info").length, 1);
});
test("cached checked acknowledgements still recheck current login and bot permissions", async () => {
  for (const changed of ["identity", "role"]) {
    let revoked = false;
    const f = setup({
      hook(action, params) {
        if (!revoked) return;
        if (changed === "identity" && action === "get_login_info")
          return { user_id: "999" };
        if (
          changed === "role" &&
          action === "get_group_member_info" &&
          params.user_id === selfId
        )
          return { group_id: groupId, user_id: selfId, role: "member" };
      },
    });
    assert.equal(
      (await f.tools.execute("set_group_name", { name: "same" }, ctx)).status,
      "executed",
    );
    revoked = true;
    assert.equal(
      (await f.tools.execute("set_group_name", { name: "same" }, ctx)).error,
      changed === "identity" ? "identity_mismatch" : "permission_denied",
    );
    assert.equal(f.writes.length, 1);
  }
});
test("late cancellation never turns an unverified native result into success or retry permission", async () => {
  for (const [name, args, native] of [
    ["set_group_essence", { message_id: "1" }, "set_essence_msg"],
    ["remove_group_essence", { message_id: "1" }, "delete_essence_msg"],
    ["delete_group_notice", { notice_id: "notice-1" }, "_del_group_notice"],
  ] as const) {
    const controller = new AbortController();
    const f = setup({
      write: { result: 0 },
      hook(action) {
        if (action === native) controller.abort();
      },
    });
    const result = await f.tools.execute(name, args, ctx, controller.signal);
    assert.equal(result.status, "unknown");
    assert.equal(result.retry_allowed, false);
    assert.equal(
      (await f.tools.execute(name, args, ctx)).error,
      "previous_result_unknown",
    );
    assert.equal(f.writes.length, 1);
  }
});
test("packet IDs do not lose precision and memory changes during reads revoke authorization", async () => {
  const f = setup();
  assert.equal(
    (await f.tools.execute("poke_member", { user_id: "9007199254740992" }, ctx))
      .error,
    "invalid_arguments",
  );
  assert.equal(f.calls.length, 0);
  let live: ReturnType<typeof setup>;
  live = setup({
    write: { result: 0 },
    hook: (action) => {
      if (action === "get_msg") live.setEntries([]);
    },
  });
  assert.equal(
    (await live.tools.execute("set_group_essence", { message_id: "1" }, ctx))
      .error,
    "forbidden_reference",
  );
  assert.equal(live.writes.length, 0);
});
test("concurrent identical writes serialize and only dispatch once", async () => {
  const f = setup();
  const args = { name: "name" };
  const results = await Promise.all([
    f.tools.execute("set_group_name", args, ctx),
    f.tools.execute("set_group_name", args, ctx),
  ]);
  assert.equal(f.writes.length, 1);
  assert.equal(results[0]!.status, "executed");
  assert.equal(results[1]!.cached, true);
});
