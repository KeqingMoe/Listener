import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { types } from 'node:util';
import { immediate } from '../../storage/transaction.ts';

/** 只存元数据；传输URL、文件路径、图片字节和密钥都不放这里。 */
export interface CustomFaceInput {
  resId: string;
  emoId: number | string;
  md5: string;
  description: string;
  tags?: string[];
}

export interface CustomFaceRecord {
  accountId: string;
  resId: string;
  emoId: number;
  md5: string;
  description: string;
  tags: string[];
  revision: number;
  /** 本地撤销标记，不代表QQ已确认删除。 */
  retired: boolean;
}

interface CustomFaceListItem {
  face_ref: string;
  description: string;
  tags: string[];
  revision: number;
}

interface CustomFaceListOptions {
  query?: string;
  limit?: number;
  cursor?: string;
}

interface CustomFacePage {
  items: CustomFaceListItem[];
  coverage: 'observed_prefix';
  /** 本地快照中的数量，不是QQ账号的总数。 */
  snapshot_count: number;
  stale_omitted: number;
  next_cursor?: string;
}

type Stored = {
  account_id: string;
  res_id: string;
  resource_id: string;
  emo_id: number;
  md5: string;
  description: string;
  tags: string;
  revision: number;
  retired: number;
};

type SnapshotMember = { id: string; revision: number };

type Snapshot = {
  snapshot_id: string;
  account_id: string;
  group_id: string;
  query: string;
  members: string;
  created_at: number;
};

const IDENTITY = 'qqbot.custom-face-index';
const VERSION = 1;
const TABLES = [
  'custom_face_identity',
  'custom_faces',
  'custom_face_snapshots',
];
const MAX_SYNC = 10_000;
const MAX_ACCOUNT_ROWS = 20_000;
const MAX_SNAPSHOTS = 128;
const MAX_TOTAL_SNAPSHOTS = 4096;
const SNAPSHOT_AGE = 60 * 60 * 1000;

function FAIL(code: string): never {
  throw new Error(`custom_face_${code}`);
}

function plain(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): void {
  if (
    !value ||
    typeof value !== 'object' ||
    types.isProxy(value) ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    FAIL('invalid_metadata');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some((key) => typeof key !== 'string' || !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(descriptors, key)) ||
    keys.some(
      (key) =>
        !Object.hasOwn(descriptors[key as string]!, 'value') ||
        !descriptors[key as string]!.enumerable,
    )
  ) {
    FAIL('invalid_metadata');
  }
}

function array(value: unknown, maximum: number): asserts value is unknown[] {
  if (
    !Array.isArray(value) ||
    types.isProxy(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum
  ) {
    FAIL('invalid_metadata');
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== value.length + 1 ||
    keys.some(
      (key) =>
        key !== 'length' &&
        (typeof key !== 'string' ||
          !/^(0|[1-9]\d*)(?![\s\S])/.test(key) ||
          Number(key) >= value.length ||
          !Object.hasOwn(
            Object.getOwnPropertyDescriptor(value, key)!,
            'value',
          )),
    )
  ) {
    FAIL('invalid_metadata');
  }
}

function scope(value: unknown): asserts value is string {
  // 显式断言字符串绝对结尾：ID校验不能依赖多行模式或$锚点语义，也不能经trim或类型转换变成另一个ID。
  if (typeof value !== 'string' || !/^[1-9]\d{0,31}(?![\s\S])/.test(value)) {
    FAIL('invalid_scope');
  }
}

function resourceId(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    Buffer.byteLength(value) > 512 ||
    /[\s\u0000-\u001f\u007f/\\]/u.test(value)
  ) {
    FAIL('invalid_resource');
  }
}

function description(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value) > 2048 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    FAIL('invalid_description');
  }
}

function normalizeTags(value: unknown): string[] {
  array(value, 16);
  const result: string[] = [];
  for (const tag of value) {
    if (
      typeof tag !== 'string' ||
      !tag.trim() ||
      Buffer.byteLength(tag) > 128 ||
      /[\u0000-\u001f\u007f]/.test(tag)
    ) {
      FAIL('invalid_tags');
    }
    const normalized = tag.trim().normalize('NFKC');
    if (!result.includes(normalized)) {
      result.push(normalized);
    }
  }
  return result;
}

function normalize(input: unknown): CustomFaceInput & { emoId: number } {
  plain(
    input,
    ['resId', 'emoId', 'md5', 'description', 'tags'],
    ['resId', 'emoId', 'md5', 'description'],
  );
  const value = input as Record<string, unknown>;
  resourceId(value.resId);
  let emoId = value.emoId;
  if (typeof emoId === 'string' && /^(0|[1-9]\d{0,15})(?![\s\S])/.test(emoId)) {
    emoId = Number(emoId);
  }
  if (
    typeof emoId !== 'number' ||
    !Number.isSafeInteger(emoId) ||
    emoId < 0 ||
    Object.is(emoId, -0)
  ) {
    FAIL('invalid_emoji_id');
  }
  if (
    typeof value.md5 !== 'string' ||
    !/^[a-f0-9]{32}(?![\s\S])/i.test(value.md5)
  ) {
    FAIL('invalid_md5');
  }
  description(value.description);
  return {
    resId: value.resId,
    emoId,
    md5: value.md5.toLowerCase(),
    description: value.description,
    ...(Object.hasOwn(value, 'tags')
      ? { tags: normalizeTags(value.tags) }
      : {}),
  };
}

function fromRow(row: Stored): CustomFaceRecord {
  return {
    accountId: row.account_id,
    resId: row.res_id,
    emoId: row.emo_id,
    md5: row.md5,
    description: row.description,
    tags: JSON.parse(row.tags) as string[],
    revision: row.revision,
    retired: row.retired === 1,
  };
}

function nextRevision(revision: number): number {
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    revision === Number.MAX_SAFE_INTEGER
  ) {
    FAIL('revision_exhausted');
  }
  return revision + 1;
}

function checkSidecars(path: string): void {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    let info;
    try {
      info = lstatSync(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        continue;
      }
      throw error;
    }
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())
    ) {
      FAIL('unsafe_store_file');
    }
  }
}

function inspectIdentity(db: DatabaseSync): string {
  const tables = db
    .prepare(
      "SELECT name,type FROM sqlite_master WHERE type IN ('table','view','trigger') AND name NOT LIKE 'sqlite_%'",
    )
    .all();
  if (
    tables.length !== TABLES.length ||
    tables.some(
      (row) => row.type !== 'table' || !TABLES.includes(String(row.name)),
    )
  ) {
    FAIL('store_identity_mismatch');
  }
  const rows = db
    .prepare('SELECT singleton,kind,version,secret FROM custom_face_identity')
    .all();
  const meta = rows[0];
  if (
    rows.length !== 1 ||
    meta?.singleton !== 1 ||
    meta.kind !== IDENTITY ||
    meta.version !== VERSION ||
    typeof meta.secret !== 'string' ||
    !/^[a-f0-9]{64}(?![\s\S])/.test(meta.secret)
  ) {
    FAIL('store_identity_mismatch');
  }
  // 在可写初始化和chmod之前，先拒绝缺失或不兼容的表。
  db.prepare(
    'SELECT account_id,res_id,resource_id,emo_id,md5,description,tags,revision,retired FROM custom_faces LIMIT 0',
  );
  db.prepare(
    'SELECT snapshot_id,account_id,group_id,query,members,created_at FROM custom_face_snapshots LIMIT 0',
  );
  return meta.secret;
}

/**
 * 账号共享的表情元数据，引用绑定到群。本类不授予任何QQ权限：
 * 调用方必须自行校验当前登录账号、群策略和原生资源的实时状态。
 * 不做后台刷新，也不发API请求，构建schema时同样如此。
 */
export class CustomFaceStore {
  private readonly db: DatabaseSync;
  private readonly secret: string;
  private closed = false;
  constructor(options: { path?: string } = {}) {
    plain(options, ['path'], []);
    const path = options.path ?? ':memory:';
    if (
      typeof path !== 'string' ||
      !path ||
      path.length > 4096 ||
      /[\u0000-\u001f]/.test(path)
    ) {
      FAIL('invalid_store_path');
    }
    let fd: number | undefined;
    let database: DatabaseSync | undefined;
    try {
      let info: ReturnType<typeof fstatSync> | undefined;
      let existingSecret: string | undefined;
      if (path !== ':memory:') {
        checkSidecars(path);
        fd = openSync(
          path,
          constants.O_RDWR |
            constants.O_CREAT |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK,
          0o600,
        );
        info = fstatSync(fd);
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          (typeof process.getuid === 'function' &&
            info.uid !== process.getuid())
        ) {
          FAIL('unsafe_store_file');
        }
        if (info.size > 0) {
          const probe = new DatabaseSync(path, { readOnly: true });
          try {
            existingSecret = inspectIdentity(probe);
          } finally {
            probe.close();
          }
        }
        const current = lstatSync(path);
        if (
          current.isSymbolicLink() ||
          current.ino !== info.ino ||
          current.dev !== info.dev
        ) {
          FAIL('store_file_changed');
        }
        fchmodSync(fd, 0o600);
      }
      database = new DatabaseSync(path);
      if (info) {
        const current = lstatSync(path);
        if (
          current.isSymbolicLink() ||
          current.ino !== info.ino ||
          current.dev !== info.dev
        ) {
          FAIL('store_file_changed');
        }
      }
      database.exec(
        'PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON;',
      );
      if (existingSecret === undefined) {
        const open = database;
        immediate(open, () => {
          open.exec(`
            CREATE TABLE custom_face_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),kind TEXT NOT NULL,version INTEGER NOT NULL,secret TEXT NOT NULL);
            CREATE TABLE custom_faces(
              account_id TEXT NOT NULL,res_id TEXT NOT NULL,resource_id TEXT NOT NULL UNIQUE,
              emo_id INTEGER NOT NULL,md5 TEXT NOT NULL,description TEXT NOT NULL,tags TEXT NOT NULL,
              revision INTEGER NOT NULL CHECK(revision>=1),retired INTEGER NOT NULL CHECK(retired IN (0,1)),
              PRIMARY KEY(account_id,res_id)
            );
            CREATE TABLE custom_face_snapshots(snapshot_id TEXT PRIMARY KEY,account_id TEXT NOT NULL,group_id TEXT NOT NULL,query TEXT NOT NULL,members TEXT NOT NULL,created_at INTEGER NOT NULL);
            CREATE INDEX custom_faces_account ON custom_faces(account_id,retired);
          `);
          open
            .prepare('INSERT INTO custom_face_identity VALUES(1,?,?,?)')
            .run(IDENTITY, VERSION, randomBytes(32).toString('hex'));
        });
      }
      this.secret = inspectIdentity(database);
      this.db = database;
    } catch (error) {
      database?.close();
      if (error instanceof Error && error.message.startsWith('custom_face_')) {
        throw error;
      }
      throw new Error('custom_face_store_unavailable');
    } finally {
      if (fd !== undefined) {
        closeSync(fd);
      }
    }
  }

  private check(): void {
    if (this.closed) {
      FAIL('store_closed');
    }
  }

  private transaction<T>(work: () => T): T {
    this.check();
    return immediate(this.db, work);
  }

  private row(accountId: string, resId: string): Stored | undefined {
    return this.db
      .prepare('SELECT * FROM custom_faces WHERE account_id=? AND res_id=?')
      .get(accountId, resId) as Stored | undefined;
  }

  private mac(
    kind: string,
    accountId: string,
    groupId: string,
    id: string,
    version: number,
  ): string {
    return createHmac('sha256', Buffer.from(this.secret, 'hex'))
      .update(JSON.stringify([kind, accountId, groupId, id, version]))
      .digest('hex');
  }

  private token(
    kind: 'cf' | 'cfc',
    accountId: string,
    groupId: string,
    id: string,
    version: number,
  ): string {
    return `${kind}_${id}_${version}_${this.mac(kind, accountId, groupId, id, version)}`;
  }

  private parseToken(
    value: unknown,
    kind: 'cf' | 'cfc',
    accountId: string,
    groupId: string,
  ): { id: string; version: number } | undefined {
    if (typeof value !== 'string') {
      return;
    }
    const match = new RegExp(
      `^${kind}_([a-f0-9]{32})_(0|[1-9]\\d{0,15})_([a-f0-9]{64})(?![\\s\\S])`,
    ).exec(value);
    if (!match) {
      return;
    }
    const version = Number(match[2]);
    if (!Number.isSafeInteger(version) || (kind === 'cf' && version < 1)) {
      return;
    }
    const expected = this.mac(kind, accountId, groupId, match[1]!, version);
    if (
      !timingSafeEqual(
        Buffer.from(match[3]!, 'hex'),
        Buffer.from(expected, 'hex'),
      )
    ) {
      return;
    }
    return { id: match[1]!, version };
  }

  private put(
    accountId: string,
    value: CustomFaceInput & { emoId: number },
    revive: boolean,
  ): boolean {
    const old = this.row(accountId, value.resId);
    // 删除提交后迟到的列表响应不能作为重新添加的证据。
    if (old?.retired && !revive) {
      return false;
    }
    const identityChanged =
      !!old && (old.emo_id !== value.emoId || old.md5 !== value.md5);
    const captionChanged = !!old && old.description !== value.description;
    const tags =
      value.tags ??
      (old && !identityChanged && !captionChanged && !old.retired
        ? (JSON.parse(old.tags) as string[])
        : []);
    const encodedTags = JSON.stringify(tags);
    if (
      old &&
      !old.retired &&
      !identityChanged &&
      !captionChanged &&
      old.tags === encodedTags
    ) {
      return false;
    }
    if (
      !old &&
      Number(
        this.db
          .prepare(
            'SELECT COUNT(*) AS total FROM custom_faces WHERE account_id=?',
          )
          .get(accountId)?.total,
      ) >= MAX_ACCOUNT_ROWS
    ) {
      FAIL('resource_limit');
    }
    const revision = old ? nextRevision(old.revision) : 1;
    this.db
      .prepare(
        `INSERT INTO custom_faces(account_id,res_id,resource_id,emo_id,md5,description,tags,revision,retired)
      VALUES(?,?,?,?,?,?,?,?,0) ON CONFLICT(account_id,res_id) DO UPDATE SET emo_id=excluded.emo_id,md5=excluded.md5,
      description=excluded.description,tags=excluded.tags,revision=excluded.revision,retired=0`,
      )
      .run(
        accountId,
        value.resId,
        old?.resource_id ?? randomUUID().replaceAll('-', ''),
        value.emoId,
        value.md5,
        value.description,
        encodedTags,
        revision,
      );
    return true;
  }

  /** 只upsert实际观察到的行；缺失的行或被截断的前缀都不会删除记录。 */
  sync(
    accountId: string,
    rows: readonly CustomFaceInput[],
  ): { observed: number; upserted: number } {
    this.check();
    scope(accountId);
    array(rows, MAX_SYNC);
    const normalized = rows.map(normalize);
    if (
      new Set(normalized.map((row) => row.resId)).size !== normalized.length
    ) {
      FAIL('duplicate_resource');
    }
    return this.transaction(() => {
      let upserted = 0;
      for (const row of normalized) {
        if (this.put(accountId, row, false)) {
          upserted++;
        }
      }
      return { observed: normalized.length, upserted };
    });
  }

  /** 仅用于已确证的重新添加，不用于一般的列表刷新。 */
  revive(accountId: string, value: CustomFaceInput): CustomFaceRecord {
    this.check();
    scope(accountId);
    const normalized = normalize(value);
    return this.transaction(() => {
      this.put(accountId, normalized, true);
      return fromRow(this.row(accountId, normalized.resId)!);
    });
  }

  get(accountId: string, resId: string): CustomFaceRecord | undefined {
    this.check();
    scope(accountId);
    resourceId(resId);
    const row = this.row(accountId, resId);
    return row ? fromRow(row) : undefined;
  }

  issue(accountId: string, groupId: string, resId: string): string | undefined {
    this.check();
    scope(accountId);
    scope(groupId);
    resourceId(resId);
    const row = this.row(accountId, resId);
    return row && !row.retired
      ? this.token('cf', accountId, groupId, row.resource_id, row.revision)
      : undefined;
  }

  reference(
    accountId: string,
    groupId: string,
    resId: string,
  ): string | undefined {
    return this.issue(accountId, groupId, resId);
  }

  resolve(
    ref: string,
    accountId: string,
    groupId: string,
  ): CustomFaceRecord | undefined {
    this.check();
    scope(accountId);
    scope(groupId);
    const parsed = this.parseToken(ref, 'cf', accountId, groupId);
    if (!parsed) {
      return;
    }
    const row = this.db
      .prepare(
        'SELECT * FROM custom_faces WHERE account_id=? AND resource_id=? AND revision=? AND retired=0',
      )
      .get(accountId, parsed.id, parsed.version) as Stored | undefined;
    return row ? fromRow(row) : undefined;
  }

  /** 立即在本地撤销所有群引用；这不代表QQ已确认删除。 */
  retire(
    accountId: string,
    resId: string,
    md5: string,
    expectedRevision?: number,
  ): boolean {
    this.check();
    scope(accountId);
    resourceId(resId);
    if (typeof md5 !== 'string' || !/^[a-f0-9]{32}(?![\s\S])/i.test(md5)) {
      FAIL('invalid_md5');
    }
    return this.transaction(() => {
      const row = this.row(accountId, resId);
      if (
        !row ||
        row.retired ||
        row.md5 !== md5.toLowerCase() ||
        (expectedRevision !== undefined && row.revision !== expectedRevision)
      ) {
        return false;
      }
      this.db
        .prepare(
          'UPDATE custom_faces SET retired=1,revision=? WHERE account_id=? AND res_id=?',
        )
        .run(nextRevision(row.revision), accountId, resId);
      return true;
    });
  }

  /** 仅在QQ确认描述修改后调用；本地标签另有方法。 */
  updateDescription(
    accountId: string,
    resId: string,
    value: string,
    expectedRevision?: number,
  ): boolean {
    this.check();
    scope(accountId);
    resourceId(resId);
    description(value);
    return this.transaction(() => {
      const row = this.row(accountId, resId);
      if (
        !row ||
        row.retired ||
        (expectedRevision !== undefined && row.revision !== expectedRevision)
      ) {
        return false;
      }
      if (row.description === value) {
        return true;
      }
      this.db
        .prepare(
          "UPDATE custom_faces SET description=?,tags='[]',revision=? WHERE account_id=? AND res_id=?",
        )
        .run(value, nextRevision(row.revision), accountId, resId);
      return true;
    });
  }

  /** 仅作本地搜索提示，不表示写入或同步了QQ上的描述。 */
  setLocalTags(
    accountId: string,
    resId: string,
    tags: string[],
    expectedRevision?: number,
  ): boolean {
    this.check();
    scope(accountId);
    resourceId(resId);
    const encoded = JSON.stringify(normalizeTags(tags));
    return this.transaction(() => {
      const row = this.row(accountId, resId);
      if (
        !row ||
        row.retired ||
        (expectedRevision !== undefined && row.revision !== expectedRevision)
      ) {
        return false;
      }
      if (row.tags === encoded) {
        return true;
      }
      this.db
        .prepare(
          'UPDATE custom_faces SET tags=?,revision=? WHERE account_id=? AND res_id=?',
        )
        .run(encoded, nextRevision(row.revision), accountId, resId);
      return true;
    });
  }

  list(
    accountId: string,
    groupId: string,
    options: CustomFaceListOptions = {},
  ): CustomFacePage {
    this.check();
    scope(accountId);
    scope(groupId);
    plain(options, ['query', 'limit', 'cursor'], []);
    const limit = options.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      FAIL('invalid_limit');
    }
    if (
      options.query !== undefined &&
      (typeof options.query !== 'string' ||
        Buffer.byteLength(options.query) > 512 ||
        /[\u0000-\u001f\u007f]/.test(options.query))
    ) {
      FAIL('invalid_query');
    }
    const query = (options.query ?? '').trim().normalize('NFKC').toLowerCase();
    return this.transaction(() => {
      const now = Date.now();
      let snapshot: Snapshot;
      let offset = 0;
      if (options.cursor !== undefined) {
        const parsed = this.parseToken(
          options.cursor,
          'cfc',
          accountId,
          groupId,
        );
        if (!parsed) {
          FAIL('invalid_cursor');
        }
        const stored = this.db
          .prepare(
            'SELECT * FROM custom_face_snapshots WHERE snapshot_id=? AND account_id=? AND group_id=?',
          )
          .get(parsed.id, accountId, groupId) as Snapshot | undefined;
        if (
          !stored ||
          now - stored.created_at > SNAPSHOT_AGE ||
          stored.created_at > now + 5000 ||
          (options.query !== undefined && stored.query !== query)
        ) {
          FAIL('invalid_cursor');
        }
        snapshot = stored;
        offset = parsed.version;
      } else {
        const rows = this.db
          .prepare(
            'SELECT * FROM custom_faces WHERE account_id=? AND retired=0 ORDER BY res_id',
          )
          .all(accountId) as Stored[];
        const members = rows
          .filter(
            (row) =>
              !query ||
              `${row.description}\n${(JSON.parse(row.tags) as string[]).join('\n')}`
                .normalize('NFKC')
                .toLowerCase()
                .includes(query),
          )
          .map((row) => ({ id: row.resource_id, revision: row.revision }));
        snapshot = {
          snapshot_id: randomUUID().replaceAll('-', ''),
          account_id: accountId,
          group_id: groupId,
          query,
          members: JSON.stringify(members),
          created_at: now,
        };
        // 过期快照全局清理；按数量淘汰只针对本账号本群，避免一个繁忙的群
        // 让其他群仍有效的游标失效。全局总量耗尽时拒绝新请求。
        this.db
          .prepare('DELETE FROM custom_face_snapshots WHERE created_at<?')
          .run(now - SNAPSHOT_AGE);
        this.db
          .prepare(
            'DELETE FROM custom_face_snapshots WHERE snapshot_id IN (SELECT snapshot_id FROM custom_face_snapshots WHERE account_id=? AND group_id=? ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET ?)',
          )
          .run(accountId, groupId, MAX_SNAPSHOTS - 1);
        if (
          Number(
            this.db
              .prepare('SELECT COUNT(*) AS total FROM custom_face_snapshots')
              .get()?.total,
          ) >= MAX_TOTAL_SNAPSHOTS
        ) {
          FAIL('resource_limit');
        }
        this.db
          .prepare('INSERT INTO custom_face_snapshots VALUES(?,?,?,?,?,?)')
          .run(
            snapshot.snapshot_id,
            accountId,
            groupId,
            query,
            snapshot.members,
            now,
          );
      }
      const members = JSON.parse(snapshot.members) as SnapshotMember[];
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > members.length
      ) {
        FAIL('invalid_cursor');
      }
      const items: CustomFaceListItem[] = [];
      let stale = 0;
      while (offset < members.length && items.length < limit) {
        const member = members[offset++]!;
        const row = this.db
          .prepare(
            'SELECT * FROM custom_faces WHERE account_id=? AND resource_id=? AND revision=? AND retired=0',
          )
          .get(accountId, member.id, member.revision) as Stored | undefined;
        if (!row) {
          stale++;
          continue;
        }
        items.push({
          face_ref: this.token(
            'cf',
            accountId,
            groupId,
            row.resource_id,
            row.revision,
          ),
          description: row.description,
          tags: JSON.parse(row.tags) as string[],
          revision: row.revision,
        });
      }
      return {
        items,
        coverage: 'observed_prefix',
        snapshot_count: members.length,
        stale_omitted: stale,
        ...(offset < members.length
          ? {
              next_cursor: this.token(
                'cfc',
                accountId,
                groupId,
                snapshot.snapshot_id,
                offset,
              ),
            }
          : {}),
      };
    });
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
}
