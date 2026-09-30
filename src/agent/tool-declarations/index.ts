import type { ToolDefinition } from '../../contracts/tools.ts';
import type { JsonObject } from '../../contracts/json.ts';
import type { ToolSchemaMode } from '../../config/app.ts';
import type { ListenerConfig } from '../../config/listener.ts';
import { applyToolPolicies, observesReactions } from '../../config/runtime.ts';
import { FACE_CATALOG } from '../../onebot/catalog/faces.ts';
import { getReactionCatalog } from '../../onebot/catalog/reactions.ts';
import { commonTypes } from './common.ts';
import type { DeclarationTable, ToolDeclaration } from './types.ts';
import { CORE_DECLARATIONS } from './core.ts';
import { INTERACTION_DECLARATIONS } from './interaction.ts';
import { MANAGEMENT_DECLARATIONS } from './management.ts';
import { GROUP_DECLARATIONS } from './group.ts';
import { MEDIA_DECLARATIONS } from './media.ts';
import { EXTENDED_DECLARATIONS } from './extended.ts';

/** 全部工具的声明；每个可能下发的工具都必须在这里有且只有一条。 */
export const TOOL_DECLARATIONS: DeclarationTable = Object.freeze({
  ...CORE_DECLARATIONS,
  ...INTERACTION_DECLARATIONS,
  ...MANAGEMENT_DECLARATIONS,
  ...GROUP_DECLARATIONS,
  ...MEDIA_DECLARATIONS,
  ...EXTENDED_DECLARATIONS,
});

export function toolSchemaMode(config: ListenerConfig): ToolSchemaMode {
  return config.toolSchema ?? 'json';
}

function declaration(name: string): ToolDeclaration {
  const found = TOOL_DECLARATIONS[name];
  if (!found) {
    throw new Error(`missing_tool_declaration:${name}`);
  }
  return found;
}

/**
 * 递归去掉schema的description说明，保留type/required/enum/oneOf等结构。
 * properties的键是参数名，名为description的参数必须保留。
 */
function stripDescriptions(value: unknown, names = false): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripDescriptions(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => names || key !== 'description')
        .map(([key, item]) => [
          key,
          stripDescriptions(item, !names && key === 'properties'),
        ]),
    );
  }
  return value;
}

/**
 * 发给模型的工具列表。完整定义仍由程序用于校验与确认，这里只改变模型看到的形态：
 * ts只给名字、概要和开放的参数对象（必须显式写additionalProperties，
 * 否则部分服务会当作无参函数）；both给无描述的完整参数结构；json原样。
 */
export function presentTools(
  tools: readonly ToolDefinition[],
  mode: ToolSchemaMode,
): ToolDefinition[] {
  if (mode === 'json') {
    return structuredClone(tools as ToolDefinition[]);
  }
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.function.name,
      description: declaration(tool.function.name).summary,
      parameters:
        mode === 'ts'
          ? { type: 'object', additionalProperties: true }
          : (stripDescriptions(tool.function.parameters) as JsonObject),
    },
  }));
}

function faceAppendix(): string {
  return FACE_CATALOG.map(
    (face) => `${face.id}:${face.name}${face.animated ? '★' : ''}`,
  ).join(' ');
}

function reactionAppendix(): string {
  return getReactionCatalog()
    .map((entry) =>
      entry.kind === 'face'
        ? `${entry.id}:${entry.name}`
        : `${entry.id}:${entry.emoji} ${entry.name}`,
    )
    .join(' ');
}

/** 本轮工具的TypeScript声明与所需目录，按已启用的工具生成。 */
export function renderDeclarations(
  input: ListenerConfig,
  tools: readonly ToolDefinition[],
): string {
  const config = applyToolPolicies(input);
  const names = tools.map((tool) => tool.function.name);
  const types = new Map<string, string>();
  const functions: string[] = [];
  for (const tool of tools) {
    const item = declaration(tool.function.name);
    for (const [name, text] of Object.entries(item.types ?? {})) {
      const previous = types.get(name);
      if (previous !== undefined && previous !== text) {
        throw new Error(`conflicting_tool_type:${name}`);
      }
      types.set(name, text);
    }
    const ts =
      typeof item.ts === 'function'
        ? item.ts({ definition: tool, config })
        : item.ts;
    functions.push(ts.replace(/^/gm, '  '));
  }
  const appendix = [
    names.some((name) => name === 'send_message')
      ? `原生表情（FaceId，★为超级表情）：${faceAppendix()}`
      : '',
    names.includes('react_message')
      ? `表情回应（react_message 的 emoji_id；前段为QQ表情，带字符的是Unicode emoji，两套编号）：${reactionAppendix()}`
      : '',
  ].filter(Boolean);
  return [
    '```ts',
    commonTypes({ reactions: observesReactions(config) }),
    '',
    [...types.values()].join('\n\n'),
    '',
    'declare namespace tools {',
    functions.join('\n\n'),
    '}',
    '```',
    ...(appendix.length ? ['', ...appendix] : []),
  ]
    .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
    .join('\n');
}
