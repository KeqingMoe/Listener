import { DatabaseSync } from 'node:sqlite';
import { constants, lstatSync, mkdirSync } from 'node:fs';
import { open, readdir, rename, unlink, lstat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

/** Per-artifact and whole-store disk budgets. Full storage rejects; nothing is evicted early. */
export const ARTIFACT_LIMITS = { bytes: 64 * 1024 * 1024, totalBytes: 2 * 1024 * 1024 * 1024, ttlMs: 24 * 60 * 60 * 1000, name: 128, description: 500, mediaType: 128 } as const;

export interface ArtifactScope { selfId: string; groupId: string }

export interface Artifact extends ArtifactScope {
  artifactId: string; name: string; description: string; mediaType: string;
  size: number; sha256: string; createdAt: number; expiresAt: number;
}

export class ArtifactError extends Error {}
const fail = (code: string): never => { throw new ArtifactError(code); };
const ID = /^art_[a-f0-9]{24}$/;
const MEDIA = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;

/** Validate a display name: also the QQ file name for uploads, so no path structure or control characters. */
export function validArtifactName(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && value.length > 0 && [...value].length <= ARTIFACT_LIMITS.name &&
    !/[\u0000-\u001f\u007f/\\]/u.test(value) && value !== '.' && value !== '..';
}

export function validMediaType(value: unknown): value is string { return typeof value === 'string' && MEDIA.test(value); }

export interface ArtifactInput extends ArtifactScope { name: string; description: string; mediaType: string; ttlMs: number; bytes: Uint8Array }

/**
 * Durable scoped binary objects. Metadata lives in SQLite; content lives in a directory NapCat
 * can also read, named only by artifact id, written atomically (exclusive tmp + fsync + rename).
 */
export class ArtifactStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private writing = Promise.resolve();
  constructor(private readonly options: { path: string; directory: string; providerDirectory: string; now?: () => number }) {
    if (!path.isAbsolute(options.directory) || !path.posix.isAbsolute(options.providerDirectory)) {throw new Error('invalid_artifact_directory');}
    this.now = options.now ?? Date.now;
    mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(options.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {throw new Error('invalid_artifact_directory');}
    this.db = new DatabaseSync(options.path);
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,self_id TEXT NOT NULL,group_id TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL,media_type TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS artifacts_scope ON artifacts(self_id,group_id,created_at);
      CREATE INDEX IF NOT EXISTS artifacts_expiry ON artifacts(expires_at);`);
  }

  /** NapCat-side absolute path for an artifact file. */
  providerPath(artifact: Artifact): string { return path.posix.join(this.options.providerDirectory, artifact.artifactId); }
  private file(id: string): string { if (!ID.test(id)) {fail('artifact_not_found');} return path.join(this.options.directory, id); }

  async create(input: ArtifactInput): Promise<Artifact> {
    scope(input);
    if (!validArtifactName(input.name)) {fail('invalid_arguments');}
    if (typeof input.description !== 'string' || !input.description.trim() || [...input.description].length > ARTIFACT_LIMITS.description) {fail('invalid_arguments');}
    if (!validMediaType(input.mediaType)) {fail('invalid_arguments');}
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 1 || input.ttlMs > ARTIFACT_LIMITS.ttlMs) {fail('invalid_arguments');}
    if (!(input.bytes instanceof Uint8Array)) {fail('invalid_arguments');}
    if (input.bytes.byteLength > ARTIFACT_LIMITS.bytes) {fail('artifact_too_large');}
    // Serialize writers so the global quota check and the write are one step.
    const run = this.writing.then(() => this.write(input));
    this.writing = run.then(() => {}, () => {});
    return run;
  }

  private async write(input: ArtifactInput): Promise<Artifact> {
    await this.sweep();
    const used = Number(this.db.prepare('SELECT coalesce(sum(size),0) AS n FROM artifacts').get()!.n);
    if (used + input.bytes.byteLength > ARTIFACT_LIMITS.totalBytes) {fail('artifact_storage_full');}
    const id = 'art_' + randomBytes(12).toString('hex'), final = this.file(id), tmp = path.join(this.options.directory, `.${id}.${randomBytes(4).toString('hex')}.tmp`);
    const handle = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(input.bytes); await handle.chmod(0o400); await handle.sync(); }
    catch (error) { await handle.close().catch(() => {}); await unlink(tmp).catch(() => {}); throw error; }
    await handle.close();
    try { await rename(tmp, final); } catch (error) { await unlink(tmp).catch(() => {}); throw error; }
    const now = this.now();
    const artifact: Artifact = { artifactId: id, selfId: input.selfId, groupId: input.groupId, name: input.name, description: input.description.trim(), mediaType: input.mediaType, size: input.bytes.byteLength, sha256: createHash('sha256').update(input.bytes).digest('hex'), createdAt: now, expiresAt: now + input.ttlMs };
    try {
      this.db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, artifact.selfId, artifact.groupId, artifact.name, artifact.description, artifact.mediaType, artifact.size, artifact.sha256, artifact.createdAt, artifact.expiresAt);
    } catch (error) { await unlink(final).catch(() => {}); throw error; }
    return artifact;
  }

  get(s: ArtifactScope, id: string): Artifact | undefined {
    scope(s);
    if (typeof id !== 'string' || !ID.test(id)) {return undefined;}
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id=? AND self_id=? AND group_id=? AND expires_at>?').get(id, s.selfId, s.groupId, this.now());
    return row ? decode(row) : undefined;
  }

  list(s: ArtifactScope, offset = 0, limit = 20): { artifacts: Artifact[]; hasMore: boolean } {
    scope(s);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {fail('invalid_arguments');}
    const rows = this.db.prepare('SELECT * FROM artifacts WHERE self_id=? AND group_id=? AND expires_at>? ORDER BY created_at DESC,id LIMIT ? OFFSET ?').all(s.selfId, s.groupId, this.now(), limit + 1, offset);
    return { artifacts: rows.slice(0, limit).map(decode), hasMore: rows.length > limit };
  }

  /** Read and integrity-check content; a mismatching or replaced file is never served. */
  async read(artifact: Artifact): Promise<Buffer> {
    const handle = await open(this.file(artifact.artifactId), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => fail('artifact_unavailable'));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size !== artifact.size) {fail('artifact_unavailable');}
      const bytes = await handle.readFile();
      if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) {fail('artifact_unavailable');}
      return bytes;
    } finally { await handle.close(); }
  }

  /** Remove expired rows and files, and stray temporaries or orphans older than a minute. */
  async sweep(): Promise<void> {
    const now = this.now();
    for (const row of this.db.prepare('SELECT id FROM artifacts WHERE expires_at<=? LIMIT 500').all(now)) {
      const id = String(row.id);
      await unlink(this.file(id)).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {throw error;} });
      this.db.prepare('DELETE FROM artifacts WHERE id=?').run(id);
    }
    for (const name of await readdir(this.options.directory)) {
      if (ID.test(name) && this.db.prepare('SELECT 1 FROM artifacts WHERE id=?').get(name)) {continue;}
      const full = path.join(this.options.directory, name), stat = await lstat(full).catch(() => undefined);
      if (stat?.isFile() && now - stat.mtimeMs > 60_000) {await unlink(full).catch(() => {});}
    }
  }

  close(): void { this.db.close(); }
}

function scope(s: ArtifactScope): void {
  if (!s || typeof s.selfId !== 'string' || !/^[1-9]\d{0,19}$/.test(s.selfId) || typeof s.groupId !== 'string' || !/^[1-9]\d{0,19}$/.test(s.groupId)) {fail('invalid_scope');}
}

function decode(row: Record<string, unknown>): Artifact {
  return { artifactId: String(row.id), selfId: String(row.self_id), groupId: String(row.group_id), name: String(row.name), description: String(row.description), mediaType: String(row.media_type), size: Number(row.size), sha256: String(row.sha256), createdAt: Number(row.created_at), expiresAt: Number(row.expires_at) };
}
