import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyzeBoundaries } from '../scripts/check-boundaries.mjs';

function fixture(t: TestContext, files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'boundaries-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    const path = join(root, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, source);
  }
  return root;
}

test('foundation contracts allow leaf types but reject reverse business, entrypoint, Node and package dependencies', async t => {
  const root = fixture(t, {
    'src/contracts/messages.ts': 'import type { Json } from "./json.js"; import type { State } from "../agent/state.js"; import type { App } from "../app/index.js"; import type { Stats } from "node:fs"; import type { External } from "external-package"; import "node:path";',
    'src/contracts/json.ts': 'export type Json = string;',
    'src/agent/state.ts': '', 'src/app/index.ts': '',
    'src/observability/diagnostics.ts': 'export type Diagnostic = string;',
    'src/dashboard/contracts/dto.ts': 'import type { Diagnostic } from "../../observability/diagnostics.js";',
  });
  const result = await analyzeBoundaries(root);
  assert.equal(result.issues.length, 5);
  assert.equal(result.issues.filter(issue => issue.kind === 'type-boundary').length, 4);
  assert.equal(result.issues.filter(issue => issue.kind === 'runtime-boundary').length, 1);
  assert.ok(result.issues.every(issue => issue.from === 'src/contracts/messages.ts'));
  assert.deepEqual(result.issues.map(issue => issue.to).sort(), ['src/agent/state.ts', 'src/app/index.ts', 'node:fs', 'external-package', 'node:path'].sort());
});

test('classifies runtime forbidden directions without exempting catalog-to-CLI schema debt', async t => {
  const root = fixture(t, {
    'src/app/index.ts': 'import "../tools/use.js";',
    'src/cli/sync.ts': '', 'src/agent/listener.ts': '',
    'src/tools/use.ts': 'import "../agent/listener.js";',
    'src/model/client.ts': 'export { x } from "../tools/use.js"; import("../onebot/catalog.js");',
    'src/onebot/catalog.ts': 'import "../cli/sync.js";',
    'src/world/store.ts': 'import "../app/index.js";',
    'src/dashboard/server/repo.ts': 'import "../../agent/listener.js";',
  });
  const result = await analyzeBoundaries(root);
  assert.equal(result.issues.length, 6);
  assert.ok(result.issues.every(issue => issue.kind === 'runtime-boundary'));
  assert.ok(result.issues.some(issue => issue.from === 'src/onebot/catalog.ts' && issue.to === 'src/cli/sync.ts'));
});

test('type-only imports, exports and import types remain valid and do not form runtime cycles', async t => {
  const root = fixture(t, {
    'src/model/a.ts': 'import type { A } from "../agent/b.js"; export type { A } from "../agent/b.js"; type B = import("../agent/b.js").A;',
    'src/agent/b.ts': 'import { type B } from "../model/a.js"; export { type B } from "../model/a.js";',
    'src/dashboard/server/a.ts': 'import type { A } from "../../agent/b.js"; import "../../agent/session/indexes.js";',
    'src/agent/session/indexes.ts': 'export const schema = 1;',
  });
  const result = await analyzeBoundaries(root);
  assert.deepEqual(result.issues, []);
  assert.equal(result.edges.filter(edge => edge.typeOnly).length, 6);
});

test('runtime graph detects real cycles, mixed imports and dynamic imports', async t => {
  const root = fixture(t, {
    'src/world/a.ts': 'import { type A, value } from "./b.js";',
    'src/world/b.ts': 'export * from "./c";',
    'src/world/c.ts': 'import("./a.js");',
  });
  const result = await analyzeBoundaries(root);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].kind, 'runtime-cycle');
  assert.match(result.issues[0].message, /a.ts -> src\/world\/b.ts -> src\/world\/c.ts -> src\/world\/a.ts/);
});

test('Vue analyzes only script blocks, resolves Vue and index modules, and enforces web/DTO boundaries', async t => {
  const root = fixture(t, {
    'src/dashboard/web/src/App.vue': '<template>import "./missing.js"</template><script setup lang="ts">import "./Child.vue"; import "./helpers"; import "./styles.css"; import type { DTO } from "../../contracts/dto.js"; import "node:fs";</script><script>import type { Server } from "../../server/repo.js";</script>',
    'src/dashboard/web/src/Child.vue': '<template>ok</template>',
    'src/dashboard/web/src/styles.css': 'body { color: black; }',
    'src/dashboard/web/vite.config.ts': 'import "node:path";',
    'src/dashboard/web/src/helpers/index.ts': '',
    'src/dashboard/contracts/dto.ts': 'import "node:path"; export * from "../../world/store.js";',
    'src/dashboard/server/repo.ts': '', 'src/world/store.ts': '',
  });
  const result = await analyzeBoundaries(root);
  assert.equal(result.issues.length, 4);
  assert.equal(result.issues.filter(issue => issue.kind === 'type-boundary').length, 1);
  assert.equal(result.issues.filter(issue => issue.kind === 'runtime-boundary').length, 3);
  assert.ok(!result.issues.some(issue => issue.kind === 'unresolved'));
});

test('unresolved relative imports are errors including type-only imports; directory symlinks are ignored', async t => {
  const root = fixture(t, { 'src/a.ts': 'import "./missing.js"; type T = import("./missing-type").T;' });
  symlinkSync(join(root, 'src'), join(root, 'src/loop'), 'dir');
  const result = await analyzeBoundaries(root);
  assert.equal(result.files, 1);
  assert.deepEqual(result.issues.map(issue => issue.kind), ['unresolved', 'unresolved']);
  assert.match(result.issues[1].message, /^type /);
});

test('TS and Vue generic arrows and assertions do not hide later dependencies; TSX still parses JSX', async t => {
  const root = fixture(t, {
    'src/agent/listener.ts': '',
    'src/model/client.ts': 'const identity = <T>(value: T) => value; const value = <number>1; import "../agent/listener.js"; import("../agent/listener.js");',
    'src/dashboard/server/repo.ts': '',
    'src/dashboard/web/src/App.vue': '<script setup lang="ts">const identity = <T>(value: T) => value; const value = <number>1; import "../../server/repo.js"; import("../../server/repo.js");</script>',
    'src/dashboard/web/src/Other.tsx': 'const element = <div/>; import("../../server/repo.js");',
  });
  const result = await analyzeBoundaries(root);
  assert.equal(result.issues.length, 5);
  assert.ok(result.issues.every(issue => issue.kind === 'runtime-boundary'));
  assert.equal(result.issues.filter(issue => issue.from.endsWith('client.ts')).length, 2);
  assert.equal(result.issues.filter(issue => issue.from.endsWith('App.vue')).length, 2);
});

test('nonliteral dynamic imports are reported rather than silently considered safe', async t => {
  const root = fixture(t, { 'src/world/a.ts': 'const name = "./target.js"; import(name); import(`./${name}.js`);', 'src/world/target.ts': '' });
  const result = await analyzeBoundaries(root);
  assert.deepEqual(result.issues.map(issue => issue.kind), ['unresolved-dynamic', 'unresolved-dynamic']);
  assert.equal(result.edges.length, 0);
});

test('API permits empty reports but CLI fails closed on an empty or missing source root', async t => {
  const root = fixture(t, {});
  assert.deepEqual(await analyzeBoundaries(root), { files: 0, edges: [], issues: [] });
  const script = fileURLToPath(new URL('../scripts/check-boundaries.mjs', import.meta.url));
  for (const path of [root, join(root, 'absent')]) {
    const result = spawnSync(process.execPath, [script, path], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No production source files discovered/);
  }
});

test('CLI exits nonzero on violations and zero on a valid fixture', t => {
  const script = fileURLToPath(new URL('../scripts/check-boundaries.mjs', import.meta.url));
  for (const [source, expected] of [['export const value = 1;', 0], ['import "./absent.js";', 1]] as const) {
    const root = fixture(t, { 'src/a.ts': source });
    const result = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
    assert.equal(result.status, expected, result.stderr);
    assert.match(result.stdout, /Boundaries: 1 files, [01] violations/);
  }
});
