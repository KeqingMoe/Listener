import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { FACE_CATALOG, FACE_CATALOG_VERSION, FACE_CATALOG_SOURCE, EXAMPLE_FACE_CATALOG, loadFaceCatalog, validateFaceCatalog } from '../../../../src/onebot/catalog/faces.js';
import { extractFaceCatalog, FACE_DATA_LIMIT } from '../../../../src/onebot/catalog/schema.js';
import { faceMarker, isKnownFaceId, FACE_ID_SCHEMA } from '../../../../src/tools/faces/tools.js';

const face = (id = '14', name = '微笑', animated = false) => ({ id, name, animated });
const data = (faces: unknown = [face()]) => ({ version: FACE_CATALOG_VERSION, faces });
function directory(t: TestContext): string {
  const path = mkdtempSync(join(tmpdir(), 'listener-faces-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

test('catalog provenance, unique numeric IDs, public examples and animation flags', () => {
  assert.equal(FACE_CATALOG_VERSION, '4.18.28');
  assert.match(FACE_CATALOG_SOURCE, /\/v4\.18\.28\/packages\/napcat-core\/external\/face_config\.json$/);
  assert.ok(FACE_CATALOG.length >= EXAMPLE_FACE_CATALOG.length && FACE_CATALOG.length <= 1024);
  assert.equal(new Set(FACE_CATALOG.map(f => f.id)).size, FACE_CATALOG.length);
  for (const entry of FACE_CATALOG) {
    assert.match(entry.id, /^(0|[1-9]\d{0,5})$/);
    assert.equal(typeof entry.animated, 'boolean');
    assert.ok(entry.name.length > 0 && entry.name.length <= 64);
    assert.equal(entry.name.startsWith('/'), false);
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(entry.name));
    assert.deepEqual(Object.keys(entry).sort(), ['animated', 'id', 'name']);
  }
  for (const [id, name] of [['0', '惊讶'], ['14', '微笑'], ['20', '偷笑'], ['375', '超级鼓掌']]) assert.equal(FACE_CATALOG.find(f => f.id === id)?.name, name);
  assert.equal(FACE_CATALOG.find(f => f.id === '375')?.animated, true);
  assert.equal(FACE_CATALOG.find(f => f.id === '14')?.animated, false);
});

test('catalog and entries are immutable, including the offline fallback', () => {
  for (const catalog of [FACE_CATALOG, EXAMPLE_FACE_CATALOG]) {
    assert.ok(Object.isFrozen(catalog));
    assert.ok(catalog.every(Object.isFrozen));
    assert.throws(() => (catalog as any).push(face('999999')));
    assert.throws(() => { (catalog[0] as any).name = 'forged'; });
  }
});

test('every loaded ordinary or super face ID is sendable without quotas or extra fields', () => {
  assert.equal(FACE_ID_SCHEMA.type, 'string');
  assert.deepEqual(FACE_ID_SCHEMA.enum, FACE_CATALOG.map(f => f.id));
  const description = FACE_ID_SCHEMA.description as string;
  for (const entry of FACE_CATALOG) {
    assert.equal(isKnownFaceId(entry.id), true);
    assert.ok(description.includes(`${entry.id}:${entry.name}${entry.animated ? '★' : ''}`));
    assert.equal(faceMarker(entry.id), `[QQ表情：${entry.name} id=${entry.id}]`);
  }
  assert.equal(description.includes('resultId'), false);
  assert.equal(description.includes('chainCount'), false);
  assert.equal(FACE_ID_SCHEMA.maxItems, undefined);
  assert.ok(Object.isFrozen(FACE_ID_SCHEMA));
  assert.ok(Object.isFrozen(FACE_ID_SCHEMA.enum));
});

test('incoming numbers normalize, while outgoing arguments require canonical strings', () => {
  for (const value of [0, -0, 14, 20, 375]) {
    assert.equal(faceMarker(value), faceMarker(String(value)));
    assert.equal(isKnownFaceId(value), false);
  }
  assert.equal(isKnownFaceId('0'), true);
  assert.equal(isKnownFaceId('375'), true);
  assert.equal(faceMarker('999999'), '[QQ表情：名称未知 id=999999]');
  assert.equal(faceMarker(999999), '[QQ表情：名称未知 id=999999]');
  assert.equal(isKnownFaceId('999999'), false);
});

test('malformed IDs never get coerced or echoed as model context', () => {
  let coerced = false;
  const hostile = { toString() { coerced = true; throw new Error('SECRET'); } };
  for (const value of [undefined, null, true, false, {}, [], hostile, new String('14'), new Number(14), -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1000000,
    '', ' ', '14 ', ' 14', '14\n', '14\r', '00', '014', '+14', '-0', '1e2', '14.0', '0x14', '１４', '1000000', '14]SECRET', 'https://secret.invalid', '<script>', Symbol('SECRET'), 14n]) {
    assert.equal(faceMarker(value), '[QQ表情：未知]');
    assert.equal(isKnownFaceId(value), false);
  }
  assert.equal(coerced, false);
});

test('minimal catalog parser strictly validates roots, IDs, names, booleans and duplicates', () => {
  const bad = [null, [], {}, { version: 'other', faces: [face()] }, { ...data(), source: 'SECRET' }, data([]), data(Array.from({ length: 1025 }, (_, i) => face(String(i)))),
    data([face(), face()]), data([null]), data([[]]), data([{ ...face(), raw: 'SECRET' }]),
    ...[14, '', '01', '-1', '14\n', '1000000'].map(id => data([{ ...face(), id }])),
    ...['', '   ', 'x'.repeat(65), 'name\nSECRET', 'name\0', '\u007f', '\u0085'].map(name => data([{ ...face(), name }])),
    ...[0, 1, null, 'true', undefined].map(animated => data([{ ...face(), animated }]))];
  for (const value of bad) assert.throws(() => validateFaceCatalog(value), /Invalid QQ face catalog/);
  let touched = false;
  const getter = Object.defineProperty({ id: '14', animated: false }, 'name', { enumerable: true, get() { touched = true; return 'SECRET'; } });
  assert.throws(() => validateFaceCatalog(data([getter])));
  assert.equal(touched, false);
  const valid = validateFaceCatalog(data([face('0', '惊讶'), face('375', '超级鼓掌', true)]));
  assert.deepEqual(valid, [face('0', '惊讶'), face('375', '超级鼓掌', true)]);
  assert.ok(Object.isFrozen(valid));
});

test('extractor uses sysface only, strips exactly the initial slash, preserves names and drops metadata', () => {
  const source = { sysface: [
    { QSid: '0', QDes: '/惊讶', IQLid: 'not-the-id', url: 'SECRET' },
    { QSid: '375', QDes: '/超级鼓掌', AniStickerType: 1, AniStickerId: 'SECRET', AniStickerPackId: 'SECRET' },
    { QSid: '999998', QDes: '/literal/name', AniStickerType: 0 },
    { QSid: '🎉', QDes: '/not numeric' },
  ], emoji: [{ QSid: '123456', QDes: '/must not be included' }] };
  const catalog = extractFaceCatalog(source);
  assert.deepEqual(catalog, data([face('0', '惊讶'), face('375', '超级鼓掌', true), face('999998', 'literal/name')]));
  assert.equal(JSON.stringify(catalog).includes('SECRET'), false);
  assert.equal(JSON.stringify(catalog).includes('123456'), false);
  source.sysface[0]!.QDes = '/changed';
  assert.equal(catalog.faces[0]!.name, '惊讶');
  for (const malformed of [null, {}, { sysface: [] }, { sysface: [null] }, { sysface: [{ QSid: 14, QDes: '/x' }] }, { sysface: [{ QSid: '014', QDes: '/x' }] }, { sysface: [{ QSid: '14', QDes: '/x\nSECRET' }] }, { sysface: Array(1025).fill({ QSid: '14', QDes: '/x' }) }]) assert.throws(() => extractFaceCatalog(malformed));
});

test('local loader loads full validated data, falls back only when absent, and does not reread after loading', t => {
  const dir = directory(t), path = join(dir, 'qq-faces.json');
  assert.equal(loadFaceCatalog(path), EXAMPLE_FACE_CATALOG);
  const rows = Array.from({ length: 329 }, (_, i) => face(String(i), `测试${i}`, i % 2 === 0));
  writeFileSync(path, JSON.stringify(data(rows)));
  const loaded = loadFaceCatalog(path);
  assert.deepEqual(loaded, rows);
  writeFileSync(path, JSON.stringify(data([face()])));
  assert.equal(loaded.length, 329);
  assert.equal(loadFaceCatalog(path).length, 1);
});

test('malformed, oversized, invalid UTF8 or symlinked existing data fails with a static safe error', t => {
  const dir = directory(t), path = join(dir, 'qq-faces.json');
  for (const content of ['SECRET invalid', JSON.stringify({ ...data(), secret: 'SECRET' }), JSON.stringify(data([])), Buffer.alloc(FACE_DATA_LIMIT + 1, 32), Buffer.from([0xff])]) {
    writeFileSync(path, content);
    assert.throws(() => loadFaceCatalog(path), error => error instanceof Error && /Invalid local QQ face catalog/.test(error.message) && !error.message.includes('SECRET'));
  }
  const link = join(dir, 'link.json'); symlinkSync(path, link);
  assert.throws(() => loadFaceCatalog(link), /Cannot read local QQ face catalog/);
  assert.throws(() => loadFaceCatalog(dir), /Invalid local QQ face catalog/);
});

test('sync utility import never initiates an implicit network request', () => {
  const result = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    "globalThis.fetch=()=>{throw new Error('Unexpected network')}; await import('./src/cli/sync-faces.ts'); console.log('offline import');"], { encoding: 'utf8', cwd: new URL('../../../..', import.meta.url) });
  assert.equal(result.trim(), 'offline import');
});
