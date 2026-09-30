import type { JsonObject } from '../contracts/json.ts';
import type { ToolDefinition, TurnContext } from '../contracts/tools.ts';

export interface RegisteredTool {
  definition: ToolDefinition;
  sideEffect: boolean;
  execute(
    args: unknown,
    context: TurnContext,
    signal?: AbortSignal,
  ): Promise<JsonObject>;
}

/** 每次wake使用的分发注册表。未知或未启用的工具名不会回退为RPC调用。 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  register(tool: RegisteredTool): void {
    const name = tool.definition.function.name;
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || this.tools.has(name)) {
      throw new Error('Invalid or duplicate tool registration');
    }
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
    if (!tool) {
      return { status: 'error', error: 'tool_disabled' };
    }
    if (signal?.aborted) {
      return { status: 'error', error: 'cancelled' };
    }
    // 派发后的取消由handler自行处理：迟到的有效写ACK不能丢。
    try {
      return await tool.execute(args, context, signal);
    } catch {
      return tool.sideEffect
        ? { status: 'unknown', error: 'tool_result_unknown' }
        : { status: 'error', error: 'tool_failed' };
    }
  }
}
