import test from "node:test";
import assert from "node:assert/strict";
import {
  GroupMediaTools,
  GROUP_MEDIA_TOOL_NAMES,
} from "../../../../src/tools/media/tools.js";
import type { Api } from "../../../../src/contracts/onebot.js";
import type { JsonObject } from "../../../../src/contracts/json.js";
import type { Memory, TimelineEntry } from "../../../../src/contracts/messages.js";
import type { TurnContext } from "../../../../src/contracts/tools.js";
import type { ImageDownloader } from "../../../../src/tools/images/download.js";

const GROUP = "12345",
  SELF = "99999",
  USER = "22222";
const ctx: TurnContext = {
  groupId: GROUP,
  selfId: SELF,
  actorId: USER,
  messageId: "1",
};
const SECRET = "PRIVATE_URL_RESOURCE_TOKEN";
const DATA = "data:image/png;base64,aGVsbG8=";
const entry = (id = "1"): TimelineEntry => ({
  messageId: id,
  userId: USER,
  nickname: "source",
  text: "",
  time: 1,
  images: [{ id: `img_${id}_0`, index: 0 }],
  segments: [
    { type: "image", image_id: `img_${id}_0`, content_status: "not_viewed" },
  ],
});
const wire = (id = "1"): JsonObject => ({
  message_id: id,
  message_type: "group",
  group_id: GROUP,
  user_id: USER,
  sender: { user_id: USER },
  message: [
    {
      type: "image",
      data: { url: `https://gchat.qpic.cn/${SECRET}`, file: SECRET },
    },
  ],
});
function fixture(
  options: {
    entries?: TimelineEntry[];
    enabled?: readonly string[];
    read?: (id: string) => unknown;
    login?: unknown;
    send?: (action: string, params: JsonObject) => Promise<unknown> | unknown;
    download?: ImageDownloader;
    onSent?: (entry: TimelineEntry) => void;
  } = {},
) {
  let entries = options.entries ?? [entry()];
  const calls: Array<{ action: string; params: JsonObject | undefined }> = [],
    sent: TimelineEntry[] = [];
  let downloads = 0, nextMessageId=900;
  const memory: Memory = {
    append(e) {
      entries.push(e);
      return true;
    },
    recent: () => entries,
    find: (id) => entries.find((e) => e.messageId === id),
    context: () => "",
    async compact() {},
    clear() {
      entries = [];
    },
    close() {},
  };
  const api: Api = {
    async call(action, params) {
      calls.push({ action, params });
      if (action === "get_login_info")
        return Object.hasOwn(options, "login")
          ? options.login
          : { user_id: SELF };
      if (action === "get_msg")
        return options.read
          ? options.read(params!.message_id as string)
          : wire(params!.message_id as string);
      return options.send
        ? options.send(action, params!)
        : action === "forward_group_single_msg"
          ? null
          : { message_id: nextMessageId++, res_id: SECRET, forward_id: SECRET };
    },
  };
  const downloader: ImageDownloader = async (...args) => {
    downloads++;
    return options.download
      ? options.download(...args)
      : { dataUrl: DATA, width: 1, height: 1, firstFrameOnly: false };
  };
  const tools = new GroupMediaTools(
    api,
    GROUP,
    options.enabled ?? GROUP_MEDIA_TOOL_NAMES,
    memory,
    {
      downloader,
      onSent(e) {
        sent.push(structuredClone(e));
        options.onSent?.(e);
      },
    },
  );
  return {
    tools,
    api,
    memory,
    calls,
    sent,
    get downloads() {
      return downloads;
    },
    writes: () =>
      calls.filter((c) => !["get_login_info", "get_msg"].includes(c.action)),
  };
}
const args = (name: string): JsonObject =>
  name === "send_group_image"
    ? { image_id: "img_1_0" }
    : name === "forward_message"
      ? { message_id: "1" }
      : { message_ids: ["1"] };
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

test("default off and immutable enabled definitions have strict schemas", async () => {
  const f = fixture();
  const disabled = new GroupMediaTools(f.api, GROUP, undefined, f.memory);
  assert.deepEqual(disabled.definitions(), []);
  for (const name of GROUP_MEDIA_TOOL_NAMES)
    assert.equal(
      (await disabled.execute(name, args(name), ctx)).error,
      "tool_disabled",
    );
  assert.equal(f.calls.length, 0);
  const enabled = ["send_group_image"];
  const tools = new GroupMediaTools(f.api, GROUP, enabled, f.memory);
  enabled.push("forward_message");
  assert.equal(tools.definitions().length, 1);
  const d = tools.definitions();
  d[0]!.function.name = "corrupted";
  assert.equal(tools.definitions()[0]!.function.name, "send_group_image");
  assert.throws(
    () => new GroupMediaTools(f.api, GROUP, ["invented"], f.memory),
  );
  for (const d of f.tools.definitions())
    assert.equal(d.function.parameters.additionalProperties, false);
});
test("scope, self identity, cancellation and exact arguments reject before writes", async () => {
  for (const name of GROUP_MEDIA_TOOL_NAMES) {
    const f = fixture();
    assert.equal(
      (await f.tools.execute(name, args(name), { ...ctx, groupId: "54321" }))
        .error,
      "forbidden_group",
    );
    assert.equal(
      (await f.tools.execute(name, args(name), { ...ctx, selfId: "0" })).error,
      "identity_unverified",
    );
    const controller = new AbortController();
    controller.abort();
    assert.equal(
      (await f.tools.execute(name, args(name), ctx, controller.signal)).error,
      "cancelled",
    );
    assert.equal(f.calls.length, 0);
  }
  for (const [name, value] of [
    ["send_group_image", { url: `https://gchat.qpic.cn/${SECRET}` }],
    ["send_group_image", { image_id: "img_1_0", file: "base64://bad" }],
    ["send_group_image", { image_id: "img_0_0" }],
    ["send_group_image", { image_id: "img_1_128" }],
    ["forward_message", { message_id: 1 }],
    ["forward_message", { message_id: "01" }],
    ["forward_message", { message_id: "0" }],
    ["forward_message", { message_id: "9007199254740992" }],
    ["forward_message", { message_id: "1", group_id: "54321" }],
    ["send_group_forward", { message_ids: [] }],
    ["send_group_forward", { message_ids: ["1"], nodes: [] }],
    ["send_group_forward", { message_ids: new Array(129).fill("1") }],
    ["send_group_forward", { message_ids: ["1", 2] }],
    ["send_group_forward", { message_ids: [{ sender: SELF, text: "forged" }] }],
  ] as const) {
    const f = fixture();
    assert.equal(
      (await f.tools.execute(name, value, ctx)).error,
      "invalid_arguments",
    );
    assert.equal(f.calls.length, 0);
  }
  const f = fixture({ login: { user_id: "55555" } });
  assert.equal(
    (await f.tools.execute("forward_message", { message_id: "1" }, ctx)).error,
    "identity_unverified",
  );
  assert.deepEqual(
    f.calls.map((c) => c.action),
    ["get_login_info"],
  );
});
test("single forwarding follows native null return without inventing a sent message", async () => {
  const f = fixture();
  const r = await f.tools.execute("forward_message", { message_id: "1" }, ctx);
  assert.equal(r.status, "executed");
  assert.equal(r.message_id, null);
  assert.equal(r.untrusted, true);
  assert.equal(typeof r.queried_at, "number");
  assert.ok(r.resources);
  assert.deepEqual(f.writes(), [
    {
      action: "forward_group_single_msg",
      params: { group_id: GROUP, message_id: "1" },
    },
  ]);
  assert.equal(f.sent.length, 0);
  const again = await f.tools.execute(
    "forward_message",
    { message_id: "1" },
    ctx,
  );
  assert.equal(again.cached, undefined);
  assert.equal(again.status,'executed');
  assert.equal(f.writes().length, 2);
});
test("single forwarding rejects invented envelopes and locks uncertain writes", async () => {
  for (const value of [
    undefined,
    { result: 0 },
    { message_id: 900 },
    true,
    { status: "ok" },
  ]) {
    const f = fixture({ send: () => value });
    const r = await f.tools.execute(
      "forward_message",
      { message_id: "1" },
      ctx,
    );
    assert.equal(r.status, "unknown");
    assert.equal(
      (await f.tools.execute("forward_message", { message_id: "1" }, ctx))
        .cached,
      true,
    );
    assert.equal(f.writes().length, 1);
    assert.equal(f.sent.length, 0);
  }
});
test("forward reads require current known messages or direct replies and sender/group identity", async () => {
  for (const read of [
    () => ({ ...wire(), group_id: "54321" }),
    () => ({ ...wire(), message_id: "2" }),
    () => ({ ...wire(), message_type: "private" }),
    () => ({ ...wire(), sender: { user_id: "33333" } }),
    () => ({ ...wire(), user_id: "33333" }),
    () => ({ ...wire(), sender: null }),
    () => {
      throw Error(SECRET);
    },
  ]) {
    const f = fixture({ read });
    const r = await f.tools.execute(
      "forward_message",
      { message_id: "1" },
      ctx,
    );
    assert.equal(r.status, "error");
    assert.equal(f.writes().length, 0);
    assert.ok(!JSON.stringify(r).includes(SECRET));
  }
  const absent = fixture({ entries: [] });
  assert.equal(
    (await absent.tools.execute("forward_message", { message_id: "1" }, ctx))
      .error,
    "forbidden_reference",
  );
  assert.equal(absent.calls.filter((c) => c.action === "get_msg").length, 0);
  const reply = fixture({ entries: [{ ...entry("2"), replyTo: "1" }] });
  assert.equal(
    (await reply.tools.execute("forward_message", { message_id: "1" }, ctx))
      .status,
    "executed",
  );
  const indirect = fixture({ entries: [{ ...entry("2"), replyTo: "3" }] });
  assert.equal(
    (await indirect.tools.execute("forward_message", { message_id: "1" }, ctx))
      .error,
    "forbidden_reference",
  );
});
test("merged forwarding validates all sources then preserves order and duplicate native IDs", async () => {
  const f = fixture({ entries: [entry("1"), entry("2")] });
  const r = await f.tools.execute(
    "send_group_forward",
    { message_ids: ["2", "1", "2"] },
    ctx,
  );
  assert.equal(r.status, "executed");
  assert.equal(r.message_id, "900");
  assert.deepEqual(
    f.calls.map((c) => c.action),
    ["get_login_info", "get_msg", "get_msg", "send_group_forward_msg"],
  );
  assert.deepEqual(f.writes()[0]!.params, {
    group_id: GROUP,
    messages: [
      { type: "node", data: { id: "2" } },
      { type: "node", data: { id: "1" } },
      { type: "node", data: { id: "2" } },
    ],
  });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0]!.userId, SELF);
  assert.deepEqual(f.sent[0]!.forwards, [{ id: "fwd_900_0", index: 0 }]);
  assert.deepEqual(f.sent[0]!.segments, [
    { type: "forward", content_status: "not_read", forward_id: "fwd_900_0" },
  ]);
  assert.doesNotMatch(
    JSON.stringify([r, f.sent]),
    /PRIVATE_URL_RESOURCE_TOKEN|base64|https:/,
  );
});
test("merged forwarding rejects a later foreign source before any dispatch", async () => {
  const f = fixture({
    entries: [entry("1"), entry("2")],
    read: (id) => (id === "2" ? { ...wire(id), group_id: "54321" } : wire(id)),
  });
  assert.equal(
    (
      await f.tools.execute(
        "send_group_forward",
        { message_ids: ["1", "2"] },
        ctx,
      )
    ).status,
    "error",
  );
  assert.equal(f.writes().length, 0);
  assert.equal(f.sent.length, 0);
  const many = fixture();
  assert.equal(
    (
      await many.tools.execute(
        "send_group_forward",
        { message_ids: new Array(128).fill("1") },
        ctx,
      )
    ).status,
    "executed",
  );
  assert.equal((many.writes()[0]!.params!.messages as unknown[]).length, 128);
});
test("image send verifies origin, downloads normalized bytes and persists only stable references", async () => {
  const f = fixture({
    download: async (url, maxBytes) => {
      assert.equal(url, `https://gchat.qpic.cn/${SECRET}`);
      assert.equal(maxBytes, 10 * 1024 * 1024);
      return { dataUrl: DATA, width: 1, height: 1, firstFrameOnly: true };
    },
  });
  const r = await f.tools.execute(
    "send_group_image",
    { image_id: "img_1_0" },
    ctx,
  );
  assert.equal(r.status, "executed");
  assert.deepEqual(
    f.calls.map((c) => c.action),
    ["get_login_info", "get_msg", "send_group_msg"],
  );
  assert.equal(f.downloads, 1);
  assert.deepEqual(f.writes()[0]!.params, {
    group_id: GROUP,
    message: [{ type: "image", data: { file: "base64://aGVsbG8=" } }],
  });
  assert.deepEqual(f.sent[0]!.images, [{ id: "img_900_0", index: 0 }]);
  assert.deepEqual(f.sent[0]!.segments, [
    { type: "image", content_status: "not_viewed", image_id: "img_900_0" },
  ]);
  assert.doesNotMatch(
    JSON.stringify([r, f.sent]),
    /PRIVATE_URL_RESOURCE_TOKEN|base64|https:/,
  );
  assert.equal(
    (await f.tools.execute("send_group_image", { image_id: "img_1_0" }, ctx))
      .status,
    'executed',
  );
  assert.equal(f.downloads, 2);
  assert.equal(f.writes().length, 2);
});
test("image source verification precedes downloader and rejects arbitrary content", async () => {
  for (const options of [
    { entries: [] },
    { entries: [{ ...entry(), images: [] }] },
    { read: () => ({ ...wire(), group_id: "54321" }) },
    { read: () => ({ ...wire(), sender: { user_id: "33333" } }) },
    {
      read: () => ({
        ...wire(),
        message: [{ type: "text", data: { text: SECRET } }],
      }),
    },
    {
      read: () => ({
        ...wire(),
        message: [{ type: "image", data: { url: "file:///etc/passwd" } }],
      }),
    },
  ]) {
    const f = fixture(options);
    assert.equal(
      (await f.tools.execute("send_group_image", { image_id: "img_1_0" }, ctx))
        .status,
      "error",
    );
    assert.equal(f.downloads, 0);
    assert.equal(f.writes().length, 0);
  }
  for (const dataUrl of [
    "file:///etc/passwd",
    `https://gchat.qpic.cn/${SECRET}`,
    "base64://aGVsbG8=",
  ]) {
    const f = fixture({
      download: async () => ({
        dataUrl,
        width: 1,
        height: 1,
        firstFrameOnly: false,
      }),
    });
    assert.equal(
      (await f.tools.execute("send_group_image", { image_id: "img_1_0" }, ctx))
        .status,
      "error",
    );
    assert.equal(f.writes().length, 0);
  }
  const reply = fixture({ entries: [{ ...entry("2"), replyTo: "1" }] });
  assert.equal(
    (
      await reply.tools.execute(
        "send_group_image",
        { image_id: "img_1_0" },
        ctx,
      )
    ).status,
    "executed",
  );
});
test("late valid ACKs remain facts and another explicit interaction is independent",  async () => {
  for (const name of ["send_group_image", "send_group_forward"] as const) {
    const controller = new AbortController();
    let callbackAfterAbort = false, nextMessageId=-900;
    const f = fixture({
      send() {
        controller.abort();
        return { message_id: nextMessageId--, res_id: SECRET };
      },
      onSent() {
        callbackAfterAbort = controller.signal.aborted;
      },
    });
    const r = await f.tools.execute(name, args(name), ctx, controller.signal);
    assert.equal(r.status, "executed");
    assert.equal(r.cancelled_after_dispatch,true);
    assert.equal(callbackAfterAbort, true);
    assert.equal(f.sent[0]!.messageId, "-900");
    assert.equal(
      (await f.tools.execute(name, args(name), ctx)).status,
      "executed",
    );
    assert.equal(f.writes().length, 2);
    assert.equal(f.sent.length, 2);
  }
});
test("all dispatched exceptions and malformed ACKs are static unknown locks", async () => {
  for (const name of GROUP_MEDIA_TOOL_NAMES) {
    const f = fixture({
      send() {
        throw Error(SECRET);
      },
    });
    const r = await f.tools.execute(name, args(name), ctx);
    assert.equal(r.status, "unknown");
    assert.doesNotMatch(JSON.stringify(r), /PRIVATE_URL_RESOURCE_TOKEN/);
    assert.equal(
      (await f.tools.execute(name, args(name), ctx)).status,
      "unknown",
    );
    assert.equal(f.writes().length, 1);
  }
  for (const ack of [
    null,
    {},
    true,
    { message_id: 0 },
    { message_id: "0" },
    { message_id: "01" },
    { message_id: Number.MAX_SAFE_INTEGER + 1 },
    { message_id: "https://secret" },
  ]) {
    const f = fixture({ send: () => ack });
    assert.equal(
      (await f.tools.execute("send_group_forward", { message_ids: ["1"] }, ctx))
        .status,
      "unknown",
    );
    assert.equal(f.sent.length, 0);
  }
});
test("cancellation during lookup or download prevents dispatch", async () => {
  const controller = new AbortController();
  const lookup = fixture({
    read: () => {
      controller.abort();
      return wire();
    },
  });
  assert.equal(
    (
      await lookup.tools.execute(
        "forward_message",
        { message_id: "1" },
        ctx,
        controller.signal,
      )
    ).error,
    "cancelled",
  );
  assert.equal(lookup.writes().length, 0);
  const c = new AbortController();
  const image = fixture({
    download: async () => {
      c.abort();
      return { dataUrl: DATA, width: 1, height: 1, firstFrameOnly: false };
    },
  });
  assert.equal(
    (
      await image.tools.execute(
        "send_group_image",
        { image_id: "img_1_0" },
        ctx,
        c.signal,
      )
    ).error,
    "cancelled",
  );
  assert.equal(image.writes().length, 0);
});
test("concurrent explicit interactions serialize and each dispatches after a normal predecessor",  async () => {
  const hold = gate(),
    started = gate();
  let nextMessageId=900;
  const f = fixture({
    async send() {
      started.release();
      await hold.promise;
      return { message_id: nextMessageId++ };
    },
  });
  const first = f.tools.execute(
    "send_group_forward",
    { message_ids: ["1"] },
    ctx,
  );
  await started.promise;
  const second = f.tools.execute(
    "send_group_forward",
    { message_ids: ["1"] },
    ctx,
  );
  hold.release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, "executed");
  assert.equal(b.cached, undefined);
  assert.equal(b.status,'executed');
  assert.notEqual(a.message_id,b.message_id);
  assert.equal(f.writes().length, 2);
  assert.equal(f.sent.length, 2);
  const other = fixture();
  assert.equal(
    (
      await other.tools.execute(
        "send_group_forward",
        { message_ids: ["1"] },
        ctx,
      )
    ).status,
    "executed",
  );
  assert.equal(other.writes().length, 1);
});
test("projection failure preserves ACK without automatic replay; a new explicit call still dispatches",   async () => {
  const f = fixture({
    onSent() {
      throw Error(SECRET);
    },
  });
  const r = await f.tools.execute(
    "send_group_forward",
    { message_ids: ["1"] },
    ctx,
  );
  assert.equal(r.status, "executed");
  assert.equal(r.local_projection_failed,true);
  assert.equal(r.requested_source_count,1);
  assert.equal(r.source_count,undefined);
  assert.equal(r.source_completeness,'not_verified');
  assert.equal(f.writes().length,1); // projection failure never triggers an automatic resend
  assert.equal(
    (await f.tools.execute("send_group_forward", { message_ids: ["1"] }, ctx))
      .status,
    'executed',
  );
  assert.equal(f.writes().length, 2);
  assert.equal(f.sent.length, 2);
  assert.doesNotMatch(JSON.stringify(r), /PRIVATE_URL_RESOURCE_TOKEN/);
});
test("image scope is rechecked after downloader yields before any dispatch", async () => {
  for (const change of ["clear", "author", "reference"] as const) {
    let f: ReturnType<typeof fixture>;
    f = fixture({
      download: async () => {
        if (change === "clear") f.memory.clear();
        else if (change === "author") f.memory.recent()[0]!.userId = "33333";
        else f.memory.recent()[0]!.images = [];
        return { dataUrl: DATA, width: 1, height: 1, firstFrameOnly: false };
      },
    });
    const r = await f.tools.execute(
      "send_group_image",
      { image_id: "img_1_0" },
      ctx,
    );
    assert.equal(r.status, "error");
    assert.equal(f.writes().length, 0);
    assert.equal(f.sent.length, 0);
  }
});
test("scope is rechecked after verification yields and negative stable IDs remain supported", async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture({
    read: () => {
      f.memory.clear();
      return wire();
    },
  });
  assert.equal(
    (await f.tools.execute("forward_message", { message_id: "1" }, ctx)).error,
    "forbidden_reference",
  );
  assert.equal(f.writes().length, 0);
  const negative = fixture({ entries: [entry("-123")] });
  assert.equal(
    (
      await negative.tools.execute(
        "forward_message",
        { message_id: "-123" },
        ctx,
      )
    ).status,
    "executed",
  );
});
