import { createHash } from "node:crypto";
import {
  resolveGroupId,
  type Api,
  type JsonObject,
  type ToolDefinition,
  type TurnContext,
} from "./contracts/index.js";
import { submittedResult, writeFailure, afterDispatch } from './operation-result.js';

export const GROUP_VOICE_TOOL_NAMES = [
  "get_group_ai_voices",
  "send_group_ai_voice",
] as const;
type Name = (typeof GROUP_VOICE_TOOL_NAMES)[number];
interface Voice {
  type: string;
  character_id: string;
  character_name: string;
}
const MAX_ROWS = 10000,
  MAX_OUTPUT = 24 * 1024,
  MAX_TEXT = 8192,
  MAX_OPERATIONS = 4096;
const record = (v: unknown): v is JsonObject =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): string | undefined => {
  if (typeof v === "number" && Number.isSafeInteger(v)) v = String(v);
  return typeof v === "string" && /^[1-9]\d{0,31}$/.test(v) ? v : undefined;
};
function characterId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    !/[\s\u0000-\u001f\u007f-\u009f/\\?#]/.test(value) &&
    !/^(?:https?|file|data|base64):/i.test(value)
  );
}
function label(value: string): string {
  return Array.from(
    value
      .replace(/(?:https?|file|data|base64):\S*/gi, "[redacted]")
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, ""),
  )
    .slice(0, 160)
    .join("");
}
class Failure extends Error {}
function fail(code: string): never {
  throw new Failure(code);
}
function check(signal?: AbortSignal): void {
  if (signal?.aborted) fail("cancelled");
}
const tool = (
  name: Name,
  description: string,
  properties: JsonObject,
  required: string[],
): ToolDefinition => ({
  type: "function",
  function: {
    name,
    description,
    parameters: {
      type: "object",
      additionalProperties: false,
      required,
      properties,
    },
  },
});
const DEFINITIONS: ToolDefinition[] = [
  tool(
    "get_group_ai_voices",
    "实时查询当前群可用QQ AI语音声线。limit必填正安全整数，offset为可选非负安全整数。只返回分类、声线ID和名称，不提供预览URL；空列表仅代表本次原生快照。输出超过通用资源边界时按next_offset继续。",
    {
      limit: { type: "integer", minimum: 1 },
      offset: { type: "integer", minimum: 0 },
    },
    ["limit"],
  ),
  tool(
    "send_group_ai_voice",
    "用当前群实时可用的character_id发送QQ AI语音。text仅为原样语音文本，不解析CQ或下载URL，UTF-8资源上限8192字节。原生接口不返回真实消息ID；正常返回ok且submitted表示请求已提交，不是错误或未知，也不证明已送达。message_id始终null，不得伪造消息事实；每次明确工具调用均独立发送一次，正常提交不吞掉后续相同调用；不自动重试，真正unknown才阻止相同请求盲重放。",
    {
      character_id: { type: "string", minLength: 1, maxLength: 128 },
      text: { type: "string", minLength: 1 },
    },
    ["character_id", "text"],
  ),
];

/** Group-scoped, per-wake voice operations. Does not fabricate sent-message facts. */
export class GroupVoiceTools {
  private readonly groupId: string;
  private readonly enabled: ReadonlySet<string>;
  private readonly operations = new Map<string, Promise<JsonObject>>();
  constructor(
    private readonly api: Api,
    groupId: string,
    enabledNames: readonly string[] = [],
  ) {
    this.groupId = resolveGroupId(groupId);
    if (
      !Array.isArray(enabledNames) ||
      enabledNames.some(
        (n) => !(GROUP_VOICE_TOOL_NAMES as readonly string[]).includes(n),
      )
    )
      throw new Error("Invalid group voice tool names");
    this.enabled = new Set(enabledNames);
  }
  definitions(): ToolDefinition[] {
    return structuredClone(
      DEFINITIONS.filter((t) => this.enabled.has(t.function.name)),
    );
  }
  private output(value: JsonObject): JsonObject {
    return {
      ...structuredClone(value),
      untrusted: true,
      group_id: this.groupId,
      queried_at: Date.now() / 1000,
      resources: {
        max_text_bytes: MAX_TEXT,
        max_source_voices: MAX_ROWS,
        max_output_bytes: MAX_OUTPUT,
      },
    };
  }
  private args(name: Name, value: unknown): JsonObject {
    const keys =
      name === "get_group_ai_voices"
        ? ["limit", "offset"]
        : ["character_id", "text"];
    if (
      !record(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(
        (k) => typeof k !== "string" || !keys.includes(k),
      )
    )
      fail("invalid_arguments");
    if (name === "get_group_ai_voices") {
      if (
        !Object.hasOwn(value, "limit") ||
        !Number.isSafeInteger(value.limit) ||
        (value.limit as number) < 1 ||
        (Object.hasOwn(value, "offset") &&
          (!Number.isSafeInteger(value.offset) || (value.offset as number) < 0))
      )
        fail("invalid_arguments");
      return { limit: value.limit, offset: value.offset ?? 0 };
    }
    if (
      !Object.hasOwn(value, "character_id") ||
      !Object.hasOwn(value, "text") ||
      !characterId(value.character_id) ||
      typeof value.text !== "string" ||
      !value.text.trim() ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value.text)
    )
      fail("invalid_arguments");
    if (Buffer.byteLength(value.text, "utf8") > MAX_TEXT)
      fail("resource_limit");
    return { character_id: value.character_id, text: value.text };
  }
  private async read(
    action: string,
    params: JsonObject,
    signal?: AbortSignal,
  ): Promise<unknown> {
    check(signal);
    let result: unknown;
    try {
      result = await this.api.call(action, params);
    } catch {
      check(signal);
      fail("verification_unavailable");
    }
    check(signal);
    return result;
  }
  private async verify(ctx: TurnContext, signal?: AbortSignal): Promise<void> {
    const login = await this.read("get_login_info", {}, signal);
    if (!record(login) || id(login.user_id) !== ctx.selfId)
      fail("identity_mismatch");
    const member = await this.read(
      "get_group_member_info",
      { group_id: this.groupId, user_id: ctx.selfId, no_cache: true },
      signal,
    );
    if (
      !record(member) ||
      id(member.group_id) !== this.groupId ||
      id(member.user_id) !== ctx.selfId ||
      !["member", "admin", "owner"].includes(member.role as string)
    )
      fail("membership_unverified");
  }
  private async voices(signal?: AbortSignal): Promise<Voice[]> {
    const raw = await this.read(
      "get_ai_characters",
      { group_id: this.groupId, chat_type: 1 },
      signal,
    );
    if (!Array.isArray(raw)) fail("invalid_voice_list");
    if (raw.length > MAX_ROWS) fail("resource_limit");
    const voices: Voice[] = [];
    for (const category of raw) {
      if (
        !record(category) ||
        typeof category.type !== "string" ||
        !Array.isArray(category.characters)
      )
        fail("invalid_voice_list");
      if (
        category.type.length > 4096 ||
        category.characters.length > MAX_ROWS - voices.length
      )
        fail("resource_limit");
      for (const voice of category.characters) {
        if (
          !record(voice) ||
          !characterId(voice.character_id) ||
          typeof voice.character_name !== "string" ||
          typeof voice.preview_url !== "string"
        )
          fail("invalid_voice_list");
        if (
          voice.character_name.length > 4096 ||
          voice.preview_url.length > 8192
        )
          fail("resource_limit");
        voices.push({
          type: label(category.type),
          character_id: voice.character_id,
          character_name: label(voice.character_name),
        });
      }
    }
    return voices;
  }
  private page(voices: Voice[], limit: number, offset: number): JsonObject {
    const rows: Voice[] = [];
    const value: JsonObject = {
      status: "ok",
      voices: rows,
      requested: limit,
      returned: 0,
      offset,
      total_available: voices.length,
      next_offset: null,
      has_more: false,
      truncated: false,
      completeness: "native_snapshot_only",
    };
    const result = this.output(value);
    // output() clones its payload, so explicitly retain the array being filled.
    result.voices = rows;
    const update = () => {
      const next = offset + rows.length;
      result.returned = rows.length;
      result.has_more = next < voices.length;
      result.next_offset = next < voices.length ? next : null;
      result.truncated = next < voices.length;
      if (next < voices.length)
        result.reason = rows.length < limit ? "output_limit" : "limit";
      else delete result.reason;
    };
    if (offset < voices.length) {
      const count = Math.min(limit, voices.length - offset);
      for (let i = 0; i < count; i++) {
        rows.push(voices[offset + i]!);
        update();
        if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT) {
          rows.pop();
          update();
          break;
        }
      }
    }
    update();
    return result;
  }
  async execute(
    name: string,
    value: unknown,
    context: TurnContext,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    if (!this.enabled.has(name))
      return this.output({ status: "error", error: "tool_disabled" });
    const ctx = { ...context };
    if (ctx.groupId !== this.groupId)
      return this.output({ status: "error", error: "forbidden_group" });
    if (!id(ctx.selfId) || id(ctx.selfId) !== ctx.selfId)
      return this.output({ status: "error", error: "identity_unverified" });
    try {
      check(signal);
      const args = this.args(name as Name, value);
      await this.verify(ctx, signal);
      if (name === "get_group_ai_voices")
        return this.page(
          await this.voices(signal),
          args.limit as number,
          args.offset as number,
        );
      const key = createHash("sha256")
        .update(JSON.stringify([ctx.selfId, args]))
        .digest("hex");
      const previous = this.operations.get(key);
      if (!previous && this.operations.size >= MAX_OPERATIONS) fail("resource_limit");
      const operation = Promise.resolve(previous).then(async prior => {
        if(prior?.status==='unknown')return {...prior,cached:true,dispatched:false};
        // A queued explicit interaction needs fresh identity/membership proof too.
        if(previous)await this.verify(ctx,signal);
        return this.send(args,signal);
      });
      this.operations.set(key, operation);
      let result:JsonObject;
      try{result=await operation;}catch(error){if(this.operations.get(key)===operation)this.operations.delete(key);throw error;}
      if (result.status !== "unknown" && this.operations.get(key)===operation) this.operations.delete(key);
      return this.output(result);
    } catch (error) {
      return this.output({
        status: "error",
        error: signal?.aborted
          ? "cancelled"
          : error instanceof Failure
            ? error.message
            : "verification_failed",
      });
    }
  }
  private async send(
    args: JsonObject,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    let dispatched = false;
    const unknown = (): JsonObject => ({...writeFailure(undefined,'voice_delivery_unknown'),message_id:null});
    try {
      const voices = await this.voices(signal);
      if (!voices.some((v) => v.character_id === args.character_id))
        fail("voice_unavailable");
      check(signal);
      dispatched = true;
      const response = await this.api.call("send_group_ai_record", {
        group_id: this.groupId,
        character: args.character_id,
        text: args.text,
      });
      if (!record(response) || response.message_id !== 0)
        return afterDispatch(unknown(),!!signal?.aborted);
      // GetAiVoice completed normally, but the handler hard-codes message_id: 0.
      // Preserve submission even after cancellation without inventing a message ACK.
      return afterDispatch(submittedResult({action:'send_group_ai_voice',message_id:null}),!!signal?.aborted);
    } catch (error) {
      if (dispatched) { const result=writeFailure(error,'voice_delivery_unknown'); return afterDispatch({...result,message_id:null},result.dispatched!==false&&!!signal?.aborted); }
      return {
        status: "error",
        error: signal?.aborted
          ? "cancelled"
          : error instanceof Failure
            ? error.message
            : "verification_failed",
      };
    }
  }
}
