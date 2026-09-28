import test from "node:test";
import assert from "node:assert/strict";
import {
  GroupVoiceTools,
  GROUP_VOICE_TOOL_NAMES,
} from "../src/tools/voice/tools.js";
import type { Api } from "../src/contracts/onebot.js";
import type { JsonObject } from "../src/contracts/json.js";
import type { TurnContext } from "../src/contracts/tools.js";
const GROUP = "12345",
  SELF = "99999",
  SECRET = "PRIVATE_PREVIEW_TOKEN_FILE_URL";
const ctx: TurnContext = {
  groupId: GROUP,
  selfId: SELF,
  actorId: "22222",
  messageId: "1",
};
const native = (count = 2) => [
  {
    type: "常用",
    characters: Array.from({ length: count }, (_, i) => ({
      character_id: `voice_${i}`,
      character_name: `声线${i}`,
      preview_url: `https://qq.example/${SECRET}`,
      private_extra: SECRET,
    })),
  },
];
function fixture(
  options: {
    enabled?: readonly string[];
    login?: unknown;
    member?: unknown;
    voices?: () => unknown | Promise<unknown>;
    send?: () => unknown | Promise<unknown>;
  } = {},
) {
  const calls: Array<{ action: string; params: JsonObject | undefined }> = [];
  const api: Api = {
    async call(action, params) {
      calls.push({ action, params });
      if (action === "get_login_info")
        return Object.hasOwn(options, "login")
          ? options.login
          : { user_id: SELF };
      if (action === "get_group_member_info")
        return Object.hasOwn(options, "member")
          ? options.member
          : { group_id: GROUP, user_id: SELF, role: "member" };
      if (action === "get_ai_characters")
        return options.voices ? options.voices() : native();
      if (action === "send_group_ai_record")
        return options.send ? options.send() : { message_id: 0 };
      throw Error("unexpected API");
    },
  };
  const tools = new GroupVoiceTools(
    api,
    GROUP,
    options.enabled ?? GROUP_VOICE_TOOL_NAMES,
  );
  return {
    tools,
    api,
    calls,
    writes: () => calls.filter((c) => c.action === "send_group_ai_record"),
  };
}
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
};
const sendArgs = {
  character_id: "voice_0",
  text: "你好\n[CQ:at,qq=all] https://example.com 是文字，不下载",
};

test("voice tools default off, clone enabled schemas and reject unknown capability names", async () => {
  const f = fixture();
  const disabled = new GroupVoiceTools(f.api, GROUP);
  assert.deepEqual(disabled.definitions(), []);
  for (const name of GROUP_VOICE_TOOL_NAMES)
    assert.equal(
      (await disabled.execute(name, {}, ctx)).error,
      "tool_disabled",
    );
  assert.equal(f.calls.length, 0);
  const names = ["get_group_ai_voices"];
  const tool = new GroupVoiceTools(f.api, GROUP, names);
  names.push("send_group_ai_voice");
  assert.equal(tool.definitions().length, 1);
  const d = tool.definitions();
  d[0]!.function.name = "changed";
  assert.equal(tool.definitions()[0]!.function.name, "get_group_ai_voices");
  assert.deepEqual(tool.definitions()[0]!.function.parameters.required, [
    "limit",
  ]);
  assert.equal(
    tool.definitions()[0]!.function.parameters.additionalProperties,
    false,
  );
  assert.throws(() => new GroupVoiceTools(f.api, GROUP, ["unknown"]));
});
test("scope, self ID and cancellation fail before any lookup", async () => {
  for (const name of GROUP_VOICE_TOOL_NAMES) {
    const f = fixture();
    assert.equal(
      (await f.tools.execute(name, {}, { ...ctx, groupId: "54321" })).error,
      "forbidden_group",
    );
    assert.equal(
      (await f.tools.execute(name, {}, { ...ctx, selfId: "0" })).error,
      "identity_unverified",
    );
    const controller = new AbortController();
    controller.abort();
    assert.equal(
      (await f.tools.execute(name, {}, ctx, controller.signal)).error,
      "cancelled",
    );
    assert.equal(f.calls.length, 0);
  }
});
test("explicit safe integer limits and exact text arguments are validated before API calls", async () => {
  for (const args of [
    {},
    { limit: 0 },
    { limit: -1 },
    { limit: 1.5 },
    { limit: Infinity },
    { limit: NaN },
    { limit: "1" },
    { limit: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 1, offset: -1 },
    { limit: 1, offset: 1.2 },
    { limit: 1, offset: Infinity },
    { limit: 1, group_id: "54321" },
    { limit: 1, url: "https://bad" },
  ]) {
    const f = fixture();
    assert.equal(
      (await f.tools.execute("get_group_ai_voices", args, ctx)).error,
      "invalid_arguments",
    );
    assert.equal(f.calls.length, 0);
  }
  for (const args of [
    {},
    { character_id: "voice_0" },
    { character_id: "voice_0", text: "" },
    { character_id: "voice_0", text: "  \n\t" },
    { character_id: "voice_0", text: "a\0b" },
    { character_id: "voice_0", text: "a\x1bb" },
    { character_id: "https://evil", text: "x" },
    { character_id: "../voice", text: "x" },
    { character_id: "a".repeat(129), text: "x" },
    { ...sendArgs, group_id: "54321" },
    { ...sendArgs, file: "secret" },
    { character_id: "voice_0", text: 123 },
  ]) {
    const f = fixture();
    assert.equal(
      (await f.tools.execute("send_group_ai_voice", args, ctx)).error,
      "invalid_arguments",
    );
    assert.equal(f.calls.length, 0);
  }
  const huge = fixture();
  assert.equal(
    (
      await huge.tools.execute(
        "send_group_ai_voice",
        { character_id: "voice_0", text: "中".repeat(2731) },
        ctx,
      )
    ).error,
    "resource_limit",
  );
  assert.equal(huge.calls.length, 0);
});
test("login and live bot membership are verified for every query without admin requirements", async () => {
  for (const role of ["member", "admin", "owner"]) {
    const f = fixture({ member: { group_id: GROUP, user_id: SELF, role } });
    assert.equal(
      (await f.tools.execute("get_group_ai_voices", { limit: 1 }, ctx)).status,
      "ok",
    );
    assert.equal(
      (await f.tools.execute("get_group_ai_voices", { limit: 1 }, ctx)).status,
      "ok",
    );
    assert.equal(
      f.calls.filter((c) => c.action === "get_login_info").length,
      2,
    );
    assert.equal(
      f.calls.filter((c) => c.action === "get_group_member_info").length,
      2,
    );
    assert.deepEqual(f.calls[1]!.params, {
      group_id: GROUP,
      user_id: SELF,
      no_cache: true,
    });
    assert.deepEqual(f.calls[2]!.params, { group_id: GROUP, chat_type: 1 });
  }
  for (const options of [
    { login: { user_id: "55555" } },
    { member: { group_id: "54321", user_id: SELF, role: "member" } },
    { member: { group_id: GROUP, user_id: "55555", role: "member" } },
    { member: { group_id: GROUP, user_id: SELF, role: "invalid" } },
    { member: null },
  ]) {
    const f = fixture(options);
    assert.equal(
      (await f.tools.execute("send_group_ai_voice", sendArgs, ctx)).status,
      "error",
    );
    assert.equal(
      f.calls.filter((c) => c.action === "get_ai_characters").length,
      0,
    );
    assert.equal(f.writes().length, 0);
  }
});
test("voice list exposes only type/id/name and honest offset pagination", async () => {
  const f = fixture();
  const page = await f.tools.execute("get_group_ai_voices", { limit: 1 }, ctx);
  assert.equal(page.status, "ok");
  assert.equal(page.requested, 1);
  assert.equal(page.returned, 1);
  assert.equal(page.total_available, 2);
  assert.equal(page.next_offset, 1);
  assert.equal(page.truncated, true);
  assert.equal(page.reason, "limit");
  assert.equal(page.completeness, "native_snapshot_only");
  assert.equal(page.untrusted, true);
  assert.equal(typeof page.queried_at, "number");
  assert.deepEqual(page.voices, [
    { type: "常用", character_id: "voice_0", character_name: "声线0" },
  ]);
  assert.doesNotMatch(
    JSON.stringify(page),
    /PRIVATE_PREVIEW_TOKEN_FILE_URL|preview_url|https:/,
  );
  const last = await f.tools.execute(
    "get_group_ai_voices",
    { limit: Number.MAX_SAFE_INTEGER, offset: 1 },
    ctx,
  );
  assert.equal(last.returned, 1);
  assert.equal(last.next_offset, null);
  assert.equal(last.has_more, false);
  assert.equal(last.truncated, false);
  const beyond = await f.tools.execute(
    "get_group_ai_voices",
    { limit: Number.MAX_SAFE_INTEGER, offset: Number.MAX_SAFE_INTEGER },
    ctx,
  );
  assert.deepEqual(beyond.voices, []);
  assert.equal(beyond.returned, 0);
  assert.equal(beyond.next_offset, null);
  assert.equal(beyond.total_available, 2);
});
test("lists are live and can return more than twenty; empty snapshot is not malformed success", async () => {
  let count = 50;
  const f = fixture({ voices: () => native(count) });
  assert.equal(
    (await f.tools.execute("get_group_ai_voices", { limit: 50 }, ctx)).returned,
    50,
  );
  count = 1;
  assert.equal(
    (await f.tools.execute("get_group_ai_voices", { limit: 50 }, ctx))
      .total_available,
    1,
  );
  count = 0;
  const empty = await f.tools.execute("get_group_ai_voices", { limit: 1 }, ctx);
  assert.equal(empty.status, "ok");
  assert.equal(empty.total_available, 0);
  assert.equal(empty.completeness, "native_snapshot_only");
});
test("output resource bound keeps a useful prefix and correct continuation", async () => {
  const values = native(1000);
  for (const v of values[0]!.characters) v.character_name = "声".repeat(160);
  const f = fixture({ voices: () => values });
  const first = await f.tools.execute(
    "get_group_ai_voices",
    { limit: 1000 },
    ctx,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 24 * 1024);
  assert.ok(Number(first.returned) > 0 && Number(first.returned) < 1000);
  assert.equal(first.reason, "output_limit");
  assert.equal(first.next_offset, first.returned);
  const next = await f.tools.execute(
    "get_group_ai_voices",
    { limit: 1, offset: first.next_offset },
    ctx,
  );
  assert.equal(
    (next.voices as any[])[0].character_id,
    `voice_${first.returned}`,
  );
  assert.equal(next.total_available, 1000);
});
test("all native records validate before exposing even a small first page", async () => {
  for (const value of [
    null,
    {},
    true,
    [{}],
    [{ type: "x", characters: {} }],
    [{ type: 1, characters: [] }],
    [{ type: "x", characters: [{ character_id: "a", character_name: "b" }] }],
    [
      {
        type: "x",
        characters: [
          {
            character_id: "https://secret",
            character_name: "b",
            preview_url: "x",
          },
        ],
      },
    ],
    [...native(), { type: "bad", characters: [null] }],
  ]) {
    const f = fixture({ voices: () => value });
    const r = await f.tools.execute("get_group_ai_voices", { limit: 1 }, ctx);
    assert.equal(r.status, "error");
    assert.equal(r.error, "invalid_voice_list");
    assert.equal(r.voices, undefined);
  }
  const huge = fixture({ voices: () => native(10001) });
  assert.equal(
    (await huge.tools.execute("get_group_ai_voices", { limit: 1 }, ctx)).error,
    "resource_limit",
  );
  const labels = fixture({
    voices: () => [
      {
        type: "https://secret/x",
        characters: [
          {
            character_id: "voice_0",
            character_name: "hello\0 file:///secret/path",
            preview_url: SECRET,
          },
        ],
      },
    ],
  });
  const r = await labels.tools.execute(
    "get_group_ai_voices",
    { limit: 1 },
    ctx,
  );
  assert.doesNotMatch(
    JSON.stringify(r),
    /https:|file:|\/secret|PRIVATE_PREVIEW/,
  );
});
test("send verifies currently available character and passes only plain text native payload", async () => {
  const f = fixture();
  const r = await f.tools.execute("send_group_ai_voice", sendArgs, ctx);
  assert.equal(r.status, "ok");
  assert.equal(r.submitted,true);assert.equal(r.effect_confirmed,false);assert.equal(r.delivery_confirmed,false);
  assert.equal(r.message_id, null);
  assert.equal(r.error, undefined);
  assert.deepEqual(
    f.calls.map((c) => c.action),
    [
      "get_login_info",
      "get_group_member_info",
      "get_ai_characters",
      "send_group_ai_record",
    ],
  );
  assert.deepEqual(f.writes()[0]!.params, {
    group_id: GROUP,
    character: "voice_0",
    text: sendArgs.text,
  });
  assert.doesNotMatch(
    JSON.stringify(r),
    /CQ:|example\.com|PRIVATE_PREVIEW|voice_0/,
  );
  const again = await f.tools.execute("send_group_ai_voice", sendArgs, ctx);
  assert.equal(again.cached, undefined);
  assert.equal(again.status, "ok");
  assert.equal(again.submitted,true);
  assert.equal(f.writes().length, 2);
  assert.equal(
    f.calls.filter((c) => c.action === "get_ai_characters").length,
    2,
  );
  assert.equal(f.calls.filter((c) => c.action === "get_login_info").length, 2);
});
test("a previously listed character is not a capability after native availability changes", async () => {
  let voices = native();
  const f = fixture({ voices: () => voices });
  assert.equal(
    (await f.tools.execute("get_group_ai_voices", { limit: 2 }, ctx)).status,
    "ok",
  );
  voices = native(0);
  const r = await f.tools.execute("send_group_ai_voice", sendArgs, ctx);
  assert.equal(r.error, "voice_unavailable");
  assert.equal(f.writes().length, 0);
  const guessed = fixture();
  assert.equal(
    (
      await guessed.tools.execute(
        "send_group_ai_voice",
        { character_id: "foreign_voice", text: "x" },
        ctx,
      )
    ).error,
    "voice_unavailable",
  );
  assert.equal(guessed.writes().length, 0);
});
test("send never trusts any fabricated positive ACK and locks exceptions and malformed returns", async () => {
  for (const value of [
    null,
    undefined,
    true,
    {},
    { message_id: 123 },
    { message_id: "0" },
    { status: "ok" },
  ]) {
    const f = fixture({ send: () => value });
    const r = await f.tools.execute("send_group_ai_voice", sendArgs, ctx);
    assert.equal(r.status, "unknown");
    assert.equal(r.message_id, null);
    assert.equal(r.outcome, undefined);
    assert.equal(
      (await f.tools.execute("send_group_ai_voice", sendArgs, ctx)).cached,
      true,
    );
    assert.equal(f.writes().length, 1);
  }
  const throwing = fixture({
    send: () => {
      throw Error(SECRET);
    },
  });
  const r = await throwing.tools.execute("send_group_ai_voice", sendArgs, ctx);
  assert.equal(r.status, "unknown");
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE_PREVIEW/);
  await throwing.tools.execute("send_group_ai_voice", sendArgs, ctx);
  assert.equal(throwing.writes().length, 1);
});
test("cancellation before dispatch prevents send; late normal return preserves submission",  async () => {
  const before = new AbortController();
  const f = fixture({
    voices: () => {
      before.abort();
      return native();
    },
  });
  assert.equal(
    (await f.tools.execute("send_group_ai_voice", sendArgs, ctx, before.signal))
      .error,
    "cancelled",
  );
  assert.equal(f.writes().length, 0);
  const after = new AbortController();
  const late = fixture({
    send: () => {
      after.abort();
      return { message_id: 0 };
    },
  });
  const r = await late.tools.execute(
    "send_group_ai_voice",
    sendArgs,
    ctx,
    after.signal,
  );
  assert.equal(r.status, "ok");
  assert.equal(r.submitted,true);assert.equal(r.cancelled_after_dispatch,true);assert.equal(r.message_id,null);
  assert.equal(
    (await late.tools.execute("send_group_ai_voice", sendArgs, ctx)).submitted,
    true,
  );
  assert.equal(late.writes().length, 2);
});
test("read exceptions are static and a rejected read does not lock future corrected attempts", async () => {
  let error = true;
  const f = fixture({
    voices: () => {
      if (error) throw Error(SECRET);
      return native();
    },
  });
  const r = await f.tools.execute("send_group_ai_voice", sendArgs, ctx);
  assert.equal(r.status, "error");
  assert.equal(r.error, "verification_unavailable");
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE_PREVIEW/);
  assert.equal(f.writes().length, 0);
  error = false;
  assert.equal(
    (await f.tools.execute("send_group_ai_voice", sendArgs, ctx)).status,
    "ok",
  );
  assert.equal(f.writes().length, 1);
});
test("concurrent explicit voice calls each submit after a normal predecessor; instances stay isolated",   async () => {
  const hold = gate(),
    started = gate();
  const f = fixture({
    send: async () => {
      started.release();
      await hold.promise;
      return { message_id: 0 };
    },
  });
  const a = f.tools.execute("send_group_ai_voice", sendArgs, ctx);
  await started.promise;
  const b = f.tools.execute("send_group_ai_voice", sendArgs, ctx);
  hold.release();
  const results = await Promise.all([a, b]);
  assert.equal(results[0]!.status, "ok");
  assert.equal(results[0]!.submitted,true);
  assert.equal(results[1]!.cached, undefined);
  assert.equal(results[1]!.submitted,true);
  assert.equal(f.writes().length, 2);
  const other = fixture();
  await other.tools.execute("send_group_ai_voice", sendArgs, ctx);
  assert.equal(other.writes().length, 1);
});
test("UTF8 text resource boundary permits 8192 bytes without changing literal text", async () => {
  const f = fixture();
  const text = "a".repeat(8192);
  assert.equal(
    (
      await f.tools.execute(
        "send_group_ai_voice",
        { character_id: "voice_0", text },
        ctx,
      )
    ).status,
    "ok",
  );
  assert.equal(f.writes()[0]!.params!.text, text);
});
