import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {
  buildToolDefinitions,
  SANDBOX_EXCLUDED_TOOLS,
} from '../../../src/agent/tool-definitions.ts';
import {
  ALL_TOOL_NAMES,
  CORE_TOOL_NAMES,
} from '../../../src/contracts/tool-names.ts';
import { buildSystemPrompt } from '../../../src/agent/prompts/index.ts';
import {
  presentTools,
  renderDeclarations,
} from '../../../src/agent/tool-declarations/index.ts';
import {
  allToolsConfig,
  declarationDiagnostics,
  declarationNameMismatch,
} from '../../support/declaration-check.ts';
import { toolPermissions } from '../../support/tool-permissions.ts';

test('every tool that can be offered has exactly one declaration', () => {
  assert.deepEqual(declarationNameMismatch(allToolsConfig()), {
    missing: [],
    extra: [],
  });
});

test('rendered declarations compile as TypeScript in every catalog variant', () => {
  for (const overrides of [
    {},
    { observeReactions: false, messageMentions: false },
  ]) {
    assert.deepEqual(declarationDiagnostics(allToolsConfig(overrides)), []);
  }
});

test('all declared tools use an empty object binding with fields carried by the type', () => {
  for (const toolSchema of ['ts', 'both'] as const) {
    const config = allToolsConfig({ toolSchema });
    const tools = buildToolDefinitions(config);
    const prompt = buildSystemPrompt(config, tools);
    const code = /```ts\n([\s\S]*?)\n```/.exec(prompt)![1]!;
    const source = ts.createSourceFile(
      'decl.d.ts',
      code,
      ts.ScriptTarget.Latest,
    );
    const names: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node)) {
        names.push(node.name!.text);
        assert.equal(node.parameters.length, 1);
        const parameter = node.parameters[0]!;
        assert.ok(ts.isObjectBindingPattern(parameter.name), node.name!.text);
        assert.equal(parameter.dotDotDotToken, undefined);
        assert.equal(parameter.questionToken, undefined);
        assert.equal(parameter.initializer, undefined);
        assert.equal(parameter.name.elements.length, 0, node.name!.text);
        assert.ok(parameter.type, node.name!.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.deepEqual(
      names,
      tools.map((tool) => tool.function.name),
    );
    assert.match(
      prompt,
      /下方 tools 命名空间描述每个工具的参数对象和返回值，完整参数字段及必选性由冒号后的类型给出。调用read_events时直接传\{"limit":20\}；没有参数字段的工具传\{\}。/,
    );
    assert.doesNotMatch(prompt, /\barguments\b/);
    assert.match(prompt, /await tools\.read_events\(\{ limit: 20 \}\)/);
    assert.doesNotMatch(
      prompt,
      /唯一的形参|"_"\s*:|"params"\s*:|tools\.<name>\(_\)/,
    );
  }
});

test('destructuring preserves full argument types including union-specific fields', () => {
  assert.deepEqual(
    declarationDiagnostics(
      allToolsConfig(),
      `
    tools.finish({ mode: 'soft' });
    tools.read_events({ limit: 20, cursor: 'page' });
    tools.read_events({ limit: 20, direction: 'forward', after_event_id: 'event' });
    tools.manage_attention({ operation: 'create', any_of: [{ type: 'member_message', user_ids: ['100000003'] }], expires_in_seconds: 60 });
    tools.manage_attention({ operation: 'cancel', plan_id: 'att_example' });
    tools.execute_javascript({ description: 'compute', code: 'return "42";', mode: 'sync', wait_ms: 1000 });
    tools.execute_javascript({ description: 'compute', code: 'return "42";', mode: 'async' });
    tools.get_time({});
    tools.send_group_image({ image_id: 'image' });
    tools.send_group_image({ artifact_id: 'artifact' });
    const image: { image_id: string } | { artifact_id: string } = Math.random() ? { image_id: 'image' } : { artifact_id: 'artifact' };
    tools.send_group_image(image);
    // @ts-expect-error native arguments have no wrapper
    tools.finish({ _: { mode: 'soft' } });
    // @ts-expect-error empty binding still requires mode
    tools.finish({});
    // @ts-expect-error empty binding still requires image_ids
    tools.view_images({});
    // @ts-expect-error operation is required
    tools.manage_attention({ any_of: [], expires_in_seconds: 60 });
    // @ts-expect-error sync requires wait_ms even though it is not destructured
    tools.execute_javascript({ description: 'compute', code: 'return "42";', mode: 'sync' });
    // @ts-expect-error async forbids wait_ms
    tools.execute_javascript({ description: 'compute', code: 'return "42";', mode: 'async', wait_ms: 1000 });
    // @ts-expect-error empty destructuring does not remove the argument
    tools.get_time();
    // @ts-expect-error a disjoint union is not an empty parameter object
    tools.send_group_image({});
  `,
    ),
    [],
  );
});

test('declarations follow the enabled tools and per-group schema rewrites', () => {
  const config = allToolsConfig({
    toolSchema: 'ts',
    messageMentions: false,
    toolPermissions: toolPermissions({
      send_message: 'direct',
      mute_member: { mode: 'confirm', maxSeconds: 45 },
    } as never),
  });
  const tools = buildToolDefinitions(config);
  const text = renderDeclarations(config, tools);
  const declared = [...text.matchAll(/^ {2}function ([a-z_]+)\(/gm)].map(
    (m) => m[1],
  );
  assert.deepEqual(
    declared,
    tools.map((t) => t.function.name),
  );
  assert.match(text, /1 到 45/);
  assert.doesNotMatch(text, /web_fetch\(/);
  assert.doesNotMatch(
    /function send_message[\s\S]*?\): /.exec(text)![0],
    /'at'/,
  );
  // 附录只在对应工具启用时出现。
  assert.match(text, /原生表情（FaceId/);
  assert.doesNotMatch(text, /表情回应（react_message/);
  const prompt = buildSystemPrompt(config, tools);
  assert.ok(prompt.includes(text));
  assert.match(
    prompt,
    /本轮配置限制：\{"tools":\{[^}]*"mute_member":"confirm"/,
  );
});

test('presentation modes change only what the model sees', () => {
  const config = allToolsConfig();
  const tools = buildToolDefinitions(config);
  const snapshot = structuredClone(tools);
  assert.deepEqual(presentTools(tools, 'json'), tools);
  const ts = presentTools(tools, 'ts');
  const both = presentTools(tools, 'both');
  for (const [index, tool] of tools.entries()) {
    assert.equal(ts[index]!.function.name, tool.function.name);
    assert.deepEqual(ts[index]!.function.parameters, {
      type: 'object',
      additionalProperties: true,
    });
    assert.equal(
      both[index]!.function.description,
      ts[index]!.function.description,
    );
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
          // properties下的键是参数名，参数本身可以叫description。
          if (key !== 'properties') {
            assert.notEqual(typeof item === 'string' && key, 'description');
          }
          walk(item);
        }
      }
    };
    walk(both[index]!.function.parameters);
    assert.deepEqual(
      Object.keys(
        (both[index]!.function.parameters.properties ?? {}) as object,
      ),
      Object.keys((tool.function.parameters.properties ?? {}) as object),
    );
  }
  assert.deepEqual(
    both.find((t) => t.function.name === 'mute_member')!.function.parameters
      .required,
    ['user_id', 'seconds'],
  );
  assert.deepEqual(tools, snapshot);
});

test('all model presentation modes use top-level reply_to without reply segments', () => {
  for (const toolSchema of ['json', 'ts', 'both'] as const) {
    const config = allToolsConfig({ toolSchema });
    const tools = buildToolDefinitions(config);
    const prompt = buildSystemPrompt(config, tools);
    const visible = `${prompt}\n${JSON.stringify(presentTools(tools, toolSchema))}`;
    assert.match(visible, /reply_to/);
    assert.doesNotMatch(
      visible,
      /replyTo|reply\.message_id|type\s*:\s*['"]reply['"]|不带 reply 引用/,
    );
    if (toolSchema !== 'json') {
      assert.match(prompt, /interface Message \{[^}]*reply_to\?: MessageId;/);
    }
  }
});

test('finish modes and automatic delivery contract agree across all model presentations', () => {
  for (const toolSchema of ['json', 'ts', 'both'] as const) {
    const config = allToolsConfig({ toolSchema });
    const tools = buildToolDefinitions(config);
    const prompt = buildSystemPrompt(config, tools);
    const finish = tools.find((t) => t.function.name === 'finish')!;
    assert.deepEqual(finish.function.parameters.required, ['mode']);
    assert.match(JSON.stringify(finish.function.parameters), /soft/);
    assert.match(JSON.stringify(finish.function.parameters), /hard/);
    assert.match(prompt, /自动投递/);
    assert.match(prompt, /截点/);
    assert.match(prompt, /soft/);
    assert.match(prompt, /hard/);
    assert.match(prompt, /before_event_id/);
    assert.doesNotMatch(
      prompt,
      /read_messages|ack_events|ack_cursor|observed_through|唤醒输入只有/,
    );
    for (const name of ['read_messages', 'ack_events']) {
      assert.equal(
        tools.some((t) => t.function.name === name),
        false,
      );
      assert.equal(
        (CORE_TOOL_NAMES as readonly string[]).includes(name),
        false,
      );
      assert.equal(SANDBOX_EXCLUDED_TOOLS.includes(name), false);
      assert.equal(ALL_TOOL_NAMES.has(name), true);
    }
  }
});

test('json mode keeps the capability-section prompt without declarations', () => {
  const config = allToolsConfig({ toolSchema: 'json' });
  const prompt = buildSystemPrompt(config);
  assert.doesNotMatch(prompt, /declare namespace tools/);
  assert.match(prompt, /观察边界：/);
  const declared = buildSystemPrompt({ ...config, toolSchema: 'ts' });
  assert.match(declared, /declare namespace tools \{/);
  assert.doesNotMatch(declared, /观察边界：/);
});
