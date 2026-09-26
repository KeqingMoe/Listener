import { createHash, randomBytes } from "node:crypto";
import {
  resolveGroupId,
  type Api,
  type JsonObject,
  type ToolDefinition,
  type TurnContext,
} from "./contracts.js";

// Pinned NapCat v4.18.28 contracts:
// packages/napcat-onebot/action/system/GetSystemMsg.ts: join_requests = type 7,
// request_id = +native.seq, invitor_uin = +user1 UIN, checked = status != pending.
// packages/napcat-onebot/index.ts confirms type-7 user1 is the applicant.
// packages/napcat-onebot/action/group/SetGroupAddRequest.ts searches seq === flag;
// it accepts flag/approve/reason/count, WITHOUT group_id, and discards the ACK.
// Do not extend this bridge to imprecise numbers or invitations to join groups.
export const GROUP_REQUEST_TOOL_NAMES = Object.freeze([
  "list_group_requests",
  "respond_group_request",
] as const);
const TTL_MS = 15 * 60 * 1000,
  CAPACITY = 4096,
  SOURCE_LIMIT = 1000, // Bounded account-wide prefix, never a completeness claim.
  OUTPUT_LIMIT = 24 * 1024;
const NAMES = new Set<string>(GROUP_REQUEST_TOOL_NAMES);
interface Handle {
  key: string;
  flag: string;
  applicant: string;
  self: string;
  expires: number;
}
interface Pending {
  key: string;
  flag: string;
  applicant: string;
  raw: JsonObject;
}
function record(value: unknown): value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    return (
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Reflect.ownKeys(value).every(
        (k) =>
          typeof k === "string" &&
          Object.hasOwn(Object.getOwnPropertyDescriptor(value, k)!, "value"),
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
function safeNatural(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function flag(value: unknown): string | undefined {
  // The audited response is a number. String flags supplied by arbitrary raw
  // responses are not an alternative schema. Never recover rounded precision.
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : undefined;
}
class Denied extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function fail(code: string): never {
  throw new Denied(code);
}
function text(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  return value
    .slice(0, 1024)
    .replace(/[\u0000-\u001f\u007f\p{Cs}]/gu, "")
    .replace(/\[CQ:[^\]]*(?:\]|$)/g, "[unsupported segment]")
    .replace(/(?:https?:\/\/|file:\/\/|data:)[^\s]*/gi, "[redacted]");
}
function schema(properties: JsonObject, required: string[]): JsonObject {
  return { type: "object", additionalProperties: false, properties, required };
}

/** Persistent per Listener. reset() revokes capabilities, never unknown locks.
 * Locks survive wakes and manual resets in this process. Nothing stores flags
 * in model output, databases or logs; process restarts do not recover this state.
 */
export class GroupRequestTools {
  private readonly groupId: string;
  private readonly enabled: ReadonlySet<string>;
  private readonly handles = new Map<string, Handle>();
  private readonly uncertain = new Set<string>();
  private epoch = 0;
  private serial: Promise<void> = Promise.resolve();
  constructor(
    private readonly api: Api,
    groupId: string,
    enabledNames: readonly string[] = [],
  ) {
    this.groupId = resolveGroupId(groupId);
    if (!Array.isArray(enabledNames) || enabledNames.some((n) => !NAMES.has(n)))
      throw new Error("Invalid group request capabilities");
    this.enabled = new Set(enabledNames);
  }
  reset(): void {
    this.epoch++;
    this.handles.clear();
  }
  /** Wake boundaries intentionally preserve handles and unknown locks. */
  resetWake(): void {}
  definitions(): ToolDefinition[] {
    const list: ToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "list_group_requests",
          description:
            "读取当前群尚待处理的直接入群申请，须Bot为本群管理员或群主。仅返回本群有损过滤后的观察与15分钟临时request_handle，不接受/输出原始flag；不显示邀请Bot加入其他群的请求。limit为必填正安全整数，offset仅对本次新查询快照本地分页；上游仅读取全账号最多1000条通知形成的前缀，不是本群全部申请；未见不表示不存在，覆盖及缺字段情况未知，不承诺列尽。",
          parameters: schema(
            {
              limit: { type: "integer", minimum: 1 },
              offset: { type: "integer", minimum: 0 },
            },
            ["limit"],
          ),
        },
      },
      {
        type: "function",
        function: {
          name: "respond_group_request",
          description:
            "处理通过list_group_requests获得的本群申请handle；approve和reason都必填，同意时reason必须为空串，拒绝理由原样发送且最多512 UTF-8字节。重新核验本群申请仍待处理、申请人、Bot身份与管理员权限。立即执行，不隐式确认；上游无可信ACK，派发后结果为unknown，禁止重试或反向操作，该申请在后续唤醒仍锁定。",
          parameters: schema(
            {
              request_handle: { type: "string", pattern: "^grq_[0-9a-f]{48}$" },
              approve: { type: "boolean" },
              reason: { type: "string", maxLength: 512 },
            },
            ["request_handle", "approve", "reason"],
          ),
        },
      },
    ];
    return list.filter((t) => this.enabled.has(t.function.name));
  }
  async execute(
    name: string,
    value: unknown,
    context: TurnContext,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    const generation = this.epoch;
    let args: JsonObject, self: string;
    try {
      this.check(generation, signal);
      if (!NAMES.has(name) || !this.enabled.has(name)) fail("tool_disabled");
      if (!record(context) || context.groupId !== this.groupId)
        fail("forbidden_group");
      if (
        typeof context.selfId !== "string" ||
        id(context.selfId) !== context.selfId
      )
        fail("invalid_identity");
      self = context.selfId;
      args = this.parse(name, value);
    } catch (error) {
      return this.error(error, signal);
    }
    const before = this.serial;
    let release!: () => void;
    this.serial = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await before;
      this.check(generation, signal);
      this.prune();
      return name === "list_group_requests"
        ? await this.list(args, self, generation, signal)
        : await this.respond(args, self, generation, signal);
    } catch (error) {
      return this.error(error, signal);
    } finally {
      release();
    }
  }
  private parse(name: string, value: unknown): JsonObject {
    const allowed =
      name === "list_group_requests"
        ? ["limit", "offset"]
        : ["request_handle", "approve", "reason"];
    if (!record(value) || Object.keys(value).some((k) => !allowed.includes(k)))
      fail("invalid_arguments");
    if (name === "list_group_requests") {
      if (
        !Object.hasOwn(value, "limit") ||
        !safeNatural(value.limit) ||
        value.limit === 0 ||
        (Object.hasOwn(value, "offset") && !safeNatural(value.offset))
      )
        fail("invalid_arguments");
      return { limit: value.limit, offset: value.offset ?? 0 };
    }
    if (
      Object.keys(value).length !== 3 ||
      typeof value.request_handle !== "string" ||
      !/^grq_[0-9a-f]{48}$/.test(value.request_handle) ||
      typeof value.approve !== "boolean" ||
      typeof value.reason !== "string" ||
      Buffer.byteLength(value.reason) > 512 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\p{Cs}]/u.test(
        value.reason,
      ) ||
      (value.approve && value.reason !== "")
    )
      fail("invalid_arguments");
    return {
      request_handle: value.request_handle,
      approve: value.approve,
      reason: value.reason,
    };
  }
  private check(generation: number, signal?: AbortSignal): void {
    if (signal?.aborted) fail("cancelled");
    if (generation !== this.epoch) fail("capabilities_revoked");
  }
  private error(error: unknown, signal?: AbortSignal): JsonObject {
    return {
      status: "error",
      error: signal?.aborted
        ? "cancelled"
        : error instanceof Denied
          ? error.code
          : "verification_failed",
    };
  }
  private async read(
    action: string,
    params: JsonObject,
    generation: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.check(generation, signal);
    let value: unknown;
    try {
      value = await this.api.call(action, params);
    } catch {
      this.check(generation, signal);
      fail("verification_unavailable");
    }
    this.check(generation, signal);
    return value;
  }
  private async authorize(
    self: string,
    generation: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const login = await this.read("get_login_info", {}, generation, signal);
    if (!record(login) || id(login.user_id) !== self) fail("identity_mismatch");
    const member = await this.read(
      "get_group_member_info",
      { group_id: this.groupId, user_id: self, no_cache: true },
      generation,
      signal,
    );
    if (
      !record(member) ||
      id(member.group_id) !== this.groupId ||
      id(member.user_id) !== self
    )
      fail("verification_failed");
    if (member.role !== "admin" && member.role !== "owner")
      fail("permission_denied");
  }
  private key(self: string, nativeFlag: string): string {
    return createHash("sha256")
      .update(JSON.stringify([self, this.groupId, nativeFlag]))
      .digest("hex");
  }
  private async pending(
    self: string,
    generation: number,
    signal?: AbortSignal,
  ): Promise<Pending[]> {
    const raw = await this.read(
      "get_group_system_msg",
      { count: SOURCE_LIMIT },
      generation,
      signal,
    );
    if (
      !record(raw) ||
      !Array.isArray(raw.join_requests) ||
      !Array.isArray(raw.invited_requests)
    )
      fail("invalid_response");
    const invitations = raw.invited_requests;
    // Compatibility alias is included for ambiguity checking, without counting
    // exact alias entries as duplicates. A different matching invite always blocks.
    const alias = Array.isArray(raw.InvitedRequest) ? raw.InvitedRequest : [];
    if (
      raw.join_requests.length + invitations.length > SOURCE_LIMIT ||
      alias.length > SOURCE_LIMIT
    )
      fail("resource_limit");
    const seen = new Map<string, number>(),
      blocked = new Set<string>();
    for (const row of raw.join_requests) {
      if (record(row)) {
        const f = flag(row.request_id);
        if (f) seen.set(f, (seen.get(f) ?? 0) + 1);
      }
    }
    for (const row of [...invitations, ...alias]) {
      if (record(row)) {
        const f = flag(row.request_id);
        if (f) blocked.add(f);
      }
    }
    const result: Pending[] = [];
    for (const row of raw.join_requests) {
      if (
        !record(row) ||
        id(row.group_id) !== this.groupId ||
        row.checked !== false
      )
        continue;
      const nativeFlag = flag(row.request_id),
        applicant = id(row.invitor_uin);
      if (
        !nativeFlag ||
        !applicant ||
        seen.get(nativeFlag) !== 1 ||
        blocked.has(nativeFlag)
      )
        continue;
      result.push({
        key: this.key(self, nativeFlag),
        flag: nativeFlag,
        applicant,
        raw: row,
      });
    }
    return result;
  }
  private prune(): void {
    const now = Date.now();
    for (const [token, h] of this.handles)
      if (h.expires <= now) this.handles.delete(token);
  }
  private issue(row: Pending, self: string): string {
    for (const [token, h] of this.handles)
      if (h.key === row.key && h.applicant === row.applicant && h.self === self)
        return token;
    if (this.handles.size >= CAPACITY) fail("handle_capacity");
    const token = `grq_${randomBytes(24).toString("hex")}`;
    this.handles.set(token, {
      key: row.key,
      flag: row.flag,
      applicant: row.applicant,
      self,
      expires: Date.now() + TTL_MS,
    });
    return token;
  }
  private async list(
    args: JsonObject,
    self: string,
    generation: number,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    await this.authorize(self, generation, signal);
    const rows = await this.pending(self, generation, signal),
      offset = args.offset as number,
      requested = args.limit as number;
    const end =
      offset >= rows.length
        ? offset
        : offset + Math.min(requested, rows.length - offset);
    const items: JsonObject[] = [];
    let index = offset,
      bytes = 0,
      reason = "limit";
    for (; index < end; index++) {
      const row = rows[index]!;
      const item: JsonObject = {
        applicant_id: row.applicant,
        pending_observed: true,
        untrusted: true,
      };
      const message = text(row.raw.message),
        nickname = text(row.raw.requester_nick);
      if (message !== undefined) item.message = message;
      if (nickname !== undefined) item.applicant_nickname = nickname;
      if (
        (typeof row.raw.message === "string" &&
          row.raw.message.length > 1024) ||
        (typeof row.raw.requester_nick === "string" &&
          row.raw.requester_nick.length > 1024)
      )
        item.content_truncated = true;
      if (this.uncertain.has(row.key)) item.previous_outcome = "unknown";
      const size = Buffer.byteLength(JSON.stringify(item)) + 150;
      if (bytes + size > OUTPUT_LIMIT - 2000) {
        reason = "output_limit";
        break;
      }
      try {
        const token = this.issue(row, self);
        item.request_handle = token;
        item.request_handle_expires_at =
          this.handles.get(token)!.expires / 1000;
      } catch (error) {
        if (!(error instanceof Denied) || error.code !== "handle_capacity")
          throw error;
        reason = "handle_capacity";
        break;
      }
      items.push(item);
      bytes += size;
    }
    this.check(generation, signal);
    const more = index < rows.length;
    const result: JsonObject = {
      status: "ok",
      untrusted: true,
      group_id: this.groupId,
      queried_at: Date.now() / 1000,
      items,
      requested,
      returned: items.length,
      offset,
      next_offset: more ? index : null,
      has_more: more,
      truncated: more || items.some((x) => x.content_truncated === true),
      reason: more ? reason : "end_of_observed_requests",
      total: rows.length,
      total_scope: "eligible_observed_current_group_requests",
      completeness: "unknown_upstream_coverage_and_unverifiable_entries",
      upstream_coverage: "bounded_account_prefix_missing_is_not_absence",
      upstream_has_more: null,
      pagination: "local_slice_of_fresh_response",
      handle_ttl_seconds: TTL_MS / 1000,
    };
    if (Buffer.byteLength(JSON.stringify(result)) > OUTPUT_LIMIT)
      fail("resource_limit");
    return result;
  }
  private async respond(
    args: JsonObject,
    self: string,
    generation: number,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    const handle = this.handles.get(args.request_handle as string);
    if (!handle || handle.expires <= Date.now() || handle.self !== self)
      fail("invalid_request_handle");
    if (this.uncertain.has(handle.key)) fail("previous_result_unknown");
    if (this.uncertain.size >= CAPACITY) fail("outcome_lock_capacity");
    await this.authorize(self, generation, signal);
    const rows = await this.pending(self, generation, signal);
    const current = rows.find(
      (row) =>
        row.key === handle.key &&
        row.applicant === handle.applicant &&
        row.flag === handle.flag,
    );
    if (!current) fail("request_not_pending_or_changed");
    // List fetching can be slow. Refresh both account identity and authority
    // immediately before dispatch rather than reusing the pre-query role.
    await this.authorize(self, generation, signal);
    if (
      handle.expires <= Date.now() ||
      this.handles.get(args.request_handle as string) !== handle
    )
      fail("invalid_request_handle");
    this.check(generation, signal);
    this.uncertain.add(handle.key); // Reserved before external effects, survives reset.
    try {
      await this.api.call("set_group_add_request", {
        flag: handle.flag,
        approve: args.approve,
        reason: args.reason,
        count: SOURCE_LIMIT,
      });
    } catch {
      /* An exception after dispatch cannot prove non-execution. */
    }
    return {
      status: "unknown",
      action: "respond_group_request",
      group_id: this.groupId,
      retry_allowed: false,
      ...(signal?.aborted ? { cancelled_after_dispatch: true } : {}),
    };
  }
}
