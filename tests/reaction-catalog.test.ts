import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { extractReactionCatalog, loadReactionCatalog, getReactionCatalog, isKnownReactionId, createReactionTool } from '../src/onebot/catalog/reactions.js';
import { FACE_DATA_LIMIT } from '../src/cli/sync-faces.js';
import { fullReactionCatalogFixture } from './fixtures/reaction-catalog.js';

const source = () => ({ sysface: [{ QSid: '0', QDes: '/惊讶', extra: { private: 'omit' } }, { QSid: '375', QDes: '/超级鼓掌', AniStickerType: 1 }],
  emoji: [{ QSid: '😊', QCid: '128522', QDes: '/嘿嘿', EMCode: 'not-the-id' }] });
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'reaction-catalog-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, 'catalog.json') };
}

test('projects both full sections without leaking upstream metadata and freezes data', () => {
  const raw = source(); const data = extractReactionCatalog(raw);
  assert.deepEqual(data, [{ id: '0', name: '惊讶', kind: 'face' }, { id: '375', name: '超级鼓掌', kind: 'face' }, { id: '128522', name: '嘿嘿', kind: 'emoji', emoji: '😊' }]);
  assert.ok(Object.isFrozen(data)); for (const item of data) assert.ok(Object.isFrozen(item));
  raw.sysface[0]!.QDes = '/changed'; assert.equal(data[0]!.name, '惊讶');
  assert.doesNotMatch(JSON.stringify(data), /private|EMCode|AniSticker/);
});

test('complete synthetic 329-face plus 165-emoji catalog yields all 494 candidates', () => {
  const raw = fullReactionCatalogFixture();
  const result = extractReactionCatalog(raw);
  assert.equal(result.length, 494); assert.equal(new Set(result.map(r => r.id)).size, 494);
  assert.equal(result.filter(r => r.kind === 'emoji').length, 165);
});

test('loads all 494 entries from a complete synthetic raw resource offline', t => {
  const { path } = fixture(t);
  const raw = fullReactionCatalogFixture();
  writeFileSync(path, JSON.stringify(raw));
  const data = loadReactionCatalog(path);
  assert.deepEqual(data, extractReactionCatalog(raw));
  assert.equal(data.length, 494); assert.equal(data.filter(r => r.kind === 'face').length, 329);
  assert.equal(data.filter(r => r.kind === 'emoji').length, 165);
});

test('rejects malformed sections and face identities through existing face validation', () => {
  for (const raw of [null, {}, { sysface: [], emoji: [] }, { ...source(), emoji: null }, { ...source(), sysface: [{ QSid: '1000', QDes: '/wrong-type' }] },
    { ...source(), sysface: [{ QSid: '0', QDes: '/valid' }, { QSid: 'not-a-face-id', QDes: '/bad' }] },
    { ...source(), sysface: [{ QSid: '00', QDes: '/bad' }] }, { ...source(), sysface: [{ QSid: '-1', QDes: '/bad' }] },
    { ...source(), sysface: [{ QSid: '1', QDes: '/x' }, { QSid: '1', QDes: '/y' }] },
    { ...source(), sysface: [{ QSid: '1', QDes: '/\ud800' }] }, { ...source(), sysface: new Array(1) }]) {
    assert.throws(() => extractReactionCatalog(raw), /Invalid QQ reaction catalog/);
  }
});

test('strict Unicode IDs exclude aliases, wrong type length, unsafe scalars and surrogates', () => {
  for (const id of ['0128522', '128522 ', '128522\n', '128522\r', '128522\r\n', '128522\u2028', '128522\u2029', '1e5', '-128522', '0', '999', '55296', '57343', '1114112', '9007199254740991', 128522, null]) {
    assert.throws(() => extractReactionCatalog({ ...source(), emoji: [{ QCid: id, QSid: '😊', QDes: '/x' }] }));
  }
  for (const code of [1000, 55295, 57344, 1114111]) {
    const result = extractReactionCatalog({ ...source(), emoji: [{ QCid: String(code), QSid: String.fromCodePoint(code), QDes: '/scalar' }] });
    assert.equal(result.at(-1)!.id, String(code));
  }
});

test('rejects duplicate Unicode IDs, corrupt names, mismatched or malformed glyphs', () => {
  const base = source().emoji[0]!;
  assert.throws(() => extractReactionCatalog({ ...source(), emoji: [base, base] }));
  for (const QDes of ['', '/', '/   ', '/x\n', '/x\u007f', '/x\u009f', '/' + 'x'.repeat(65), '/\udfff', 12]) {
    assert.throws(() => extractReactionCatalog({ ...source(), emoji: [{ ...base, QDes }] }));
  }
  for (const QSid of ['', ' ', '😄', '😊\n', '😊\ud800', '😊'.repeat(17), 1]) {
    assert.throws(() => extractReactionCatalog({ ...source(), emoji: [{ ...base, QSid }] }));
  }
  const combined = extractReactionCatalog({ ...source(), emoji: [{ QCid: '10084', QSid: '❤️', QDes: '/heart' }] });
  assert.equal(combined.at(-1)!.emoji, '❤️');
});

test('rejects executable/accessor or sparse catalog input without running getters', () => {
  let reads = 0;
  const entry = { ...source().emoji[0], get secret() { reads++; return 'private'; } };
  assert.throws(() => extractReactionCatalog({ ...source(), emoji: [entry] }));
  const root = { ...source(), get extra() { reads++; return {}; } };
  assert.throws(() => extractReactionCatalog(root));
  assert.throws(() => extractReactionCatalog({ ...source(), emoji: new Array(1) }));
  assert.throws(() => extractReactionCatalog({ ...source(), emoji: Array(1025).fill(source().emoji[0]) }));
  assert.equal(reads, 0);
});

test('loads strict UTF8 regular files with string or URL paths', t => {
  const f = fixture(t); writeFileSync(f.path, JSON.stringify(source()));
  assert.deepEqual(loadReactionCatalog(f.path), extractReactionCatalog(source()));
  assert.deepEqual(loadReactionCatalog(pathToFileURL(f.path)), extractReactionCatalog(source()));
});

test('only missing files use hand-authored fallback, malformed existing files fail', t => {
  const f = fixture(t); const data = loadReactionCatalog(f.path);
  assert.ok(data.some(e => e.id === '76' && e.kind === 'face'));
  assert.ok(data.some(e => e.id === '128077' && e.emoji === '👍'));
  assert.ok(data.length < 20);
  for (const content of ['', '{', '{}', JSON.stringify({ sysface: [] }), Buffer.from([0xff, 0xfe, 0x7b, 0x7d])]) {
    writeFileSync(f.path, content);
    assert.throws(() => loadReactionCatalog(f.path), /Invalid QQ reaction catalog/);
  }
});

test('enforces size cap including valid JSON padding and refuses symlinks/directories/FIFOs', t => {
  const f = fixture(t); const json = JSON.stringify(source());
  writeFileSync(f.path, json + ' '.repeat(FACE_DATA_LIMIT - Buffer.byteLength(json)));
  assert.equal(loadReactionCatalog(f.path).length, 3);
  writeFileSync(f.path, json + ' '.repeat(FACE_DATA_LIMIT + 1));
  assert.throws(() => loadReactionCatalog(f.path));
  const dir = join(f.dir, 'directory'); mkdirSync(dir); assert.throws(() => loadReactionCatalog(dir));
  if (process.platform !== 'win32') {
    const target = join(f.dir, 'target'); writeFileSync(target, json);
    const link = join(f.dir, 'link'); symlinkSync(target, link); assert.throws(() => loadReactionCatalog(link));
    const dangling = join(f.dir, 'dangling'); symlinkSync(join(f.dir, 'absent'), dangling); assert.throws(() => loadReactionCatalog(dangling));
    const fifo = join(f.dir, 'fifo'); execFileSync('mkfifo', [fifo]); assert.throws(() => loadReactionCatalog(fifo));
  }
});

test('module import does not open catalog, lazy initialization caches once', () => {
  const url = new URL('../src/onebot/catalog/reactions.ts', import.meta.url).href;
  const script = `import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';let reads=0;const original=fs.openSync;fs.openSync=function(path,...rest){if(String(path).includes('napcat-face-config-v')){reads++;throw Object.assign(new Error('missing'),{code:'ENOENT'});}return original.call(this,path,...rest);};syncBuiltinESMExports();const m=await import(${JSON.stringify(url)});if(reads!==0)throw Error('eager read');const first=m.getReactionCatalog();if(reads!==1||first!==m.getReactionCatalog())throw Error('not cached');m.createReactionTool();if(reads!==1)throw Error('reloaded');console.log('lazy-ok');`;
  assert.equal(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { encoding: 'utf8' }).trim(), 'lazy-ok');
});

test('tool has exact argument schema and full labeled candidate enum without eager singleton definitions', () => {
  const catalog = getReactionCatalog(), tool = createReactionTool();
  assert.equal(tool.function.name, 'react_message');
  const schema: any = tool.function.parameters;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['message_id', 'emoji_id', 'action']);
  assert.deepEqual(Object.keys(schema.properties), ['message_id', 'emoji_id', 'action']);
  assert.deepEqual(schema.properties.emoji_id.enum, catalog.map(e => e.id));
  assert.deepEqual(schema.properties.action.enum, ['add', 'remove']);
  assert.match(schema.properties.emoji_id.description, /\[QQ\]/); assert.match(schema.properties.emoji_id.description, /\[Unicode\]/);
  assert.match(tool.function.description, /候选/); assert.match(tool.function.description, /不自动结束/);
  assert.match(tool.function.description, /最后调用finish结束/);
  assert.ok(isKnownReactionId('0')); assert.ok(isKnownReactionId('76')); assert.ok(isKnownReactionId('128077'));
  for (const value of [0, '00', '76\n', '👍', '-1', '9999999', null]) assert.equal(isKnownReactionId(value), false);
  schema.properties.emoji_id.enum.length = 0;
  assert.equal(createReactionTool().function.parameters.additionalProperties, false);
  assert.equal((createReactionTool().function.parameters.properties as any).emoji_id.enum.length, catalog.length);
});
