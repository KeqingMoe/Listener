import { constants } from 'node:fs';
import { link, lstat, mkdir, open, opendir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

export type CustomFaceImageFormat = 'jpeg' | 'png' | 'gif' | 'webp';
export interface CustomFaceStager {
  stage(bytes: Buffer, format: CustomFaceImageFormat): Promise<{ providerPath: string; digest: string }>;
  assertAvailable?(): Promise<void>;
}
export interface SharedCustomFaceStagingOptions {
  directory: string;
  providerDirectory: string;
  maxBytes?: number;
  maxFiles?: number;
}

type Failure = 'storage_configuration' | 'storage_unavailable' | 'storage_integrity' | 'storage_capacity' | 'storage_invalid_image';
class StorageError extends Error {
  constructor(code: Failure) { super(code); this.name = 'CustomFaceStorageError'; }
}
function fail(code: Failure): never { throw new StorageError(code); }
const MARKER = '.qqbot-custom-face-cache.json';
const KIND = 'qqbot-custom-face-original-cache';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ASSET = /^([a-f0-9]{64})\.(jpeg|png|gif|webp)$/;
const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const queues = new Map<string, Promise<void>>();
interface Owner { kind: typeof KIND; version: 1; id: string; dev: string; ino: string; directory: string; providerDirectory: string }
interface Directory { handle: FileHandle; anchor: string; identity: BigIntStats }

function absoluteDirectory(value: unknown): string {
  if (typeof value !== 'string' || value.length > 3000 || !value.startsWith('/') || /[\x00-\x1f\x7f\\]/.test(value)) return fail('storage_configuration');
  if (value.split('/').some(part => part === '.' || part === '..')) return fail('storage_configuration');
  const normalized = path.posix.normalize(value).replace(/\/+$/, '');
  if (!normalized || normalized === '/') return fail('storage_configuration');
  return normalized;
}
function limit(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) return fail('storage_configuration');
  return result;
}
function digestOf(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function signature(bytes: Buffer, format: CustomFaceImageFormat): boolean {
  switch (format) {
    case 'jpeg': return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'png': return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case 'gif': return bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
    case 'webp': return bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length;
    default: return false;
  }
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino; }
function errno(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }

/**
 * Persistent original-byte cache, NOT a temporary upload directory. Nothing is
 * evicted automatically: QQ may retain the supplied path after its API returns.
 * Linux procfs anchors child operations to an opened directory inode. Only the
 * program/deployment may supply these paths; provider paths never go to a model.
 * The caller must fully validate/decode the image; this class checks signatures.
 */
export class SharedCustomFaceStaging implements CustomFaceStager {
  private readonly directory: string;
  private readonly providerDirectory: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private readonly uid: bigint;
  private knownOwner: Pick<Owner, 'dev' | 'ino' | 'id'> | undefined;

  constructor(options: SharedCustomFaceStagingOptions) {
    if (process.platform !== 'linux' || typeof process.getuid !== 'function' || !options || typeof options !== 'object') fail('storage_configuration');
    this.directory = absoluteDirectory(options.directory);
    this.providerDirectory = absoluteDirectory(options.providerDirectory);
    this.maxBytes = limit(options.maxBytes, 512 * 1024 * 1024);
    this.maxFiles = limit(options.maxFiles, 4096);
    this.uid = BigInt(process.getuid());
  }

  async assertAvailable(): Promise<void> {
    await this.exclusive(async () => this.withDirectory(async dir => {
      const owner = await this.owner(dir);
      await this.scan(dir, owner);
    }));
  }

  async stage(bytes: Buffer, format: CustomFaceImageFormat): Promise<{ providerPath: string; digest: string }> {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || !signature(bytes, format)) fail('storage_invalid_image');
    // Copy before the first await; the caller cannot change staged bytes in flight.
    const original = Buffer.from(bytes);
    const digest = digestOf(original);
    const name = `${digest}.${format}`;
    return this.exclusive(async () => this.withDirectory(async dir => {
      const owner = await this.owner(dir);
      const inventory = await this.scan(dir, owner);
      if (!inventory.names.has(name)) {
        if (inventory.names.size >= this.maxFiles || inventory.bytes + original.length > this.maxBytes) fail('storage_capacity');
        await this.publish(dir, owner, name, original);
      }
      await this.checkDirectory(dir);
      // Re-open and hash even reused files; do not trust names or cached metadata.
      const stored = await this.readRegular(dir, name, MAX_IMAGE_BYTES);
      if (!stored.bytes.equals(original)) fail('storage_integrity');
      return { providerPath: path.posix.join(this.providerDirectory, name), digest };
    }));
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(this.directory) ?? Promise.resolve();
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => wait);
    queues.set(this.directory, tail);
    await previous;
    try { return await operation(); }
    catch (error) { if (error instanceof StorageError) throw error; return fail('storage_unavailable'); }
    finally { release(); if (queues.get(this.directory) === tail) queues.delete(this.directory); }
  }

  private validateAncestor(stat: BigIntStats): void {
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== this.uid && stat.uid !== 0n)) fail('storage_integrity');
    // A sticky /tmp is fine; a freely replaceable non-sticky parent is not.
    if ((stat.mode & 0o022n) !== 0n && (stat.mode & 0o1000n) === 0n) fail('storage_integrity');
  }

  private async walk(create: boolean): Promise<BigIntStats> {
    let current = '/';
    let stat = await lstat(current, { bigint: true });
    this.validateAncestor(stat);
    for (const part of this.directory.split('/').filter(Boolean)) {
      current = path.posix.join(current, part);
      try { stat = await lstat(current, { bigint: true }); }
      catch (error) {
        if (!create || errno(error) !== 'ENOENT') throw error;
        try { await mkdir(current, { mode: 0o700 }); }
        catch (creationError) { if (errno(creationError) !== 'EEXIST') throw creationError; }
        stat = await lstat(current, { bigint: true });
      }
      this.validateAncestor(stat);
    }
    if (stat.uid !== this.uid) fail('storage_integrity');
    return stat;
  }

  private async withDirectory<T>(operation: (dir: Directory) => Promise<T>): Promise<T> {
    const identity = await this.walk(true);
    const handle = await open(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      if (!sameFile(identity, await handle.stat({ bigint: true }))) fail('storage_integrity');
      const dir = { handle, identity, anchor: `/proc/self/fd/${handle.fd}` };
      return await operation(dir);
    } finally { await handle.close(); }
  }

  private async checkDirectory(dir: Directory): Promise<void> {
    const current = await this.walk(false);
    const opened = await dir.handle.stat({ bigint: true });
    if (!sameFile(current, dir.identity) || !sameFile(opened, dir.identity) || (current.mode & 0o7777n) !== 0o700n || (opened.mode & 0o7777n) !== 0o700n) fail('storage_integrity');
  }

  private async owner(dir: Directory): Promise<Owner> {
    if (this.knownOwner && (this.knownOwner.dev !== dir.identity.dev.toString() || this.knownOwner.ino !== dir.identity.ino.toString())) fail('storage_integrity');
    const names = await this.entries(dir);
    if (!names.includes(MARKER)) {
      if (this.knownOwner || names.length !== 0) fail('storage_integrity');
      await dir.handle.chmod(0o700);
      await this.checkDirectory(dir);
      const owner: Owner = { kind: KIND, version: 1, id: randomUUID(), dev: dir.identity.dev.toString(), ino: dir.identity.ino.toString(), directory: this.directory, providerDirectory: this.providerDirectory };
      const tmp = `.init-${owner.id}-${randomUUID()}.tmp`;
      await this.writeExclusive(dir, tmp, Buffer.from(JSON.stringify(owner)));
      try {
        await link(path.posix.join(dir.anchor, tmp), path.posix.join(dir.anchor, MARKER));
        await unlink(path.posix.join(dir.anchor, tmp));
        await dir.handle.sync();
      } catch (error) {
        // Remove only the file this operation created; never touch a winner's marker.
        await this.removeOwnUnpublished(dir, tmp);
        throw error;
      }
    }
    await this.checkDirectory(dir);
    const record = await this.readRegular(dir, MARKER, 4096, true);
    let owner: Owner;
    try { owner = JSON.parse(record.bytes.toString('utf8')) as Owner; }
    catch { return fail('storage_integrity'); }
    if (!owner || Object.keys(owner).sort().join(',') !== 'dev,directory,id,ino,kind,providerDirectory,version' || owner.kind !== KIND || owner.version !== 1 || typeof owner.id !== 'string' || !new RegExp(`^${UUID}$`).test(owner.id) || owner.dev !== dir.identity.dev.toString() || owner.ino !== dir.identity.ino.toString() || owner.directory !== this.directory || owner.providerDirectory !== this.providerDirectory) fail('storage_integrity');
    if (this.knownOwner && this.knownOwner.id !== owner.id) fail('storage_integrity');
    this.knownOwner = { dev: owner.dev, ino: owner.ino, id: owner.id };
    return owner;
  }

  private async readRegular(dir: Directory, name: string, maxSize: number, allowPublishLink = false, allowEmpty = false): Promise<{ bytes: Buffer; stat: BigIntStats }> {
    const file = path.posix.join(dir.anchor, name);
    const before = await lstat(file, { bigint: true });
    const validate = (stat: BigIntStats) => {
      const mode = stat.mode & 0o7777n;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== this.uid || ![0o400n, 0o600n].includes(mode) || (stat.nlink !== 1n && !(allowPublishLink && stat.nlink === 2n)) || (stat.size <= 0n && !allowEmpty) || stat.size > BigInt(maxSize)) fail('storage_integrity');
    };
    validate(before);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat({ bigint: true });
      validate(stat);
      if (!sameFile(before, stat)) fail('storage_integrity');
      // A concurrently growing file must not turn this into an unbounded read.
      const buffer = Buffer.alloc(Number(stat.size) + 1);
      let read = 0;
      while (read < buffer.length) {
        const chunk = await handle.read(buffer, read, buffer.length - read, read);
        if (chunk.bytesRead === 0) break;
        read += chunk.bytesRead;
      }
      const bytes = buffer.subarray(0, read);
      const after = await handle.stat({ bigint: true });
      const named = await lstat(file, { bigint: true });
      validate(after); validate(named);
      if (!sameFile(stat, named) || stat.size !== after.size || after.size !== BigInt(bytes.length) || stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs) fail('storage_integrity');
      return { bytes, stat: after };
    } finally { await handle.close(); }
  }

  private async recoverTemps(dir: Directory, owner: Owner, names: string[]): Promise<void> {
    const tempPattern = new RegExp(`^\\.tmp-${owner.id}-([a-f0-9]{64}\\.(?:jpeg|png|gif|webp))-${UUID}\\.tmp$`);
    const initPattern = new RegExp(`^\\.init-${owner.id}-${UUID}\\.tmp$`);
    for (const name of names) {
      if (name !== MARKER && !ASSET.test(name) && !tempPattern.test(name) && !initPattern.test(name)) fail('storage_integrity');
    }
    for (const name of names) {
      const match = tempPattern.exec(name);
      const initial = initPattern.test(name);
      if (!match && !initial) continue;
      const source = await this.readRegular(dir, name, initial ? 4096 : MAX_IMAGE_BYTES, true, true);
      const target = initial ? MARKER : match![1]!;
      if (source.stat.nlink === 2n) {
        const destination = await this.readRegular(dir, target, initial ? 4096 : MAX_IMAGE_BYTES, true);
        if (!sameFile(source.stat, destination.stat)) fail('storage_integrity');
      }
      // An unpublished one-link temp cannot be referenced by a returned providerPath.
      await unlink(path.posix.join(dir.anchor, name));
    }
    await this.readRegular(dir, MARKER, 4096);
  }

  private async entries(dir: Directory): Promise<string[]> {
    const names: string[] = [];
    const listing = await opendir(dir.anchor);
    for await (const entry of listing) {
      names.push(entry.name);
      // Include bounded room for marker and interrupted unpublished writes.
      if (names.length > this.maxFiles + 64) fail('storage_capacity');
    }
    return names;
  }

  private async scan(dir: Directory, owner: Owner): Promise<{ names: Set<string>; bytes: number }> {
    await this.recoverTemps(dir, owner, await this.entries(dir));
    const names = new Set<string>();
    let bytes = 0;
    for (const name of await this.entries(dir)) {
      if (name === MARKER) continue;
      const match = ASSET.exec(name);
      if (!match) fail('storage_integrity');
      const record = await this.readRegular(dir, name, MAX_IMAGE_BYTES);
      const format = match[2] as CustomFaceImageFormat;
      if (digestOf(record.bytes) !== match[1] || !signature(record.bytes, format)) fail('storage_integrity');
      bytes += record.bytes.length;
      names.add(name);
      if (bytes > this.maxBytes || names.size > this.maxFiles) fail('storage_capacity');
    }
    await this.checkDirectory(dir);
    return { names, bytes };
  }

  private async writeExclusive(dir: Directory, name: string, bytes: Buffer): Promise<void> {
    const file = path.posix.join(dir.anchor, name);
    const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.chmod(0o400); await handle.sync(); }
    catch (error) { await handle.close(); await this.removeOwnUnpublished(dir, name); throw error; }
    await handle.close();
  }

  private async removeOwnUnpublished(dir: Directory, name: string): Promise<void> {
    try {
      const stat = await lstat(path.posix.join(dir.anchor, name), { bigint: true });
      if (stat.isFile() && !stat.isSymbolicLink() && stat.uid === this.uid && stat.nlink === 1n) await unlink(path.posix.join(dir.anchor, name));
    } catch { /* best-effort cleanup of this operation's unpublished file only */ }
  }

  private async publish(dir: Directory, owner: Owner, name: string, bytes: Buffer): Promise<void> {
    const tmp = `.tmp-${owner.id}-${name}-${randomUUID()}.tmp`;
    await this.writeExclusive(dir, tmp, bytes);
    try {
      await this.checkDirectory(dir);
      // link is an atomic no-replace publication; rename could overwrite a winner.
      await link(path.posix.join(dir.anchor, tmp), path.posix.join(dir.anchor, name));
      await unlink(path.posix.join(dir.anchor, tmp));
      await dir.handle.sync();
    } catch (error) {
      await this.removeOwnUnpublished(dir, tmp);
      if (errno(error) !== 'EEXIST') throw error;
      const winner = await this.readRegular(dir, name, MAX_IMAGE_BYTES);
      if (!winner.bytes.equals(bytes)) fail('storage_integrity');
    }
  }
}
