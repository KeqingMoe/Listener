// 全部工具启用时渲染声明，用TypeScript编译器检查语法与类型名，并核对工具名集合。
import ts from 'typescript';
import { buildToolDefinitions } from '../../src/agent/tool-definitions.ts';
import {
  TOOL_DECLARATIONS,
  renderDeclarations,
} from '../../src/agent/tool-declarations/index.ts';
import { TOOL_NAMES } from '../../src/config/tool-policy.ts';
import { toolPermissions } from './tool-permissions.ts';
import type { ListenerConfig } from '../../src/config/listener.ts';

export function allToolsConfig(
  overrides: Partial<ListenerConfig> = {},
): ListenerConfig {
  return {
    groupId: '100000002',
    ownerId: '100000001',
    enabled: true,
    debounceMs: 0,
    cooldownMs: 0,
    retentionDays: 7,
    observeReactions: true,
    toolPermissions: toolPermissions(
      Object.fromEntries(TOOL_NAMES.map((name) => [name, 'direct'])) as never,
    ),
    ...overrides,
  };
}

export function declarationDiagnostics(
  config: ListenerConfig,
  usage = '',
): string[] {
  const tools = buildToolDefinitions(config);
  const text = renderDeclarations(config, tools);
  const code = /```ts\n([\s\S]*?)\n```/.exec(text)?.[1] ?? '';
  const sources = new Map([
    ['decl.d.ts', code],
    ['usage.ts', usage],
  ]);
  const host = ts.createCompilerHost({});
  const original = host.getSourceFile;
  host.getSourceFile = (name, version) =>
    sources.has(name)
      ? ts.createSourceFile(name, sources.get(name)!, version)
      : original(name, version);
  const program = ts.createProgram(
    [...sources.keys()],
    { noEmit: true, strict: true, lib: ['lib.es2022.d.ts'], types: [] },
    host,
  );
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file && sources.has(d.file.fileName))
    .map((d) => {
      const { line } = d.file!.getLineAndCharacterOfPosition(d.start ?? 0);
      const text = d.file!.text.split('\n')[line]?.trim();
      return `${d.file!.fileName}:${line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')} | ${text}`;
    });
}

export function declarationNameMismatch(config: ListenerConfig): {
  missing: string[];
  extra: string[];
} {
  const names = new Set(
    buildToolDefinitions(config).map((tool) => tool.function.name),
  );
  return {
    missing: [...names].filter((name) => !(name in TOOL_DECLARATIONS)),
    extra: Object.keys(TOOL_DECLARATIONS).filter((name) => !names.has(name)),
  };
}
