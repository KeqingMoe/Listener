import type { ToolDefinition } from '../../contracts/tools.ts';
import type { ProjectedListenerConfig } from '../../config/listener.ts';

/** 生成声明时可用的本群信息：已按本群改写的工具定义与投影后的配置。 */
export interface DeclarationContext {
  definition: ToolDefinition;
  config: ProjectedListenerConfig;
}

/**
 * 一个工具的TypeScript声明。ts与both模式把它放进系统提示词，
 * summary同时作为发给模型的tools[].description。
 */
export interface ToolDeclaration {
  /** 一句话概要。 */
  summary: string;
  /** 以`/** … *\/`开头、`function 名字(_: …): 返回类型;`结尾的声明。 */
  ts: string | ((context: DeclarationContext) => string);
  /** 该工具专用的类型别名，按名字去重，只在工具启用时输出。 */
  types?: Readonly<Record<string, string>>;
}

export type DeclarationTable = Readonly<Record<string, ToolDeclaration>>;
