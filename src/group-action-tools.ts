import { createHash } from "node:crypto";
import {
  resolveGroupId,
  type Api,
  type JsonObject,
  type Memory,
  type ToolDefinition,
  type TurnContext,
} from "./contracts.js";

/** NapCat v4.18.28: set_group_leave ignores is_dismiss; no dismiss tool is offered. */
export const GROUP_ACTION_TOOL_NAMES = [
  "poke_member",
  "group_sign",
  "set_group_name",
  "set_group_title",
  "set_group_whole_mute",
  "kick_member",
  "set_group_admin",
  "set_group_essence",
  "remove_group_essence",
  "publish_group_notice",
  "delete_group_notice",
  "leave_group",
] as const;
type Name = (typeof GROUP_ACTION_TOOL_NAMES)[number];
type Role = "member" | "admin" | "owner";
const userId = { type: "string", pattern: "^[1-9][0-9]{0,31}$", maxLength: 32 };
const messageId = {
  type: "string",
  pattern: "^(0|-?[1-9][0-9]{0,16})$",
  maxLength: 17,
};
const fields: Record<Name, JsonObject> = {
  poke_member: { user_id: userId },
  group_sign: {},
  set_group_name: { name: { type: "string", minLength: 1, maxLength: 60 } },
  set_group_title: {
    user_id: userId,
    title: { type: "string", maxLength: 60 },
  },
  set_group_whole_mute: { enable: { type: "boolean" } },
  kick_member: { user_id: userId, reject_add_request: { type: "boolean" } },
  set_group_admin: { user_id: userId, enable: { type: "boolean" } },
  set_group_essence: { message_id: messageId },
  remove_group_essence: { message_id: messageId },
  publish_group_notice: {
    text: { type: "string", minLength: 1, maxLength: 16384 },
  },
  delete_group_notice: {
    notice_id: { type: "string", minLength: 1, maxLength: 256 },
  },
  leave_group: {},
};
const descriptions: Record<Name, string> = {
  poke_member: "向核验的本群成员戳一戳。",
  group_sign: "以Bot账号在本群签到。",
  set_group_name: "修改本群名称，需要Bot管理员或群主权限。",
  set_group_title: "设置本群成员专属头衔，空字符串移除；需要Bot群主权限。",
  set_group_whole_mute: "明确开启或关闭本群全员禁言，需要Bot管理员或群主权限。",
  kick_member:
    "将核验的成员移出本群；reject_add_request必须明确指定。需要真实QQ权限。",
  set_group_admin: "任免本群管理员，enable必须明确指定；需要Bot群主权限。",
  set_group_essence:
    "将当前群可见消息或可核验直接引用设为精华，不接受转发内部或猜测ID。上游确认格式未核实，派发后返回unknown并禁止重试或反向操作。",
  remove_group_essence:
    "移除当前群可见消息或可核验直接引用的精华，不接受精华列表合成ID。上游确认格式未核实，派发后返回unknown并禁止重试或反向操作。",
  publish_group_notice:
    "在本群发布纯文字公告，需要Bot管理员或群主权限；文本不作为图片URL或文件路径读取。",
  delete_group_notice:
    "删除本群当前公告列表中核验存在的公告，需要Bot管理员或群主权限。上游未提供可核实的确认，派发后返回unknown并禁止重试。",
  leave_group:
    "请求Bot退出当前群。上游不保证区分群主退群与解散，不提供解散工具；执行后可能失去本群访问能力。",
};
const names = new Set<string>(GROUP_ACTION_TOOL_NAMES);
function record(value: unknown): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return (
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Reflect.ownKeys(value).every(
        (key) =>
          typeof key === "string" &&
          Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"),
      )
    );
  } catch {
    return false;
  }
}
function id(value: unknown): string | undefined {
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  return typeof value === "string" && /^[1-9]\d{0,31}$/.test(value)
    ? value
    : undefined;
}
function mid(value: unknown): string | undefined {
  const text =
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0)
      ? String(value)
      : value;
  return typeof text === "string" &&
    /^(0|-?[1-9]\d{0,16})$/.test(text) &&
    Number.isSafeInteger(Number(text))
    ? text
    : undefined;
}
function plainText(
  value: unknown,
  bytes: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.trim().length > 0) &&
    Buffer.byteLength(value, "utf8") <= bytes &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cs}]/u.test(value)
  );
}
class Denied extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function fail(code: string): never {
  throw new Denied(code);
}
const check = (signal?: AbortSignal) => {
  if (signal?.aborted) fail("cancelled");
};

/** One instance per wake: dedup/unknown locks must never be shared across wakes. */
export class GroupActionTools {
  private readonly groupId: string;
  private readonly enabled: ReadonlySet<string>;
  private readonly latest = new Map<
    string,
    { fingerprint: string; result: JsonObject }
  >();
  private readonly uncertain = new Set<string>();
  private serial: Promise<void> = Promise.resolve();
  constructor(
    private readonly api: Api,
    groupId: string,
    enabledTools: readonly string[] = [],
    private readonly memory: Pick<Memory, "recent" | "find"> = {
      recent: () => [],
      find: () => undefined,
    },
  ) {
    this.groupId = resolveGroupId(groupId);
    if (
      !Array.isArray(enabledTools) ||
      enabledTools.some((name) => !names.has(name))
    )
      throw new Error("Invalid group action capabilities");
    this.enabled = new Set(enabledTools);
  }
  definitions(): ToolDefinition[] {
    return GROUP_ACTION_TOOL_NAMES.filter((name) => this.enabled.has(name)).map(
      (name) => ({
        type: "function",
        function: {
          name,
          description: `${descriptions[name]}仅在显式启用时提供，立即执行，无隐式确认；unknown不代表失败，禁止重试或反向操作。`,
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: structuredClone(fields[name]),
            required: Object.keys(fields[name]),
          },
        },
      }),
    );
  }
  async execute(
    name: string,
    args: unknown,
    ctx: TurnContext,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    // Copy trusted metadata and validated values before waiting for earlier dispatches.
    let action: Name, value: JsonObject, context: TurnContext;
    try {
      check(signal);
      if (!names.has(name) || !this.enabled.has(name)) fail("tool_disabled");
      action = name as Name;
      value = this.parse(action, args);
      if (!record(ctx) || ctx.groupId !== this.groupId) fail("forbidden_group");
      if (
        typeof ctx.selfId !== "string" ||
        id(ctx.selfId) !== ctx.selfId ||
        typeof ctx.actorId !== "string" ||
        id(ctx.actorId) !== ctx.actorId ||
        typeof ctx.messageId !== "string" ||
        mid(ctx.messageId) !== ctx.messageId
      )
        fail("invalid_context");
      context = {
        groupId: this.groupId,
        selfId: ctx.selfId,
        actorId: ctx.actorId,
        messageId: ctx.messageId,
      };
    } catch (error) {
      return this.error(error);
    }
    const previous = this.serial;
    let release!: () => void;
    this.serial = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      check(signal);
      return await this.run(action, value, context, signal);
    } catch (error) {
      return this.error(error);
    } finally {
      release();
    }
  }
  private error(error: unknown): JsonObject {
    return {
      status: "error",
      error: error instanceof Denied ? error.code : "verification_failed",
    };
  }
  private parse(name: Name, args: unknown): JsonObject {
    const required = Object.keys(fields[name]);
    if (
      !record(args) ||
      Reflect.ownKeys(args).length !== required.length ||
      required.some((key) => !Object.hasOwn(args, key))
    )
      fail("invalid_arguments");
    if (
      "user_id" in args &&
      (typeof args.user_id !== "string" || id(args.user_id) !== args.user_id)
    )
      fail("invalid_arguments");
    if (
      "message_id" in args &&
      (typeof args.message_id !== "string" ||
        mid(args.message_id) !== args.message_id)
    )
      fail("invalid_arguments");
    for (const key of ["enable", "reject_add_request"])
      if (key in args && typeof args[key] !== "boolean")
        fail("invalid_arguments");
    if (
      "name" in args &&
      (!plainText(args.name, 240) ||
        Array.from(args.name).length > 60 ||
        /[\r\n\t]/.test(args.name))
    )
      fail("invalid_arguments");
    if (
      "title" in args &&
      (!plainText(args.title, 240, true) ||
        Array.from(args.title).length > 60 ||
        /[\r\n\t]/.test(args.title))
    )
      fail("invalid_arguments");
    if ("text" in args && !plainText(args.text, 16384))
      fail("invalid_arguments");
    if (
      "notice_id" in args &&
      (typeof args.notice_id !== "string" ||
        !/^[A-Za-z0-9_-]{1,256}$/.test(args.notice_id))
    )
      fail("invalid_arguments");
    // Packet operations coerce QQ IDs with unary + in NapCat: refuse precision loss.
    if (
      ["poke_member", "group_sign", "set_group_title"].includes(name) &&
      (!Number.isSafeInteger(Number(this.groupId)) ||
        ("user_id" in args && !Number.isSafeInteger(Number(args.user_id))))
    )
      fail("invalid_arguments");
    return Object.fromEntries(required.map((key) => [key, args[key]]));
  }
  private async read(
    action: string,
    params: JsonObject,
    signal?: AbortSignal,
  ): Promise<unknown> {
    check(signal);
    let value: unknown;
    try {
      value = await this.api.call(action, params);
    } catch {
      check(signal);
      fail("verification_unavailable");
    }
    check(signal);
    return value;
  }
  private member(value: unknown, user: string): Role {
    if (
      !record(value) ||
      id(value.group_id) !== this.groupId ||
      id(value.user_id) !== user ||
      !["member", "admin", "owner"].includes(value.role as string)
    )
      fail("verification_failed");
    return value.role as Role;
  }
  private visible(message: string): { userId?: string } {
    const recent = this.memory.recent();
    const own = recent.find((entry) => entry.messageId === message);
    if (own) {
      if (!id(own.userId)) fail("verification_failed");
      return { userId: own.userId };
    }
    if (
      !recent.some(
        (entry) =>
          entry.replyTo === message && mid(entry.messageId) && id(entry.userId),
      )
    )
      fail("forbidden_reference");
    return {};
  }
  private async verify(
    name: Name,
    args: JsonObject,
    ctx: TurnContext,
    signal?: AbortSignal,
    cached = false,
  ) {
    const proof =
      !cached && "message_id" in args
        ? this.visible(args.message_id as string)
        : undefined;
    const login = await this.read("get_login_info", {}, signal);
    if (!record(login) || id(login.user_id) !== ctx.selfId)
      fail("identity_mismatch");
    const bot = this.member(
      await this.read(
        "get_group_member_info",
        { group_id: this.groupId, user_id: ctx.selfId, no_cache: true },
        signal,
      ),
      ctx.selfId,
    );
    if (
      ["set_group_title", "set_group_admin"].includes(name) &&
      bot !== "owner"
    )
      fail("permission_denied");
    if (
      !["poke_member", "group_sign", "leave_group"].includes(name) &&
      bot === "member"
    )
      fail("permission_denied");
    // This returns an earlier checked acknowledgement, not a fresh operation.
    // Identity and bot permission still have to pass before reusing it.
    if (cached) return;
    if ("user_id" in args) {
      const role = this.member(
        await this.read(
          "get_group_member_info",
          { group_id: this.groupId, user_id: args.user_id, no_cache: true },
          signal,
        ),
        args.user_id as string,
      );
      if (
        name === "kick_member" &&
        (role === "owner" || (bot === "admin" && role !== "member"))
      )
        fail("permission_denied");
      if (name === "set_group_admin" && role === "owner")
        fail("permission_denied");
    }
    if (proof) {
      const message = await this.read(
        "get_msg",
        { message_id: args.message_id },
        signal,
      );
      if (
        !record(message) ||
        message.message_type !== "group" ||
        id(message.group_id) !== this.groupId ||
        mid(message.message_id) !== args.message_id ||
        !record(message.sender)
      )
        fail("verification_failed");
      const sender = id(message.sender.user_id);
      if (
        !sender ||
        ("user_id" in message && id(message.user_id) !== sender) ||
        (proof.userId && sender !== proof.userId)
      )
        fail("verification_failed");
      const current = this.visible(args.message_id as string);
      if (current.userId && sender !== current.userId)
        fail("verification_failed");
    }
    if (name === "delete_group_notice") {
      const notices = await this.read(
        "_get_group_notice",
        { group_id: this.groupId },
        signal,
      );
      if (
        !Array.isArray(notices) ||
        notices.length > 10000 ||
        !notices.every(
          (item) =>
            record(item) &&
            typeof item.notice_id === "string" &&
            (!("group_id" in item) || id(item.group_id) === this.groupId),
        )
      )
        fail("verification_failed");
      if (
        !notices.some(
          (item) => (item as JsonObject).notice_id === args.notice_id,
        )
      )
        fail("forbidden_reference");
    }
  }
  // Field/ACK audit: https://github.com/NapNeko/NapCatQQ/tree/v4.18.28/packages/napcat-onebot/action
  // group/SetGroupName.ts and SetGroupWholeBan.ts check result===0 before null.
  // go-cqhttp/SendGroupNotice.ts checks WebApi.ec===0 before void (wire data:null).
  // group/{SetEssenceMsg,DelEssenceMsg}.ts return untyped native results:
  // core/services/NodeIKernelGroupService.ts declares add/removeGroupEssence
  // as Promise<unknown>, NOT GeneralCallResult. A guessed {result:0} is no ACK.
  // deleteGroupBulletin is declared void; DelGroupNotice forwards it unchanged.
  // These three operations remain unknown after dispatch until a real semantic
  // acknowledgement contract is verified; do not infer success from fixtures.
  // group/{SetGroupAdmin,SetGroupKick,SetGroupLeave}.ts discard native result.
  // packet/SendPoke.ts and extends/{SetGroupSign,SetSpecialTitle}.ts only send
  // packets: core/packet/context/operationContext.ts awaits sendOidbPacket with
  // the default rsp=false; no parsed server acknowledgement is obtained.
  private native(
    name: Name,
    args: JsonObject,
  ): {
    action: string;
    params: JsonObject;
    ack: "checked_null" | "unverified";
  } {
    const group_id = this.groupId;
    switch (name) {
      case "poke_member":
        return {
          action: "group_poke",
          params: { group_id, user_id: args.user_id },
          ack: "unverified",
        };
      case "group_sign":
        return {
          action: "set_group_sign",
          params: { group_id },
          ack: "unverified",
        };
      case "set_group_name":
        return {
          action: "set_group_name",
          params: { group_id, group_name: args.name },
          ack: "checked_null",
        };
      case "set_group_title":
        return {
          action: "set_group_special_title",
          params: {
            group_id,
            user_id: args.user_id,
            special_title: args.title,
          },
          ack: "unverified",
        };
      case "set_group_whole_mute":
        return {
          action: "set_group_whole_ban",
          params: { group_id, enable: args.enable },
          ack: "checked_null",
        };
      case "kick_member":
        return {
          action: "set_group_kick",
          params: {
            group_id,
            user_id: args.user_id,
            reject_add_request: args.reject_add_request,
          },
          ack: "unverified",
        };
      case "set_group_admin":
        return {
          action: "set_group_admin",
          params: { group_id, user_id: args.user_id, enable: args.enable },
          ack: "unverified",
        };
      case "set_group_essence":
        return {
          action: "set_essence_msg",
          params: { message_id: args.message_id },
          ack: "unverified",
        };
      case "remove_group_essence":
        return {
          action: "delete_essence_msg",
          params: { message_id: args.message_id },
          ack: "unverified",
        };
      case "publish_group_notice":
        return {
          action: "_send_group_notice",
          params: {
            group_id,
            content: args.text,
            pinned: 0,
            type: 1,
            confirm_required: 1,
            is_show_edit_card: 0,
            tip_window_type: 0,
          },
          ack: "checked_null",
        };
      case "delete_group_notice":
        return {
          action: "_del_group_notice",
          params: { group_id, notice_id: args.notice_id },
          ack: "unverified",
        };
      case "leave_group":
        return {
          action: "set_group_leave",
          params: { group_id, is_dismiss: false },
          ack: "unverified",
        };
    }
  }
  private async run(
    name: Name,
    args: JsonObject,
    ctx: TurnContext,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    const target =
      typeof args.user_id === "string"
        ? `member:${args.user_id}`
        : typeof args.message_id === "string"
          ? `message:${args.message_id}`
          : typeof args.notice_id === "string"
            ? `notice:${args.notice_id}`
            : "group";
    const family = ["set_group_essence", "remove_group_essence"].includes(name)
      ? "essence"
      : name;
    const key = `${family}:${target}`;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([name, args, ctx.selfId]))
      .digest("hex");
    if (this.uncertain.has("group") || this.uncertain.has(target))
      return {
        status: "unknown",
        error: "previous_result_unknown",
        retry_allowed: false,
      };
    // Every new dispatch rechecks live login/group/role; cached confirmations are not new dispatches.
    const cached = this.latest.get(key);
    const hit = cached?.fingerprint === fingerprint;
    await this.verify(name, args, ctx, signal, hit);
    if (hit) return { ...cached!.result, cached: true };
    const native = this.native(name, args);
    check(signal);
    this.latest.delete(key);
    const unknown = (): JsonObject => {
      this.uncertain.add(target);
      return {
        status: "unknown",
        error: "action_result_unknown",
        retry_allowed: false,
      };
    };
    let result: unknown;
    try {
      result = await this.api.call(native.action, native.params);
    } catch {
      return unknown();
    }
    // Never report cancelled/not executed after a write was dispatched.
    const ack = native.ack === "checked_null" && result === null;
    if (!ack) return unknown();
    const confirmed: JsonObject = {
      status: "executed",
      action: name,
      group_id: this.groupId,
    };
    this.latest.set(key, { fingerprint, result: confirmed });
    return {
      ...confirmed,
      ...(signal?.aborted ? { cancelled_after_dispatch: true } : {}),
    };
  }
}
