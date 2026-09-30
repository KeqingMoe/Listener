import { readFileSync } from 'node:fs';
import { parse } from 'smol-toml';
import type { AppConfig } from './app.ts';
import { TOOL_NAMES } from './tool-policy.ts';
import { ConfigError, matchesConfigSource } from './loader.ts';
import { isObject } from '../contracts/json.ts';

type RecordValue = Record<string, unknown>;
type Origin = 'program_default' | 'defaults' | 'group';

const snake = (key: string): string =>
  key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

function lookup(value: unknown, path: string): unknown {
  for (const key of path.split('.')) {
    if (!isObject(value) || !Object.hasOwn(value, key)) {
      return undefined;
    }
    value = value[key];
  }
  return value;
}

/**
 * 仅供运维的诊断输出，并标注每个值来自群配置、defaults还是程序默认值。
 * 不含provider凭据、persona正文或聊天数据；描述的是策略，不代表已核实的群成员身份或正在运行的Listener。
 */
export function inspectGroupConfig(
  app: AppConfig,
  groupId: string,
): RecordValue {
  const source = readFileSync(app.configPath, 'utf8');
  if (!matchesConfigSource(app, source)) {
    throw new ConfigError('配置检查期间文件已变化，请重新检查');
  }
  const policy = app.resolveGroup(groupId);
  const document = parse(source) as RecordValue;
  const defaults = document.defaults;
  const groups = document.groups;
  const group = isObject(groups) ? groups[groupId] : undefined;
  const unions = ['reply.random', ...TOOL_NAMES.map((name) => `tools.${name}`)];
  function origin(path: string): Origin {
    const union = unions.find(
      (node) => path === node || path.startsWith(node + '.'),
    );
    if (union) {
      const local = lookup(group, union),
        inherited = lookup(defaults, union);
      const source =
        local !== undefined
          ? group
          : inherited !== undefined
            ? defaults
            : undefined;
      const label: Origin =
        local !== undefined
          ? 'group'
          : inherited !== undefined
            ? 'defaults'
            : 'program_default';
      if (path === union) {
        return label;
      }
      if (
        path === union + '.mode' &&
        typeof lookup(source, union) === 'string'
      ) {
        return label;
      }
      return lookup(source, path) === undefined ? 'program_default' : label;
    }
    return lookup(group, path) !== undefined
      ? 'group'
      : lookup(defaults, path) !== undefined
        ? 'defaults'
        : 'program_default';
  }
  function publicValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map(publicValue);
    }
    if (!isObject(value)) {
      return value;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        snake(key),
        publicValue(entry),
      ]),
    );
  }
  const tools: RecordValue = {};
  for (const name of TOOL_NAMES) {
    const tool = policy.tools[name];
    tools[name] =
      tool.mode === 'off'
        ? 'off'
        : Object.keys(tool).length === 1
          ? tool.mode
          : publicValue(tool);
  }
  const values: RecordValue = {
    enabled: policy.enabled,
    persona: policy.personaPath,
    reply: publicValue(policy.reply),
    session: publicValue(policy.session),
    execution: publicValue(policy.execution),
    messages: publicValue(policy.messages),
    observation: publicValue(policy.observation),
    confirmation: publicValue(policy.confirmation),
    history: publicValue(policy.history),
    storage: { database: policy.storage.databasePath },
    tools,
  };
  const sources: Record<string, Origin> = {};
  function collect(value: unknown, path: string): void {
    if (path) {
      sources[path] = origin(path);
    }
    if (isObject(value)) {
      for (const [key, entry] of Object.entries(value)) {
        collect(entry, path ? `${path}.${key}` : key);
      }
    }
  }
  collect(values, '');
  return { group_id: groupId, membership: 'not_checked', values, sources };
}
