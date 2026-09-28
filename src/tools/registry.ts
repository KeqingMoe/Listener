import type { JsonObject } from "../contracts/json.js";
import type { ToolDefinition, TurnContext } from "../contracts/tools.js";

export interface RegisteredTool {
  definition: ToolDefinition;
  sideEffect: boolean;
  execute(
    args: unknown,
    context: TurnContext,
    signal?: AbortSignal,
  ): Promise<JsonObject>;
}
/** Per-wake dispatch registry. No fallback from unknown or disabled names to RPCs. */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  register(tool: RegisteredTool): void {
    const name = tool.definition.function.name;
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || this.tools.has(name))
      throw new Error("Invalid or duplicate tool registration");
    this.tools.set(name, {
      ...tool,
      definition: structuredClone(tool.definition),
    });
  }
  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) =>
      structuredClone(tool.definition),
    );
  }
  has(name: string): boolean {
    return this.tools.has(name);
  }
  isSideEffect(name: string): boolean {
    return this.tools.get(name)?.sideEffect ?? false;
  }
  async execute(
    name: string,
    args: unknown,
    context: TurnContext,
    signal?: AbortSignal,
  ): Promise<JsonObject> {
    const tool = this.tools.get(name);
    if (!tool) return { status: "error", error: "tool_disabled" };
    if (signal?.aborted) return { status: "error", error: "cancelled" };
    // Handlers own post-dispatch cancellation: a late valid write ACK must not be lost.
    try {
      return await tool.execute(args, context, signal);
    } catch {
      return tool.sideEffect
        ? { status: "unknown", error: "tool_result_unknown" }
        : { status: "error", error: "tool_failed" };
    }
  }
}
