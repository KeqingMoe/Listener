import { constants, closeSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve, parse } from 'node:path';
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const SESSION_COOKIE = 'dashboard_session';
const TTL = 7 * 86400000;

export function validPassword(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length >= 12 &&
    Buffer.byteLength(value) <= 256 &&
    !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/u.test(value)
  );
}

function hash(password: string, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex')}`;
}

function verify(password: string, stored: string) {
  const [salt, digest] = stored.split(':');
  if (!salt || !digest || !/^[a-f0-9]{128}$/.test(digest)) {
    throw new Error('Invalid auth database');
  }
  return timingSafeEqual(
    Buffer.from(hash(password, salt).split(':')[1]!, 'hex'),
    Buffer.from(digest, 'hex'),
  );
}

function directories(path: string) {
  const parent = dirname(resolve(path));
  const parts = parent
    .slice(parse(parent).root.length)
    .split('/')
    .filter(Boolean);
  let current = parse(parent).root;
  for (const part of parts) {
    current = resolve(current, part);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    const stat = lstatSync(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      ((stat.mode & 0o022) !== 0 && !(stat.uid === 0 && stat.mode & 0o1000))
    ) {
      throw new Error('Unsafe auth directory');
    }
  }
}

function privateFile(path: string, optional = false) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error('Unsafe auth file');
  }
  return stat;
}

export interface AuthOptions {
  path: string;
  /** Snapshot of DASHBOARD_PASSWORD loaded at process startup. Never read from the database. */
  password?: string;
  secureCookie?: boolean;
  now?: () => number;
}

export type LoginResult =
  | { status: 'ok'; token: string }
  | {
      status:
        | 'invalid'
        | 'limited'
        | 'password_not_configured'
        | 'password_invalid_configuration';
    };

export class AuthStore {
  readonly secureCookie: boolean;
  private readonly passwordHash: string | undefined;
  private readonly invalidConfiguration: boolean;
  get configured() {
    return this.passwordHash !== undefined;
  }

  get configurationError() {
    return this.invalidConfiguration
      ? ('password_invalid_configuration' as const)
      : ('password_not_configured' as const);
  }

  private readonly path: string;
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly identity: { dev: number; ino: number };
  private readonly attempts = new Map<
    string,
    { start: number; count: number }
  >();

  private global = { start: 0, count: 0 };
  constructor(options: AuthOptions) {
    this.path = resolve(options.path);
    this.secureCookie = options.secureCookie ?? false;
    this.now = options.now ?? Date.now;
    directories(this.path);
    try {
      const fd = openSync(
        this.path,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      closeSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    this.identity = privateFile(this.path)!;
    this.boundary();
    this.db = new DatabaseSync(this.path);
    this.invalidConfiguration =
      !!options.password && !validPassword(options.password);
    try {
      this.db.exec(
        'PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=3000; PRAGMA trusted_schema=OFF; CREATE TABLE IF NOT EXISTS environment_credential(id INTEGER PRIMARY KEY CHECK(id=1), password_hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions(digest TEXT PRIMARY KEY, expires INTEGER NOT NULL);',
      );
      this.db.exec('BEGIN IMMEDIATE');
      try {
        // Legacy account credentials are never consulted, even during migration.
        this.db.exec('DROP TABLE IF EXISTS account');
        const previous = this.credential();
        if (validPassword(options.password)) {
          this.passwordHash =
            previous && verify(options.password, previous)
              ? previous
              : hash(options.password);
        }
        if (!this.passwordHash || this.passwordHash !== previous) {
          this.db.exec(
            'DELETE FROM sessions; DELETE FROM environment_credential',
          );
          if (this.passwordHash) {
            this.db
              .prepare('INSERT INTO environment_credential VALUES(1,?)')
              .run(this.passwordHash);
          }
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private boundary() {
    directories(this.path);
    const stat = privateFile(this.path)!;
    if (stat.dev !== this.identity.dev || stat.ino !== this.identity.ino) {
      throw new Error('Auth file replaced');
    }
    for (const suffix of ['-journal', '-wal', '-shm']) {
      privateFile(this.path + suffix, true);
    }
  }

  private credential() {
    return (
      this.db
        .prepare('SELECT password_hash FROM environment_credential WHERE id=1')
        .get() as { password_hash: string } | undefined
    )?.password_hash;
  }

  private digest(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private permit(ip: string) {
    const now = this.now();
    if (now - this.global.start >= 60000) {
      this.global = { start: now, count: 0 };
    }
    for (const [key, value] of this.attempts) {
      if (now - value.start >= 60000) {
        this.attempts.delete(key);
      }
    }
    if (this.global.count >= 40) {
      return false;
    }
    this.global.count++;
    let entry = this.attempts.get(ip);
    if (!entry) {
      if (this.attempts.size >= 1024) {
        return false;
      }
      entry = { start: now, count: 0 };
      this.attempts.set(ip, entry);
    }
    if (entry.count >= 5) {
      return false;
    }
    entry.count++;
    return true;
  }

  login(password: unknown, ip: string): LoginResult {
    if (!this.configured) {
      return { status: this.configurationError };
    }
    if (!this.permit(ip)) {
      return { status: 'limited' };
    }
    this.boundary();
    if (!validPassword(password)) {
      return { status: 'invalid' };
    }
    // Serialize issuance with startup credential changes in another process.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (
        this.credential() !== this.passwordHash ||
        !verify(password, this.passwordHash!)
      ) {
        this.db.exec('ROLLBACK');
        return { status: 'invalid' };
      }
      const token = randomBytes(32).toString('base64url');
      this.db.prepare('DELETE FROM sessions WHERE expires<=?').run(this.now());
      this.db.exec(
        'DELETE FROM sessions WHERE digest IN (SELECT digest FROM sessions ORDER BY expires DESC LIMIT -1 OFFSET 127)',
      );
      this.db
        .prepare('INSERT INTO sessions VALUES(?,?)')
        .run(this.digest(token), this.now() + TTL);
      this.db.exec('COMMIT');
      return { status: 'ok', token };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  authenticated(token: string | undefined): boolean {
    if (!this.configured || !token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      return false;
    }
    this.boundary();
    if (this.credential() !== this.passwordHash) {
      return false;
    }
    return !!this.db
      .prepare('SELECT 1 FROM sessions WHERE digest=? AND expires>?')
      .get(this.digest(token), this.now());
  }

  logout(token: string | undefined) {
    this.boundary();
    if (token) {
      this.db
        .prepare('DELETE FROM sessions WHERE digest=?')
        .run(this.digest(token));
    }
  }

  cookie(token?: string) {
    return `${SESSION_COOKIE}=${token ?? ''}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? TTL / 1000 : 0}${this.secureCookie ? '; Secure' : ''}`;
  }

  close() {
    this.db.close();
  }
}

export function sessionToken(cookie: string | undefined) {
  const values = (cookie ?? '')
    .split(';')
    .map((v) => v.trim())
    .filter((v) => v.startsWith(SESSION_COOKIE + '='));
  return values.length === 1
    ? values[0]!.slice(SESSION_COOKIE.length + 1)
    : undefined;
}
