import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

// Independently hand-authored sentinels: neither ID/name is supplied by the offline fallbacks.
const version = '4.18.28';
const raw = {
  sysface: [{ QSid: '812', QDes: '/synthetic-path-face', AniStickerType: 1 }],
  emoji: [{ QSid: '🦊', QCid: '129418', QDes: '/synthetic-path-emoji' }],
};
const minimal = { version, faces: [{ id: '812', name: 'synthetic-path-face', animated: true }] };
const reactions = [
  { id: '812', name: 'synthetic-path-face', kind: 'face' },
  { id: '129418', name: 'synthetic-path-emoji', kind: 'emoji', emoji: '🦊' },
];
const license = 'Synthetic test license fixture only. Limited Redistribution License for NapCat — Mlikiowa\n';
const rawBytes = JSON.stringify(raw) + '\n';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'resource paths-'));
  const cwd = mkdtempSync(join(tmpdir(), 'unrelated resource cwd-'));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  for (const name of ['onebot/catalog/schema', 'onebot/catalog/faces', 'onebot/catalog/reactions', 'cli/sync-faces']) {
    // Copy implementation only: no repository data, environment or database is read.
    const source = readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8');
    for (const [tree, extension, contents] of [
      ['src', 'ts', source],
      ['dist', 'js', ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
        fileName: `${name}.ts`,
      }).outputText],
    ]) {
      const path = join(root, tree, `${name}.${extension}`);
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, contents);
    }
  }
  const run = (mode: 'src' | 'dist', script: string) => {
    const loader = mode === 'src' ? ['--import', import.meta.resolve('tsx')] : [];
    return execFileSync(process.execPath, [...loader, '--input-type=module', '-e', script], {
      cwd, encoding: 'utf8', timeout: 15_000,
      env: { PATH: process.env.PATH ?? '', HOME: cwd, NODE_NO_WARNINGS: '1' },
    });
  };
  const url = (mode: 'src' | 'dist', name: string) => pathToFileURL(join(root, mode, `${name}.${mode === 'src' ? 'ts' : 'js'}`)).href;
  const assertNoMisplacedData = () => {
    assert.deepEqual(readdirSync(cwd), [], 'unrelated cwd must remain untouched');
    assert.equal(existsSync(join(root, 'dist/data')), false);
    assert.equal(existsSync(join(root, 'src/data')), false);
  };
  return { root, run, url, assertNoMisplacedData };
}

for (const mode of ['src', 'dist'] as const) {
  test(`${mode}: default face and reaction catalogs resolve repository-root data independently of cwd`, t => {
    const f = fixture(t);
    mkdirSync(join(f.root, 'data'));
    writeFileSync(join(f.root, 'data/qq-faces.json'), JSON.stringify(minimal));
    writeFileSync(join(f.root, `data/napcat-face-config-v${version}.json`), rawBytes);
    const output = f.run(mode, `
      globalThis.fetch = () => { throw new Error('Unexpected network request'); };
      const faces = await import(${JSON.stringify(f.url(mode, 'onebot/catalog/faces'))});
      const reactions = await import(${JSON.stringify(f.url(mode, 'onebot/catalog/reactions'))});
      console.log(JSON.stringify({ path: faces.FACE_CATALOG_PATH.href, faces: faces.FACE_CATALOG,
        loaded: faces.loadFaceCatalog(), reactions: reactions.getReactionCatalog(),
        loadedReactions: reactions.loadReactionCatalog() }));
    `);
    assert.deepEqual(JSON.parse(output), {
      path: pathToFileURL(join(f.root, 'data/qq-faces.json')).href,
      faces: minimal.faces, loaded: minimal.faces, reactions, loadedReactions: reactions,
    });
    f.assertNoMisplacedData();
  });

  test(`${mode}: explicit face sync writes raw, license and minimal catalog only to repository-root data`, t => {
    const f = fixture(t);
    const output = f.run(mode, `
      import assert from 'node:assert/strict';
      const schema = await import(${JSON.stringify(f.url(mode, 'onebot/catalog/schema'))});
      const calls = [];
      globalThis.fetch = async (url, options) => {
        calls.push(url);
        assert.equal(options.redirect, 'error');
        if (url === schema.FACE_CATALOG_SOURCE) return new Response(${JSON.stringify(rawBytes)});
        if (url === schema.FACE_CATALOG_LICENSE) return new Response(${JSON.stringify(license)});
        throw new Error('Unexpected fetch URL: ' + url);
      };
      const cli = await import(${JSON.stringify(f.url(mode, 'cli/sync-faces'))});
      assert.deepEqual(calls, [], 'import must not synchronize implicitly');
      await cli.syncFaces();
      assert.deepEqual(calls, [schema.FACE_CATALOG_SOURCE, schema.FACE_CATALOG_LICENSE]);
      const faces = await import(${JSON.stringify(f.url(mode, 'onebot/catalog/faces'))});
      const reactions = await import(${JSON.stringify(f.url(mode, 'onebot/catalog/reactions'))});
      assert.deepEqual(faces.FACE_CATALOG, ${JSON.stringify(minimal.faces)});
      assert.deepEqual(reactions.getReactionCatalog(), ${JSON.stringify(reactions)});
      console.log('synthetic-sync-ok');
    `);
    assert.match(output, /synthetic-sync-ok\s*$/);
    assert.deepEqual(readdirSync(join(f.root, 'data')).sort(), [
      `NAPCAT-LICENSE-v${version}.txt`, `napcat-face-config-v${version}.json`, 'qq-faces.json',
    ].sort());
    assert.equal(readFileSync(join(f.root, `data/napcat-face-config-v${version}.json`), 'utf8'), rawBytes);
    assert.equal(readFileSync(join(f.root, `data/NAPCAT-LICENSE-v${version}.txt`), 'utf8'), license);
    assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'data/qq-faces.json'), 'utf8')), minimal);
    f.assertNoMisplacedData();
  });
}
