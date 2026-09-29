import test from "node:test";
import assert from "node:assert/strict";
import type { Api } from "../../../src/contracts/onebot.js";
import type { Memory } from "../../../src/contracts/messages.js";
import type { JsonObject } from "../../../src/contracts/json.js";
import type { ToolDefinition } from "../../../src/contracts/tools.js";
import { prepareExtendedConfirmation as prepare } from "../../../src/tools/confirmation.js";
import {
  GroupActionTools,
  GROUP_ACTION_TOOL_NAMES,
} from "../../../src/tools/actions/tools.js";
import { GroupObservationTools } from "../../../src/tools/observation/tools.js";
import {
  buildGroupFileTools,
  GROUP_FILE_TOOL_NAMES,
} from "../../../src/tools/files/tools.js";
import {
  GroupMediaTools,
  GROUP_MEDIA_TOOL_NAMES,
} from "../../../src/tools/media/tools.js";
import {
  GroupVoiceTools,
  GROUP_VOICE_TOOL_NAMES,
} from "../../../src/tools/voice/tools.js";
import {
  GroupRequestTools,
  GROUP_REQUEST_TOOL_NAMES,
} from "../../../src/tools/requests/tools.js";
const api: Api = {
  async call() {
    throw new Error("No API is allowed during a proposal");
  },
};
const memory: Memory = {
  recent: () => [],
  find: () => undefined,
  append: () => false,
  context: () => "",
  async compact() {},
  clear() {},
  close() {},
};
const all = [
  ...new GroupActionTools(
    api,
    "123",
    GROUP_ACTION_TOOL_NAMES,
    memory,
  ).definitions(),
  ...new GroupObservationTools(api, "123").definitions(),
  ...buildGroupFileTools(GROUP_FILE_TOOL_NAMES),
  ...new GroupMediaTools(
    api,
    "123",
    GROUP_MEDIA_TOOL_NAMES,
    memory,
  ).definitions(),
  ...new GroupVoiceTools(api, "123", GROUP_VOICE_TOOL_NAMES).definitions(),
  ...new GroupRequestTools(api, "123", GROUP_REQUEST_TOOL_NAMES).definitions(),
];
const file = "gf_" + "a".repeat(48),
  request = "grq_" + "b".repeat(48);
const samples: Record<string, JsonObject> = {
  get_group_info: {},
  get_group_honor: { type: "talkative", limit: 1 },
  get_group_mutes: { limit: 1 },
  read_group_notices: { limit: 1 },
  read_group_essence: { limit: 1 },
  poke_member: { user_id: "456" },
  group_sign: {},
  set_group_name: { name: "示例" },
  set_group_title: { user_id: "456", title: "" },
  set_group_whole_mute: { enable: false },
  kick_member: { user_id: "456", reject_add_request: false },
  set_group_admin: { user_id: "456", enable: true },
  set_group_essence: { message_id: "123" },
  remove_group_essence: { message_id: "123" },
  publish_group_notice: { text: "公告" },
  delete_group_notice: { notice_id: "abc" },
  leave_group: {},
  send_group_image: { image_id: "img_123_0" },
  forward_message: { message_id: "123" },
  send_group_forward: { message_ids: ["123", "124"] },
  get_group_ai_voices: { limit: 1 },
  send_group_ai_voice: { character_id: "voice-a", text: "你好" },
  get_group_file_space: {},
  list_group_files: { limit: 1 },
  read_group_text_file: { file_handle: file, max_bytes: 128 },
  upload_group_file: { artifact_id: "art_" + "c".repeat(24) },
  create_group_folder: { name: "notes" },
  delete_group_file: { file_handle: file },
  delete_group_folder: { folder_handle: file },
  list_group_requests: { limit: 1 },
  respond_group_request: {
    request_handle: request,
    approve: false,
    reason: "拒绝理由",
  },
};
const definition = (name: string) => all.find((d) => d.function.name === name)!;
function synthetic(
  properties: JsonObject,
  required = Object.keys(properties),
): ToolDefinition {
  return {
    type: "function",
    function: {
      name: "publish_group_notice",
      description: "trusted schema",
      parameters: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
    },
  };
}
function rejected(fn: () => unknown, code: string) {
  assert.throws(
    fn,
    (error) => error instanceof Error && error.message === code,
  );
}

test("all 31 live definitions parse proposals without calling any API and required fields stay required", () => {
  assert.equal(all.length, 31);
  for (const d of all) {
    const name = d.function.name,
      args = samples[name]!;
    assert.ok(args, name);
    const result = prepare(name, args, d, "当前群123，目标来自实时核验列表");
    assert.deepEqual(result.args, args);
    assert.match(result.description, /提案尚未执行/);
    assert.match(result.description, /实际身份、权限和目标将在确认时重新核验/);
    assert.ok(result.description.includes(name));
    assert.ok(Buffer.byteLength(result.description) <= 3500);
    for (const field of d.function.parameters.required as string[]) {
      const missing = { ...args };
      delete missing[field];
      rejected(() => prepare(name, missing, d, "details"), "invalid_arguments");
    }
    for (const field of ["group_id", "flag", "file_path", "raw_url"])
      rejected(
        () => prepare(name, { ...args, [field]: "PRIVATE" }, d, "details"),
        "invalid_arguments",
      );
  }
});
test("descriptions show exact booleans, identifiers and entire voice/upload payloads without normalizing strings", () => {
  for (const [name, args] of Object.entries(samples)) {
    const out = prepare(name, args, definition(name), "目标已经由父层解析");
    assert.ok(out.description.includes(JSON.stringify(args)), name);
    assert.notEqual(out.args, args);
  }
  const text = "  [CQ:at,qq=all]\nhttps://example.com/file\t你好  ";
  const result = prepare(
    "send_group_ai_voice",
    { character_id: "voice-a", text },
    definition("send_group_ai_voice"),
  );
  assert.equal(result.args.text, text);
  assert.ok(result.description.includes(JSON.stringify(text)));
  const args = { message_ids: ["123", "456"] };
  const out = prepare(
    "send_group_forward",
    args,
    definition("send_group_forward"),
  );
  args.message_ids[0] = "999";
  assert.deepEqual(out.args.message_ids, ["123", "456"]);
});
test("destructive booleans are also explicit in the Chinese action title", () => {
  assert.match(
    prepare(
      "set_group_whole_mute",
      { enable: false },
      definition("set_group_whole_mute"),
    ).description,
    /待确认：关闭全员禁言/,
  );
  assert.match(
    prepare(
      "set_group_admin",
      { user_id: "456", enable: false },
      definition("set_group_admin"),
    ).description,
    /待确认：撤销管理员身份/,
  );
  assert.match(
    prepare(
      "kick_member",
      { user_id: "456", reject_add_request: true },
      definition("kick_member"),
    ).description,
    /踢出成员并拒绝其再次申请/,
  );
  assert.match(
    prepare(
      "respond_group_request",
      samples.respond_group_request,
      definition("respond_group_request"),
      "申请者456",
    ).description,
    /待确认：拒绝入群申请/,
  );
});
test("opaque targets require resolved human-readable details and never replace full args", () => {
  for (const name of [
    "delete_group_file",
    "delete_group_folder",
    "respond_group_request",
  ]) {
    rejected(
      () => prepare(name, samples[name], definition(name)),
      "confirmation_details_required",
    );
    rejected(
      () => prepare(name, samples[name], definition(name), "  "),
      "confirmation_details_required",
    );
    rejected(
      () => prepare(name, samples[name], definition(name), "\u202e\u200b\n "),
      "confirmation_details_required",
    );
    const r = prepare(
      name,
      samples[name],
      definition(name),
      "群123 文件note.txt 上传者456 / 申请者789",
    );
    assert.ok(r.description.includes(JSON.stringify(samples[name])));
    assert.match(r.description, /note\.txt/);
  }
  rejected(
    () => prepare("group_sign", {}, definition("group_sign"), {} as string),
    "invalid_confirmation_details",
  );
});
test("all invisible format controls are escaped in display but original args remain unchanged", () => {
  const text =
    "left\u202eright\u2066x\u2069\u200b\u200d\uFEFF\u2028\u2029\u001b\nEND";
  const r = prepare(
    "publish_group_notice",
    { text },
    definition("publish_group_notice"),
    "目标\u202eBAD\nquoted",
  );
  assert.equal(r.args.text, text);
  assert.doesNotMatch(r.description, /[\p{Cf}\p{Zl}\p{Zp}\u001b]/u);
  for (const escaped of [
    "\\u202e",
    "\\u2066",
    "\\u2069",
    "\\u200b",
    "\\u200d",
    "\\ufeff",
    "\\u2028",
    "\\u2029",
    "\\u001b",
    "\\n",
  ])
    assert.ok(r.description.includes(escaped), escaped);
  assert.equal(r.description.split("\n").length, 5);
});
test("description limit rejects entire proposals rather than omitting large text or resolved details", () => {
  for (const [name, args, resolved] of [
    ["publish_group_notice", { text: "a".repeat(4000) }],
    ["send_group_ai_voice", { character_id: "v", text: "汉".repeat(1500) }],
    [
      "upload_group_file",
      { artifact_id: "art_" + "c".repeat(24) },
      "说明".repeat(2000),
    ],
  ] as [string, JsonObject, string?][])
    rejected(
      () => prepare(name, args, definition(name), resolved),
      "confirmation_description_too_large",
    );
  rejected(
    () => prepare("group_sign", {}, definition("group_sign"), "a".repeat(3500)),
    "confirmation_description_too_large",
  );
  const small = prepare(
    "upload_group_file",
    { artifact_id: "art_" + "c".repeat(24) },
    definition("upload_group_file"),
    '{"文件名":"a.txt","说明":"FULL\nCONTENT"}',
  );
  assert.match(small.description, /art_c{24}/);
  assert.match(small.description, /FULL\\nCONTENT/);
  let low = 0,
    high = 3500;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    try {
      prepare(
        "publish_group_notice",
        { text: "a".repeat(mid) },
        definition("publish_group_notice"),
      );
      low = mid;
    } catch {
      high = mid - 1;
    }
  }
  const boundary = prepare(
    "publish_group_notice",
    { text: "a".repeat(low) },
    definition("publish_group_notice"),
  );
  assert.equal(Buffer.byteLength(boundary.description), 3500);
  rejected(
    () =>
      prepare(
        "publish_group_notice",
        { text: "a".repeat(low + 1) },
        definition("publish_group_notice"),
      ),
    "confirmation_description_too_large",
  );
});
test("accessors prototypes sparse arrays symbols functions and proxies are rejected without executing user code", () => {
  let called = 0;
  const getter = Object.defineProperty({}, "text", {
    enumerable: true,
    get() {
      called++;
      throw new Error("PRIVATE");
    },
  });
  const proxy = new Proxy(
    { text: "x" },
    {
      get() {
        called++;
        throw new Error("PRIVATE");
      },
      ownKeys() {
        called++;
        throw new Error("PRIVATE");
      },
    },
  );
  for (const args of [
    getter,
    proxy,
    Object.create({ text: "x" }),
    {
      text: () => {
        called++;
      },
    },
    Object.assign(
      { text: "x" },
      {
        toJSON() {
          called++;
          return {};
        },
      },
    ),
    { text: "x", [Symbol("x")]: "PRIVATE" },
    JSON.parse('{"text":"x","__proto__":{}}'),
    Object.defineProperty({ text: "x" }, "hidden", { value: 1 }),
  ])
    rejected(
      () =>
        prepare(
          "publish_group_notice",
          args,
          definition("publish_group_notice"),
        ),
      "invalid_arguments",
    );
  for (const array of [
    Array(2),
    Object.assign(["123"], { extra: "x" }),
    Object.setPrototypeOf(["123"], null),
  ])
    rejected(
      () =>
        prepare(
          "send_group_forward",
          { message_ids: array },
          definition("send_group_forward"),
        ),
      "invalid_arguments",
    );
  assert.equal(called, 0);
  const badDefinition = Object.defineProperty({}, "function", {
    get() {
      called++;
      return {};
    },
  });
  rejected(
    () => prepare("group_sign", {}, badDefinition as ToolDefinition),
    "invalid_confirmation_schema",
  );
  assert.equal(called, 0);
});
test("only finite JSON graphs are cloned within depth node and byte budgets", () => {
  const d = definition("publish_group_notice");
  for (const value of [
    undefined,
    1n,
    NaN,
    Infinity,
    -Infinity,
    -0,
    new Date(),
    new Map(),
  ])
    rejected(
      () => prepare("publish_group_notice", { text: value }, d),
      "invalid_arguments",
    );
  const cycle: JsonObject = {};
  cycle.text = cycle;
  rejected(
    () => prepare("publish_group_notice", cycle, d),
    "invalid_arguments",
  );
  let nested: unknown = "x";
  for (let i = 0; i < 10; i++) nested = { x: nested };
  rejected(
    () => prepare("publish_group_notice", { text: nested }, d),
    "invalid_arguments",
  );
  rejected(
    () => prepare("publish_group_notice", { text: Array(4096).fill("x") }, d),
    "invalid_arguments",
  );
  rejected(
    () => prepare("publish_group_notice", { text: "a".repeat(300000) }, d),
    "invalid_arguments",
  );
  const nullProto = Object.assign(Object.create(null), { text: "ordinary" });
  assert.deepEqual(prepare("publish_group_notice", nullProto, d).args, {
    text: "ordinary",
  });
});
test("schema types ranges Unicode lengths arrays uniqueItems and deep enum equality are enforced", () => {
  const d = synthetic({
    s: { type: "string", minLength: 1, maxLength: 2, pattern: "^.+$" },
    i: { type: "integer", minimum: 1, maximum: 3 },
    n: { type: "number", minimum: 0.1, maximum: 1.5 },
    b: { type: "boolean" },
    a: {
      type: "array",
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
      items: { type: "string", enum: ["x", "y"] },
    },
    o: {
      type: "object",
      properties: { x: { type: "boolean" }, y: { type: "boolean" } },
      required: ["x", "y"],
      additionalProperties: false,
      enum: [{ y: false, x: true }],
    },
  });
  const args = {
    s: "😀",
    i: 2,
    n: 0.5,
    b: false,
    a: ["x", "y"],
    o: { x: true, y: false },
  };
  assert.deepEqual(prepare("publish_group_notice", args, d).args, args);
  for (const [key, value] of [
    ["s", ""],
    ["s", "abc"],
    ["s", "\n"],
    ["i", 1.5],
    ["i", 0],
    ["i", 4],
    ["i", Number.MAX_SAFE_INTEGER + 1],
    ["n", "0.5"],
    ["n", 0],
    ["n", 2],
    ["b", 0],
    ["a", []],
    ["a", ["x", "x"]],
    ["a", ["z"]],
    ["a", ["x", "y", "x"]],
    ["o", { x: false, y: true }],
    ["o", { x: true, y: false, extra: 1 }],
  ])
    rejected(
      () =>
        prepare("publish_group_notice", { ...args, [key as string]: value }, d),
      "invalid_arguments",
    );
});
test("unknown malformed or unsupported schema semantics fail closed even for absent optional fields", () => {
  const base = synthetic({ text: { type: "string" } }, []);
  for (const keyword of [
    "$ref",
    "oneOf",
    "anyOf",
    "not",
    "format",
    "default",
    "minProperties",
    "patternProperties",
    "additionalItems",
    "examples",
  ]) {
    const bad = structuredClone(base);
    (bad.function.parameters.properties as JsonObject).text = {
      type: "string",
      [keyword]: "PRIVATE",
    };
    rejected(
      () => prepare("publish_group_notice", {}, bad),
      "invalid_confirmation_schema",
    );
  }
  for (const change of [
    { type: "null" },
    { type: ["string", "null"] },
    { type: "array" },
    { type: "object", properties: {} },
    { type: "string", minLength: -1 },
    { type: "string", maxLength: 1.2 },
    { type: "string", pattern: "[" },
    { type: "string", enum: [] },
    { type: "boolean", minimum: 0 },
    { type: "array", items: { type: "string" }, uniqueItems: "yes" },
  ]) {
    const bad = structuredClone(base);
    (bad.function.parameters.properties as JsonObject).text = change;
    rejected(
      () => prepare("publish_group_notice", {}, bad),
      "invalid_confirmation_schema",
    );
  }
  const mismatched = structuredClone(base);
  mismatched.function.name = "leave_group";
  rejected(
    () => prepare("publish_group_notice", {}, mismatched),
    "invalid_confirmation_schema",
  );
  rejected(
    () => prepare("invented_tool", {}, base),
    "unsupported_confirmation_tool",
  );
});
