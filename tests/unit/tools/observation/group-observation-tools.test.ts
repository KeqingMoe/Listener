import test from "node:test";
import assert from "node:assert/strict";
import {
  GroupObservationTools,
  GROUP_OBSERVATION_TOOL_NAMES,
} from "../../../../src/tools/observation/tools.js";
import type { Api } from "../../../../src/contracts/onebot.js";
import type { JsonObject } from "../../../../src/contracts/json.js";
import type { TurnContext } from "../../../../src/contracts/tools.js";
const GROUP = "12345",
  SELF = "99999";
const context: TurnContext = {
  groupId: GROUP,
  selfId: SELF,
  actorId: "88888",
  messageId: "1",
};
function fixture(
  data: unknown,
  options: {
    login?: unknown;
    hook?: (action: string) => void;
    fail?: boolean;
  } = {},
) {
  const calls: Array<{ action: string; params?: JsonObject }> = [];
  const api: Api = {
    async call(action, params) {
      calls.push({ action, params });
      options.hook?.(action);
      if (options.fail)
        throw Error("PRIVATE_SECRET https://remote/private /tmp/private");
      return action === "get_login_info"
        ? (options.login ?? { user_id: SELF })
        : data;
    },
  };
  return { tools: new GroupObservationTools(api, GROUP), calls };
}
const execute = (
  tools: GroupObservationTools,
  name: string,
  args: unknown,
  signal?: AbortSignal,
) => tools.execute(name, args, context, signal);
test("normal empty notice and essence replies remain usable without claiming upstream completeness", async () => {
  for (const name of ["read_group_notices", "read_group_essence"]) {
    const { tools } = fixture([]);
    const result = await execute(tools, name, { limit: 20 });
    assert.equal(result.status, "ok");
    assert.deepEqual(result.items, []);
    assert.equal(result.upstream_partial, true);
    assert.notEqual(result.completeness, undefined);
    assert.equal(result.total_scope, "upstream_response");
    if (name === "read_group_essence") {
      assert.equal(result.message_ids_verified, false);
      assert.equal(result.upstream_page_limit, 20);
      assert.equal(result.upstream_page_size, 50);
      assert.match(String(result.completeness), /empty_or_partial_on_failure/);
    } else assert.equal(result.upstream_requested_window, 20);
  }
});

test("definitions expose five strict read-only tools and explicit collection limits", () => {
  const { tools } = fixture([]);
  const defs = tools.definitions();
  assert.deepEqual(
    defs.map((d) => d.function.name),
    [...GROUP_OBSERVATION_TOOL_NAMES],
  );
  for (const d of defs) {
    const p = d.function.parameters;
    assert.equal(p.additionalProperties, false);
    if (d.function.name !== "get_group_info")
      assert.ok((p.required as string[]).includes("limit"));
  }
  defs[0]!.function.name = "mutated";
  assert.equal(tools.definitions()[0]!.function.name, "get_group_info");
  assert.throws(
    () =>
      new GroupObservationTools(
        {
          async call() {
            return null;
          },
        },
        "0",
      ),
  );
});
test("group info requires login proof and matching response group with whitelist projection", async () => {
  const { tools, calls } = fixture({
    group_id: GROUP,
    group_name: "group",
    member_count: 10,
    max_member_count: 500,
    group_all_shut: -1,
    group_remark: "note",
    avatar: "https://PRIVATE",
    groupAnswer: "PRIVATE",
    ownerUid: "PRIVATE",
    cookie: "PRIVATE",
  });
  const result = await execute(tools, "get_group_info", {});
  assert.equal(result.status, "ok");
  assert.equal(result.untrusted, true);
  assert.ok(typeof result.queried_at === "number");
  assert.deepEqual(result.info, {
    group_id: GROUP,
    group_name: "group",
    group_remark: "note",
    member_count: 10,
    max_member_count: 500,
    group_all_shut: -1,
  });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  assert.deepEqual(calls, [
    { action: "get_login_info", params: {} },
    { action: "get_group_info", params: { group_id: GROUP } },
  ]);
  assert.equal(
    (await execute(fixture({ group_id: "23456" }).tools, "get_group_info", {}))
      .error,
    "group_mismatch",
  );
});
test("scope and identity fail closed before reads; each invocation rechecks login", async () => {
  const { tools, calls } = fixture([]);
  assert.equal(
    (
      await tools.execute(
        "get_group_mutes",
        { limit: 1 },
        { ...context, groupId: "23456" },
      )
    ).error,
    "forbidden_group",
  );
  assert.equal(
    (
      await tools.execute(
        "get_group_mutes",
        { limit: 1 },
        { ...context, selfId: "0" },
      )
    ).error,
    "invalid_identity",
  );
  assert.equal(calls.length, 0);
  const mismatched = fixture([], { login: { user_id: "88888" } });
  assert.equal(
    (await execute(mismatched.tools, "get_group_mutes", { limit: 1 })).error,
    "identity_mismatch",
  );
  assert.equal(mismatched.calls.length, 1);
  await execute(tools, "get_group_mutes", { limit: 1 });
  await execute(tools, "get_group_mutes", { limit: 1 });
  assert.equal(calls.filter((c) => c.action === "get_login_info").length, 2);
});
test("invalid and unknown arguments never call API including nonfinite and unsafe counts", async () => {
  const { tools, calls } = fixture([]);
  for (const name of GROUP_OBSERVATION_TOOL_NAMES.filter(
    (n) => n !== "get_group_info",
  )) {
    for (const args of [
      {},
      { limit: 0 },
      { limit: -1 },
      { limit: 1.5 },
      { limit: Infinity },
      { limit: NaN },
      { limit: Number.MAX_SAFE_INTEGER + 1 },
      { limit: "1" },
      { limit: 1, offset: -1 },
      { limit: 1, offset: Infinity },
      { limit: 1, offset: 0.1 },
      { limit: 1, unknown: true },
      { limit: 1, group_id: GROUP },
      null,
      [],
      { limit: 1, [Symbol("x")]: true },
    ])
      assert.equal(
        (await execute(tools, name, args)).error,
        "invalid_arguments",
      );
  }
  assert.equal(
    (await execute(tools, "get_group_info", { limit: 1 })).error,
    "invalid_arguments",
  );
  assert.equal(
    (await execute(tools, "get_group_honor", { type: "all", limit: 1 })).error,
    "invalid_arguments",
  );
  assert.equal((await execute(tools, "unknown", {})).error, "unknown_tool");
  assert.equal(calls.length, 0);
});
test("native mute fields are mapped conservatively, not guessed from inaccurate examples", async () => {
  const { tools, calls } = fixture([
    {
      uin: "88",
      nick: "N",
      cardName: "C",
      shutUpTime: 123456,
      isDelete: false,
      uid: "PRIVATE",
      qid: "PRIVATE",
      avatarPath: "/PRIVATE",
    },
    { user_id: "99", nickname: "wrong-schema", shut_up_time: 123 },
  ]);
  const r = await execute(tools, "get_group_mutes", { limit: 2 });
  assert.deepEqual(r.items, [
    {
      user_id: "88",
      nickname: "N",
      card: "C",
      upstream_shut_up_time: 123456,
      upstream_is_deleted: false,
    },
    { fields_unknown: true },
  ]);
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE|wrong-schema/);
  assert.equal(calls[1]!.action, "get_group_shut_list");
  assert.match(String(r.completeness), /not_guaranteed/);
  const empty = await execute(fixture([]).tools, "get_group_mutes", {
    limit: 1,
  });
  assert.equal(empty.returned, 0);
  assert.match(String(empty.completeness), /empty_on_failure/);
});
test("honor selects exact category, current talkative and uncertain empty semantics", async () => {
  const raw = {
    group_id: GROUP,
    talkative_list: [
      { user_id: 88, nickname: "N", description: "D", avatar: "PRIVATE" },
    ],
    current_talkative: {
      user_id: "88",
      nickname: "N",
      day_count: 2,
      avatar: "PRIVATE",
    },
    performer_list: [{ user_id: 99, nickname: "not-selected" }],
    strong_newbie_list: [],
  };
  const { tools, calls } = fixture(raw);
  const r = await execute(tools, "get_group_honor", {
    type: "talkative",
    limit: 1,
  });
  assert.deepEqual(r.items, [
    { user_id: "88", nickname: "N", description: "D" },
  ]);
  assert.deepEqual(r.current_talkative, {
    user_id: "88",
    nickname: "N",
    day_count: 2,
  });
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE|not-selected/);
  assert.deepEqual(calls[1], {
    action: "get_group_honor_info",
    params: { group_id: GROUP, type: "talkative" },
  });
  assert.equal(
    (
      await execute(tools, "get_group_honor", {
        type: "strong_newbie",
        limit: 1,
      })
    ).availability,
    "upstream_returns_empty_unconditionally",
  );
  assert.equal(
    (
      await execute(
        fixture({ group_id: "333", talkative_list: [] }).tools,
        "get_group_honor",
        { type: "talkative", limit: 1 },
      )
    ).error,
    "group_mismatch",
  );
  assert.equal(
    (
      await execute(fixture({ group_id: GROUP }).tools, "get_group_honor", {
        type: "talkative",
        limit: 1,
      })
    ).error,
    "invalid_response",
  );
});
test("notices expose bounded text and metadata but not image IDs URLs or settings", async () => {
  const { tools, calls } = fixture([
    {
      notice_id: "notice_1",
      sender_id: 88,
      publish_time: 123,
      message: {
        text: "notice",
        images: [{ id: "PRIVATE", url: "https://PRIVATE" }],
        image: [{ id: "PRIVATE" }],
      },
      settings: { token: "PRIVATE" },
      read_num: 4,
    },
  ]);
  const r = await execute(tools, "read_group_notices", { limit: 1 });
  assert.deepEqual(r.items, [
    {
      sender_id: "88",
      publish_time: 123,
      read_num: 4,
      notice_id: "notice_1",
      text: "notice",
      image_count: 1,
      images_omitted: true,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE/);
  assert.equal(calls[1]!.action, "_get_group_notice");
});
test("essence IDs stay explicitly unverified and only native text segments are projected", async () => {
  const { tools, calls } = fixture([
    {
      message_id: -42,
      sender_id: 88,
      sender_nick: "N",
      operator_id: 99,
      operator_nick: "O",
      operator_time: 123,
      msg_seq: 20,
      msg_random: 999,
      content: [
        { type: "text", data: { text: "hello" } },
        { type: "image", data: { url: "https://PRIVATE", file: "/PRIVATE" } },
        { type: "at", data: { qq: "PRIVATE" } },
        { type: "text", data: { text: "world" } },
      ],
    },
  ]);
  const r = await execute(tools, "read_group_essence", { limit: 1 });
  assert.equal(r.message_ids_verified, false);
  assert.deepEqual(r.items, [
    {
      message_id_verified: false,
      message_id: "-42",
      sender_id: "88",
      operator_id: "99",
      sender_nick: "N",
      operator_nick: "O",
      operator_time: 123,
      text: "helloworld",
      nontext_segments_omitted: 2,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE|msg_seq|msg_random/);
  assert.equal(calls[1]!.action, "get_essence_msg_list");
});
test("large finite limits and offsets avoid arbitrary row caps and overflow", async () => {
  const rows = Array.from({ length: 150 }, (_, i) => ({
    uin: String(i + 1),
    nick: "N",
  }));
  const { tools } = fixture(rows);
  const page = await execute(tools, "get_group_mutes", { limit: 130 });
  assert.equal(page.returned, 130);
  assert.equal(page.next_offset, 130);
  assert.equal(page.reason, "limit");
  const all = await execute(tools, "get_group_mutes", {
    limit: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(all.returned, 150);
  assert.equal(all.next_offset, null);
  assert.equal(all.truncated, false);
  const last = await execute(tools, "get_group_mutes", {
    limit: Number.MAX_SAFE_INTEGER,
    offset: 149,
  });
  assert.equal(last.returned, 1);
  const distant = await execute(tools, "get_group_mutes", {
    limit: Number.MAX_SAFE_INTEGER,
    offset: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(distant.returned, 0);
  assert.equal(distant.next_offset, null);
});
test("25KB byte budget yields an honest advancing continuation and content truncation", async () => {
  const rows = Array.from({ length: 50 }, () => ({
    message: { text: "字".repeat(6000) },
  }));
  const { tools } = fixture(rows);
  const first = await execute(tools, "read_group_notices", { limit: 50 });
  assert.equal(first.status, "ok");
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 25000);
  assert.ok(Number(first.returned) > 0 && Number(first.returned) < 50);
  assert.equal(first.next_offset, first.returned);
  assert.equal(first.reason, "output_limit");
  const next = await execute(tools, "read_group_notices", {
    limit: 50,
    offset: first.next_offset,
  });
  assert.ok(Number(next.next_offset) > Number(first.next_offset));
  assert.equal((first.items as JsonObject[])[0]!.content_truncated, true);
});
test("source size, malformed source, and foreign group rows fail rather than partial success", async () => {
  assert.equal(
    (
      await execute(fixture(Array(100001).fill({})).tools, "get_group_mutes", {
        limit: 1,
      })
    ).error,
    "resource_limit",
  );
  for (const raw of [null, {}, [null], [{}, { group_id: "other" }]])
    assert.notEqual(
      (await execute(fixture(raw).tools, "read_group_notices", { limit: 1 }))
        .status,
      "ok",
    );
  assert.equal(
    (
      await execute(
        fixture([{ content: Array(100001).fill({}) }]).tools,
        "read_group_essence",
        { limit: 1 },
      )
    ).error,
    "resource_limit",
  );
});
test("API errors remain sanitized while typed notice text stays literal and untrusted", async () => {
  const error = await execute(
    fixture(null, { fail: true }).tools,
    "get_group_info",
    {},
  );
  assert.deepEqual(error, { status: "error", error: "tool_failed" });
  const r = await execute(
    fixture([
      {
        message: {
          text: "hello [CQ:image,file=/PRIVATE,url=https://PRIVATE] https://PRIVATE data:PRIVATE file:///PRIVATE",
        },
      },
    ]).tools,
    "read_group_notices",
    { limit: 1 },
  );
  assert.equal(
    (r.items as JsonObject[])[0]!.text,
    "hello [CQ:image,file=/PRIVATE,url=https://PRIVATE] https://PRIVATE data:PRIVATE file:///PRIVATE",
  );
  assert.equal(r.untrusted, true);
  const essence = await execute(
    fixture([
      {
        content: [
          {
            type: "text",
            data: { text: "[CQ:at,qq=all] https://example.com" },
          },
          { type: "image", data: { url: "https://TRANSPORT-SECRET" } },
        ],
      },
    ]).tools,
    "read_group_essence",
    { limit: 1 },
  );
  assert.equal(
    (essence.items as JsonObject[])[0]!.text,
    "[CQ:at,qq=all] https://example.com",
  );
  assert.doesNotMatch(JSON.stringify(essence), /TRANSPORT-SECRET/);
});
test("cancellation before dispatch, after login, and after upstream read discards results", async () => {
  for (const when of ["before", "get_login_info", "get_group_info"]) {
    const controller = new AbortController();
    const { tools, calls } = fixture(
      { group_id: GROUP, group_name: "PRIVATE" },
      {
        hook(action) {
          if (action === when) controller.abort();
        },
      },
    );
    if (when === "before") controller.abort();
    assert.deepEqual(
      await execute(tools, "get_group_info", {}, controller.signal),
      { status: "error", error: "cancelled" },
    );
    assert.equal(
      calls.length,
      when === "before" ? 0 : when === "get_login_info" ? 1 : 2,
    );
  }
});
