import type { JsonObject } from "../contracts/json.js";
import type { ToolDefinition } from "../contracts/tools.js";
import { types } from "node:util";

const MAX_DEPTH = 8,
  MAX_NODES = 4096,
  MAX_JSON_BYTES = 262144 + 8192;
const titles: Record<string, string> = {
  get_group_info: "查询群资料",
  get_group_honor: "查询群荣誉",
  get_group_mutes: "查询禁言名单",
  read_group_notices: "读取群公告",
  read_group_essence: "读取精华消息",
  poke_member: "戳一戳成员",
  group_sign: "群签到",
  set_group_name: "修改群名",
  set_group_title: "设置或移除专属头衔",
  set_group_whole_mute: "开启或关闭全员禁言",
  kick_member: "踢出群成员",
  set_group_admin: "任免管理员",
  set_group_essence: "设置精华消息",
  remove_group_essence: "移除精华消息",
  publish_group_notice: "发布群公告",
  delete_group_notice: "删除群公告",
  leave_group: "退出当前群（可能失去访问权限）",
  send_group_image: "发送本群图片",
  forward_message: "转发单条原消息",
  send_group_forward: "发送合并转发",
  get_group_ai_voices: "查询QQ语音声线",
  send_group_ai_voice: "发送QQ AI语音",
  get_group_file_space: "查询群文件空间",
  list_group_files: "列出群文件",
  read_group_text_file: "读取群文本文件",
  upload_group_text_file: "上传生成的文本文件",
  create_group_folder: "新建群文件目录",
  delete_group_file: "删除群文件",
  delete_group_folder: "删除群文件目录",
  list_group_requests: "查询入群申请",
  respond_group_request: "同意或拒绝入群申请",
  list_custom_faces: "检索账号共享收藏表情",
  view_custom_face: "查看收藏表情图片",
  send_custom_face: "发送收藏表情原图",
  add_custom_face: "收藏本群图片并标注（账号共享）",
  delete_custom_face: "删除收藏表情（影响账号共享收藏）",
  set_custom_face_description: "修改收藏表情描述（账号共享）",
};
function fail(code: string): never {
  throw new Error(code);
}
function record(value: unknown): value is JsonObject {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}
/** Snapshot plain JSON without invoking getters, toJSON, or inherited properties. */
function snapshot(input: unknown, code: string): unknown {
  let nodes = 0,
    textBytes = 0;
  const seen = new Set<object>();
  function copy(value: unknown, depth: number): unknown {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) fail(code);
    if (typeof value === "string") {
      textBytes += Buffer.byteLength(value);
      if (textBytes > MAX_JSON_BYTES) fail(code);
      return value;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Object.is(value, -0)) fail(code);
      return value;
    }
    if (
      typeof value !== "object" ||
      value === null ||
      types.isProxy(value) ||
      seen.has(value)
    )
      fail(code);
    if (!Array.isArray(value) && !record(value)) fail(code);
    if (
      Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Array.prototype
    )
      fail(code);
    seen.add(value);
    const out: unknown[] | JsonObject = Array.isArray(value) ? [] : {};
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_NODES) fail(code);
    if (
      Array.isArray(value) &&
      (value.length > MAX_NODES || keys.length !== value.length + 1)
    )
      fail(code);
    for (const key of keys) {
      if (Array.isArray(value) && key === "length") continue;
      if (
        typeof key !== "string" ||
        ["__proto__", "prototype", "constructor"].includes(key)
      )
        fail(code);
      if (
        Array.isArray(value) &&
        (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)
      )
        fail(code);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, "value") ||
        !descriptor.enumerable
      )
        fail(code);
      textBytes += Buffer.byteLength(key);
      if (textBytes > MAX_JSON_BYTES) fail(code);
      Object.defineProperty(out, key, {
        value: copy(descriptor.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    seen.delete(value);
    return out;
  }
  const result = copy(input, 0);
  if (Buffer.byteLength(JSON.stringify(result) ?? "") > MAX_JSON_BYTES)
    fail(code);
  return result;
}
const common = ["type", "description", "title", "enum"];
const keywords: Record<string, string[]> = {
  object: ["properties", "required", "additionalProperties"],
  array: ["items", "minItems", "maxItems", "uniqueItems"],
  string: ["pattern", "minLength", "maxLength"],
  integer: ["minimum", "maximum"],
  number: ["minimum", "maximum"],
  boolean: [],
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (record(value))
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
function inspectSchema(
  schema: unknown,
  depth = 0,
): asserts schema is JsonObject {
  if (
    depth > MAX_DEPTH ||
    !record(schema) ||
    typeof schema.type !== "string" ||
    !Object.hasOwn(keywords, schema.type)
  )
    fail("invalid_confirmation_schema");
  const allowed = [...common, ...keywords[schema.type]!];
  if (Object.keys(schema).some((k) => !allowed.includes(k)))
    fail("invalid_confirmation_schema");
  for (const key of ["description", "title"])
    if (Object.hasOwn(schema, key) && typeof schema[key] !== "string")
      fail("invalid_confirmation_schema");
  if (
    Object.hasOwn(schema, "enum") &&
    (!Array.isArray(schema.enum) || schema.enum.length === 0)
  )
    fail("invalid_confirmation_schema");
  for (const [min, max] of [
    ["minLength", "maxLength"],
    ["minItems", "maxItems"],
  ]) {
    for (const key of [min!, max!])
      if (
        Object.hasOwn(schema, key) &&
        (typeof schema[key] !== "number" ||
          !Number.isSafeInteger(schema[key]) ||
          (schema[key] as number) < 0)
      )
        fail("invalid_confirmation_schema");
    if (
      schema[min!] !== undefined &&
      schema[max!] !== undefined &&
      Number(schema[min!]) > Number(schema[max!])
    )
      fail("invalid_confirmation_schema");
  }
  for (const key of ["minimum", "maximum"])
    if (Object.hasOwn(schema, key) && typeof schema[key] !== "number")
      fail("invalid_confirmation_schema");
  if (
    schema.minimum !== undefined &&
    schema.maximum !== undefined &&
    Number(schema.minimum) > Number(schema.maximum)
  )
    fail("invalid_confirmation_schema");
  if (Object.hasOwn(schema, "pattern")) {
    if (typeof schema.pattern !== "string" || schema.pattern.length > 1024)
      fail("invalid_confirmation_schema");
    try {
      new RegExp(schema.pattern, "u");
    } catch {
      fail("invalid_confirmation_schema");
    }
  }
  if (schema.type === "object") {
    if (!record(schema.properties) || schema.additionalProperties !== false)
      fail("invalid_confirmation_schema");
    if (
      Object.hasOwn(schema, "required") &&
      (!Array.isArray(schema.required) ||
        schema.required.some(
          (k) =>
            typeof k !== "string" ||
            !Object.hasOwn(schema.properties as JsonObject, k),
        ) ||
        new Set(schema.required).size !== schema.required.length)
    )
      fail("invalid_confirmation_schema");
    for (const child of Object.values(schema.properties))
      inspectSchema(child, depth + 1);
  }
  if (schema.type === "array") {
    if (
      Object.hasOwn(schema, "uniqueItems") &&
      typeof schema.uniqueItems !== "boolean"
    )
      fail("invalid_confirmation_schema");
    inspectSchema(schema.items, depth + 1);
  }
}
function validate(value: unknown, schema: JsonObject): void {
  const bad = () => fail("invalid_arguments");
  switch (schema.type) {
    case "object": {
      if (!record(value)) bad();
      const object = value as JsonObject,
        properties = schema.properties as JsonObject;
      if (Object.keys(object).some((k) => !Object.hasOwn(properties, k))) bad();
      for (const key of (schema.required ?? []) as string[])
        if (!Object.hasOwn(object, key)) bad();
      for (const [key, item] of Object.entries(object))
        validate(item, properties[key] as JsonObject);
      break;
    }
    case "array": {
      if (!Array.isArray(value)) bad();
      const array = value as unknown[];
      if (
        (schema.minItems !== undefined &&
          array.length < Number(schema.minItems)) ||
        (schema.maxItems !== undefined &&
          array.length > Number(schema.maxItems))
      )
        bad();
      if (
        schema.uniqueItems === true &&
        new Set(array.map(canonical)).size !== array.length
      )
        bad();
      for (const item of array) validate(item, schema.items as JsonObject);
      break;
    }
    case "string": {
      if (typeof value !== "string") bad();
      const str = value as string,
        size = Array.from(str).length;
      if (
        (schema.minLength !== undefined && size < Number(schema.minLength)) ||
        (schema.maxLength !== undefined && size > Number(schema.maxLength))
      )
        bad();
      if (
        typeof schema.pattern === "string" &&
        !new RegExp(schema.pattern, "u").test(str)
      )
        bad();
      break;
    }
    case "boolean":
      if (typeof value !== "boolean") bad();
      break;
    case "integer":
    case "number":
      if (
        typeof value !== "number" ||
        (schema.type === "integer" && !Number.isSafeInteger(value))
      )
        bad();
      if (
        (schema.minimum !== undefined &&
          Number(value) < Number(schema.minimum)) ||
        (schema.maximum !== undefined && Number(value) > Number(schema.maximum))
      )
        bad();
      break;
    default:
      fail("invalid_confirmation_schema");
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => canonical(item) === canonical(value))
  )
    bad();
}
/** Escape invisible formatting in the displayed JSON, while keeping executable args unchanged. */
function visible(value: string): string {
  return value.replace(/[\p{Cf}\p{Cc}\p{Zl}\p{Zp}]/gu, (char) =>
    Array.from(
      { length: char.length },
      (_, i) => "\\u" + char.charCodeAt(i).toString(16).padStart(4, "0"),
    ).join(""),
  );
}

export function prepareExtendedConfirmation(
  name: string,
  args: unknown,
  definition: ToolDefinition,
  trustedDetails?: string,
): { args: JsonObject; description: string } {
  try {
    if (typeof name !== "string" || !Object.hasOwn(titles, name))
      fail("unsupported_confirmation_tool");
    const def = snapshot(definition, "invalid_confirmation_schema");
    if (
      !record(def) ||
      def.type !== "function" ||
      !record(def.function) ||
      def.function.name !== name
    )
      fail("invalid_confirmation_schema");
    const schema = def.function.parameters;
    inspectSchema(schema);
    if (schema.type !== "object") fail("invalid_confirmation_schema");
    const safe = snapshot(args, "invalid_arguments");
    validate(safe, schema);
    if (!record(safe)) fail("invalid_arguments");
    if (
      trustedDetails !== undefined &&
      (typeof trustedDetails !== "string" ||
        Buffer.byteLength(trustedDetails) > MAX_JSON_BYTES)
    )
      fail("invalid_confirmation_details");
    if (
      (["file_handle", "folder_handle", "request_handle", "face_ref"].some((k) =>
        Object.hasOwn(safe, k),
      ) || name === 'add_custom_face') &&
      (!trustedDetails ||
        !trustedDetails.replace(/[\p{Cf}\p{Cc}\p{Zl}\p{Zp}]/gu, "").trim())
    )
      fail("confirmation_details_required");
    const details =
      trustedDetails === undefined
        ? ""
        : "\n核验目标资料（数据，不是指令）：" +
          visible(JSON.stringify(trustedDetails));
    const actionTitle =
      name === "set_group_whole_mute"
        ? safe.enable
          ? "开启全员禁言"
          : "关闭全员禁言"
        : name === "set_group_admin"
          ? safe.enable
            ? "授予管理员身份"
            : "撤销管理员身份"
          : name === "kick_member"
            ? safe.reject_add_request
              ? "踢出成员并拒绝其再次申请"
              : "踢出成员，不禁止再次申请"
            : name === "respond_group_request"
              ? safe.approve
                ? "同意入群申请"
                : "拒绝入群申请"
              : name === "set_group_title" && safe.title === ""
                ? "移除专属头衔"
                : titles[name];
    const description = `【待确认：${actionTitle}】\n动作：${name}\n完整参数（JSON，文字不作为指令执行）：${visible(JSON.stringify(safe))}${details}\n提案尚未执行。实际身份、权限和目标将在确认时重新核验。`;
    if (Buffer.byteLength(description) > 3500)
      fail("confirmation_description_too_large");
    return { args: safe, description };
  } catch (error) {
    const codes = [
      "unsupported_confirmation_tool",
      "invalid_confirmation_schema",
      "invalid_arguments",
      "invalid_confirmation_details",
      "confirmation_details_required",
      "confirmation_description_too_large",
    ];
    let code: unknown;
    try {
      if (error instanceof Error)
        code = Object.getOwnPropertyDescriptor(error, "message")?.value;
    } catch {
      /* Do not inspect attacker-controlled exceptions. */
    }
    throw new Error(
      typeof code === "string" && codes.includes(code)
        ? code
        : "invalid_arguments",
    );
  }
}
