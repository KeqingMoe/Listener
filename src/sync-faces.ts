import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const FACE_CATALOG_VERSION = '4.18.28';
export const FACE_CATALOG_SOURCE = `https://raw.githubusercontent.com/NapNeko/NapCatQQ/v${FACE_CATALOG_VERSION}/packages/napcat-core/external/face_config.json`;
export const FACE_CATALOG_LICENSE = `https://raw.githubusercontent.com/NapNeko/NapCatQQ/v${FACE_CATALOG_VERSION}/LICENSE`;
export const FACE_DATA_LIMIT = 1024 * 1024;
export interface FaceCatalogEntry { readonly id: string; readonly name: string; readonly animated: boolean }
export interface FaceCatalogData { version: string; faces: readonly FaceCatalogEntry[] }
const invalid = (): never => { throw new Error('Invalid QQ face catalog'); };
function dataObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'));
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function canonicalFaceId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 6 && value.trim() === value && /^(0|[1-9]\d{0,5})$/.test(value);
}
/** Validate the generated minimal data, never arbitrary upstream transport metadata. */
export function validateFaceCatalog(value: unknown): readonly FaceCatalogEntry[] {
  if (!dataObject(value) || !exact(value, ['version', 'faces']) || value.version !== FACE_CATALOG_VERSION || !Array.isArray(value.faces) || !value.faces.length || value.faces.length > 1024) return invalid();
  const ids = new Set<string>();
  const faces = value.faces.map(face => {
    if (!dataObject(face) || !exact(face, ['id', 'name', 'animated']) || !canonicalFaceId(face.id) || ids.has(face.id)
      || typeof face.name !== 'string' || !face.name.trim() || face.name.length > 64 || /[\u0000-\u001f\u007f-\u009f]/.test(face.name) || typeof face.animated !== 'boolean') return invalid();
    ids.add(face.id);
    return Object.freeze({ id: face.id, name: face.name, animated: face.animated });
  });
  return Object.freeze(faces);
}
/** Only sysface numeric QSid entries: Unicode emoji and all raw metadata stay out. */
export function extractFaceCatalog(source: unknown): FaceCatalogData {
  if (!dataObject(source) || !Array.isArray(source.sysface) || source.sysface.length > 1024) return invalid();
  const faces: FaceCatalogEntry[] = [];
  for (const face of source.sysface) {
    if (!dataObject(face)) return invalid();
    if (typeof face.QSid !== 'string') return invalid();
    if (!/^\d+$/.test(face.QSid)) continue;
    if (!canonicalFaceId(face.QSid) || typeof face.QDes !== 'string') return invalid();
    faces.push({ id: face.QSid, name: face.QDes.replace(/^\//, ''), animated: Boolean(face.AniStickerType) });
  }
  return { version: FACE_CATALOG_VERSION, faces: validateFaceCatalog({ version: FACE_CATALOG_VERSION, faces }) };
}
async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > FACE_DATA_LIMIT) {
    await response.body?.cancel(); throw new Error('QQ face source unavailable');
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > FACE_DATA_LIMIT) { await reader.cancel(); throw new Error('QQ face source too large'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
async function atomicWrite(directory: URL, name: string, data: Uint8Array): Promise<void> {
  const temporary = new URL(`.${name}.${randomBytes(12).toString('hex')}.tmp`, directory);
  let handle; let created = false;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    await handle.writeFile(data); await handle.sync(); await handle.close(); handle = undefined;
    await rename(temporary, new URL(name, directory));
  } finally { await handle?.close(); if (created) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
/** Explicit opt-in CLI only. Imports and tests never fetch the network. */
export async function syncFaces(): Promise<void> {
  const source = await download(FACE_CATALOG_SOURCE);
  const license = await download(FACE_CATALOG_LICENSE);
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(source);
  const licenseText = new TextDecoder('utf-8', { fatal: true }).decode(license);
  if (!licenseText.includes('Limited Redistribution License for NapCat') || !licenseText.includes('Mlikiowa')) throw new Error('Unexpected QQ face source license');
  const catalog = extractFaceCatalog(JSON.parse(decoded));
  const directory = new URL('../data/', import.meta.url);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Invalid QQ face data directory');
  // Original files remain byte-for-byte intact in ignored data/, together with
  // upstream license. Publish the minimal runtime table last, atomically.
  await atomicWrite(directory, `napcat-face-config-v${FACE_CATALOG_VERSION}.json`, source);
  await atomicWrite(directory, `NAPCAT-LICENSE-v${FACE_CATALOG_VERSION}.txt`, license);
  await atomicWrite(directory, 'qq-faces.json', Buffer.from(JSON.stringify(catalog) + '\n'));
  console.log(`QQ face catalog synchronized: NapCat ${FACE_CATALOG_VERSION}, ${catalog.faces.length} IDs. Restart Listener to load it.`);
  console.log('Source and full upstream license retained under ignored data/. Check upstream restrictions before redistribution.');
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  syncFaces().catch(() => { console.error('faces:sync failed: check network, source format/license, and data directory permissions.'); process.exitCode = 1; });
}
