import test from 'node:test';
import { withFixtureModel } from '../../support/config-fixture.ts';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  symlinkSync,
  linkSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import {
  ConfigError,
  loadAppConfig,
  assertStoragePaths,
} from '../../../src/config/loader.ts';

function fixture(t: { after(fn: () => void): void }, source = '') {
  const dir = mkdtempSync(join(tmpdir(), 'group-policy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'prompts'));
  writeFileSync(join(dir, 'prompts/listener.md'), 'default persona');
  const config = (s: string) =>
    writeFileSync(
      join(dir, 'config.toml'),
      withFixtureModel('[bot]\nowner_id="778899"\n' + s),
    );
  config(source);
  return {
    dir,
    config,
    load: () =>
      loadAppConfig({
        configPath: join(dir, 'config.toml'),
        env: {
          ONEBOT_ACCESS_TOKEN: 'fixture-token',
          OPENAI_API_KEY: 'fixture-key',
        },
      }),
  };
}

test('symlink targets resolve physical dot-dot after each link even before destination creation', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.dir, 'real/inner'), { recursive: true });
  mkdirSync(join(f.dir, 'nested'));
  symlinkSync('real/inner', join(f.dir, 'link'));
  symlinkSync('link/../shared.sqlite', join(f.dir, 'relative.sqlite'));
  symlinkSync(f.dir + '/link/../shared.sqlite', join(f.dir, 'absolute.sqlite'));
  symlinkSync('../link', join(f.dir, 'nested/inner-link'));
  symlinkSync(
    'nested/inner-link/../shared.sqlite',
    join(f.dir, 'nested-relative.sqlite'),
  );
  symlinkSync(
    f.dir + '/nested/inner-link/../shared.sqlite',
    join(f.dir, 'nested-absolute.sqlite'),
  );
  for (const alias of [
    'relative.sqlite',
    'absolute.sqlite',
    'nested-relative.sqlite',
    'nested-absolute.sqlite',
  ]) {
    f.config(
      `[groups."11".storage]\ndatabase="${alias}"\n[groups."22".storage]\ndatabase="real/shared.sqlite"`,
    );
    assert.throws(() => f.load(), ConfigError, alias);
    assert.equal(existsSync(join(f.dir, 'real/shared.sqlite')), false);
  }
  symlinkSync('nested/../cycle-b', join(f.dir, 'cycle-a'));
  symlinkSync('cycle-a', join(f.dir, 'cycle-b'));
  f.config('[groups."11".storage]\ndatabase="cycle-a"');
  assert.throws(() => f.load(), ConfigError);
});

test('SQLite canonical-side companions are protected for every database and shared telemetry', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.dir, 'real'));
  for (const suffix of ['', '.events.sqlite', '.session.sqlite']) {
    const alias = 'alias.sqlite' + suffix,
      target = 'real/base.sqlite' + suffix;
    writeFileSync(join(f.dir, target), '');
    symlinkSync(target, join(f.dir, alias));
  }
  for (const dbSuffix of ['', '.events.sqlite', '.session.sqlite']) {
    for (const companion of ['-wal', '-shm', '-journal']) {
      f.config(
        `[groups."11".storage]\ndatabase="alias.sqlite"\n[groups."22".storage]\ndatabase="real/base.sqlite${dbSuffix}${companion}"`,
      );
      assert.throws(() => f.load(), ConfigError);
    }
  }
  for (const companion of ['-wal', '-shm', '-journal']) {
    f.config(
      `[storage]\ntelemetry_path="alias.sqlite"\n[groups."22".storage]\ndatabase="real/base.sqlite${companion}"`,
    );
    assert.throws(() => f.load(), ConfigError);
  }
  // Same-owner lexical/canonical companion aliases must not self-conflict.
  for (const companion of ['-wal', '-shm', '-journal']) {
    symlinkSync(
      'real/base.sqlite' + companion,
      join(f.dir, 'alias.sqlite' + companion),
    );
  }
  f.config('[groups."11".storage]\ndatabase="alias.sqlite"');
  assert.doesNotThrow(() => f.load());
  // A companion's own symlink is resolved too, not just its base database.
  symlinkSync('../other.sqlite', join(f.dir, 'real/base.sqlite-wal'));
  f.config(
    '[groups."11".storage]\ndatabase="alias.sqlite"\n[groups."22".storage]\ndatabase="other.sqlite"',
  );
  assert.throws(() => f.load(), ConfigError);
});

test('real SQLite journal appears beside canonical database and loader rejects its other-group binding', (t) => {
  const f = fixture(t);
  mkdirSync(join(f.dir, 'real'));
  const real = join(f.dir, 'real/base.sqlite');
  const seed = new DatabaseSync(real);
  seed.exec('CREATE TABLE evidence (value INTEGER)');
  seed.close();
  symlinkSync('real/base.sqlite', join(f.dir, 'alias.sqlite'));
  const db = new DatabaseSync(join(f.dir, 'alias.sqlite'));
  try {
    db.exec(
      'PRAGMA journal_mode=DELETE; BEGIN; INSERT INTO evidence VALUES (1)',
    );
    assert.equal(existsSync(real + '-journal'), true);
    assert.equal(existsSync(join(f.dir, 'alias.sqlite-journal')), false);
    f.config(
      '[groups."11".storage]\ndatabase="alias.sqlite"\n[groups."22".storage]\ndatabase="real/base.sqlite-journal"',
    );
    assert.throws(() => f.load(), ConfigError);
  } finally {
    db.exec('ROLLBACK');
    db.close();
  }
  // The guard does not rely on that journal already existing.
  assert.equal(existsSync(real + '-journal'), false);
  assert.throws(() => f.load(), ConfigError);
});

test('default false implements explicit whitelist and default true implements blacklist including unknown joined groups', (t) => {
  const f = fixture(t, '[groups."22"]\nenabled=true\n[groups."33"]');
  let c = f.load();
  assert.equal(c.defaultsEnabled, false);
  assert.deepEqual([...c.onebot.allowedGroups], ['22']);
  assert.equal(c.resolveGroup('22').enabled, true);
  assert.equal(c.resolveGroup('33').enabled, false);
  assert.equal(c.resolveGroup('44').enabled, false);
  f.config(
    '[defaults]\nenabled=true\n[groups."22"]\nenabled=false\n[groups."33"]',
  );
  c = f.load();
  assert.equal(c.defaultsEnabled, true);
  assert.equal(c.resolveGroup('22').enabled, false);
  assert.equal(c.resolveGroup('33').enabled, true);
  assert.equal(c.resolveGroup('44').enabled, true);
  assert.deepEqual([...c.onebot.allowedGroups], ['33']);
  assert.equal(c.onebot.allowPrivate, false);
});

test('dynamic resolution is stateless, identity validated and supports more than former 32 groups', (t) => {
  const f = fixture(
      t,
      '[defaults]\nenabled=true\n' +
        Array.from(
          { length: 40 },
          (_, i) => `[groups."${i + 1}"]\nenabled=false`,
        ).join('\n'),
    ),
    c = f.load();
  assert.equal(c.configuredGroupIds.length, 40);
  for (let i = 100; i < 140; i++) {
    assert.equal(
      c.resolveGroup(String(i)).storage.databasePath,
      join(f.dir, `data/groups/${i}/listener.sqlite`),
    );
  }
  assert.equal(c.configuredGroupIds.length, 40);
  assert.equal(c.onebot.allowedGroups.size, 0);
  assert.equal(existsSync(join(f.dir, 'data')), false);
  for (const value of [
    '0',
    '01',
    ' 22',
    '22 ',
    '-1',
    '+1',
    '1.0',
    'SENSITIVE',
    '__proto__',
    'constructor',
    '1'.repeat(33),
  ]) {
    assert.throws(
      () => c.resolveGroup(value),
      (e) => e instanceof ConfigError && !e.message.includes(value),
    );
    f.config(`[groups."${value}"]\nenabled=false`);
    assert.throws(
      () => f.load(),
      (e) => e instanceof ConfigError && !e.message.includes(value),
    );
  }
});

test('ordinary objects merge by field but random and tool union nodes replace as a whole', (t) => {
  const f = fixture(
    t,
    '[defaults]\nreply={mention=false,quote_bot=false,delay_ms=[1000,2000],random={probability=0.8,cooldown_ms=1000,max_per_minute=9}}\nexecution={max_tool_calls_per_wake=128,wake_timeout_ms=120000}\ntools={mute_member={mode="confirm",max_seconds=100},unmute_member="direct",view_images={mode="direct",max_download_mb=2}}\n[groups."22"]\nreply={mention=true,random={probability=0}}\nexecution.wake_timeout_ms=90000\ntools.mute_member="direct"\ntools.view_images={mode="direct",max_download_mb=5}\n[groups."33"]',
  );
  const c = f.load(),
    a = c.resolveGroup('22'),
    b = c.resolveGroup('33');
  assert.equal(a.reply.mention, true);
  assert.equal(a.reply.quoteBot, false);
  assert.deepEqual(a.reply.delayMs, [1000, 2000]);
  assert.deepEqual(a.reply.random, {
    probability: 0,
    cooldownMs: 60000,
    maxPerMinute: 2,
  });
  assert.deepEqual(a.execution, {
    maxToolCallsPerWake: 128,
    wakeTimeoutMs: 90000,
  });
  assert.deepEqual(a.tools.mute_member, {
    mode: 'direct',
    maxSeconds: 2592000,
  });
  assert.equal(a.tools.unmute_member.mode, 'direct');
  assert.deepEqual(a.tools.view_images, { mode: 'direct', maxDownloadMb: 5 });
  a.reply.mention = false;
  a.tools.mute_member.mode = 'off';
  assert.equal(c.resolveGroup('22').reply.mention, true);
  assert.equal(b.tools.mute_member.mode, 'confirm');
  assert.equal(c.resolveGroup('44').tools.mute_member.maxSeconds, 100);
});

test('disabled groups reject app-only keys, old schemas, typos and bad value types', (t) => {
  const f = fixture(t);
  for (const field of [
    'bot',
    'owner_id',
    'owner_name',
    'name',
    'model',
    'onebot',
    'logging',
    'runtime',
    'ai',
    'memory',
    'images',
    'forward',
    'attention',
    'group_id',
  ]) {
    f.config(`[groups."22"]\nenabled=false\n${field}="SENSITIVE"`);
    assert.throws(
      () => f.load(),
      (e) => e instanceof ConfigError && !e.message.includes('SENSITIVE'),
    );
  }
  for (const section of [
    'reply',
    'session',
    'execution',
    'tools',
    'messages',
    'observation',
    'confirmation',
    'history',
    'storage',
  ]) {
    f.config(
      `[groups."22"]\nenabled=false\n[groups."22".${section}]\nSENSITIVE_FIELD="SENSITIVE"`,
    );
    assert.throws(
      () => f.load(),
      (e) => e instanceof ConfigError && !e.message.includes('SENSITIVE'),
    );
  }
  for (const value of ['true', '[]', '42', '"secret"']) {
    for (const field of ['reply', 'tools', 'storage', 'session', 'execution']) {
      f.config(`[groups."22"]\nenabled=false\n${field}=${value}`);
      assert.throws(() => f.load(), ConfigError);
    }
  }
});

test('persona is an entire file replacement, also validated for disabled groups', (t) => {
  const f = fixture(t, '[groups."22"]\npersona="group.md"');
  writeFileSync(join(f.dir, 'group.md'), 'replacement');
  const c = f.load();
  assert.equal(c.resolveGroup('22').persona, 'replacement');
  assert.equal(c.resolveGroup('33').persona, 'default persona');
  for (const data of ['', Buffer.alloc(16385, 65), Buffer.from([0xff])]) {
    writeFileSync(join(f.dir, 'group.md'), data);
    assert.throws(() => f.load(), ConfigError);
  }
  writeFileSync(join(f.dir, 'group.md'), Buffer.alloc(16384, 65));
  assert.equal(f.load().resolveGroup('22').persona.length, 16384);
  for (const source of [
    'persona="SENSITIVE_MISSING"',
    'persona="prompts"',
    'persona={file="group.md"}',
    '[groups."22".persona]\nappend_file="group.md"',
  ]) {
    f.config(`[groups."22"]\nenabled=false\n${source}`);
    assert.throws(
      () => f.load(),
      (e) =>
        e instanceof ConfigError && !e.message.includes('SENSITIVE_MISSING'),
    );
  }
});

test('explicit database paths retain old bytes and no parser call creates directories or files', (t) => {
  const f = fixture(
    t,
    '[storage]\ndirectory="state"\n[groups."22".storage]\ndatabase="old.db"',
  );
  writeFileSync(join(f.dir, 'old.db'), 'old identity');
  const c = f.load();
  assert.equal(
    c.resolveGroup('22').storage.databasePath,
    join(f.dir, 'old.db'),
  );
  assert.equal(
    c.resolveGroup('33').storage.databasePath,
    join(f.dir, 'state/groups/33/listener.sqlite'),
  );
  assert.equal(readFileSync(join(f.dir, 'old.db'), 'utf8'), 'old identity');
  assert.equal(existsSync(join(f.dir, 'state')), false);
});

test('lexical, world/session sibling, SQLite sidecar and shared telemetry/registry collisions are all rejected', (t) => {
  const f = fixture(t);
  for (const suffix of [
    '',
    '.events.sqlite',
    '.session.sqlite',
    '-wal',
    '-shm',
    '-journal',
    '.events.sqlite-wal',
    '.session.sqlite-shm',
  ]) {
    f.config(
      `[groups."22".storage]\ndatabase="same.db"\n[groups."33".storage]\ndatabase="sub/../same.db${suffix}"`,
    );
    assert.throws(() => f.load(), ConfigError, suffix);
  }
  for (const field of ['telemetry_path', 'registry_path']) {
    for (const suffix of [
      '',
      '.events.sqlite',
      '.session.sqlite',
      '-wal',
      '.events.sqlite-journal',
    ]) {
      f.config(
        `[storage]\n${field}="same.db${suffix}"\n[groups."22".storage]\ndatabase="same.db"`,
      );
      assert.throws(() => f.load(), ConfigError);
    }
  }
  f.config('[storage]\ntelemetry_path="same.db"\nregistry_path="same.db-wal"');
  assert.throws(() => f.load(), ConfigError);
  f.config(
    '[groups."22".storage]\ndatabase="same.db"\n[groups."33".storage]\ndatabase="same.db/nested"',
  );
  assert.throws(() => f.load(), ConfigError);
});

test('hardlink/symlink aliases including ancestors and dangling links cannot retarget storage silently', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dir, 'first.db'), 'unchanged');
  linkSync(join(f.dir, 'first.db'), join(f.dir, 'hard.db'));
  symlinkSync(join(f.dir, 'first.db'), join(f.dir, 'symbolic.db'));
  for (const alias of ['hard.db', 'symbolic.db']) {
    f.config(
      `[groups."22".storage]\ndatabase="first.db"\n[groups."33".storage]\ndatabase="${alias}"`,
    );
    assert.throws(() => f.load(), ConfigError);
  }
  mkdirSync(join(f.dir, 'real'));
  symlinkSync(join(f.dir, 'real'), join(f.dir, 'alias'));
  f.config(
    '[groups."22".storage]\ndatabase="real/new/nested.db"\n[groups."33".storage]\ndatabase="alias/new/nested.db"',
  );
  assert.throws(() => f.load(), ConfigError);
  symlinkSync('missing.db', join(f.dir, 'dangling.db'));
  f.config(
    '[groups."22".storage]\ndatabase="missing.db"\n[groups."33".storage]\ndatabase="dangling.db"',
  );
  assert.throws(() => f.load(), ConfigError);
  symlinkSync('loop', join(f.dir, 'loop'));
  f.config('[groups."22".storage]\ndatabase="loop/db"');
  assert.throws(() => f.load(), ConfigError);
  assert.equal(readFileSync(join(f.dir, 'first.db'), 'utf8'), 'unchanged');
  assert.equal(existsSync(join(f.dir, 'real/new')), false);
});

test('shared path hardlink and symlink collisions remain errors with disabled explicit groups', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.dir, 'first.db'), 'untouched');
  linkSync(join(f.dir, 'first.db'), join(f.dir, 'registry.json'));
  f.config(
    '[storage]\nregistry_path="registry.json"\n[groups."22"]\nenabled=false\nstorage.database="first.db"',
  );
  assert.throws(() => f.load(), ConfigError);
  f.config(
    '[groups."22"]\nenabled=false\nstorage.database="first.db"\n[groups."33"]\nenabled=false\nstorage.database="first.db"',
  );
  assert.throws(() => f.load(), ConfigError);
});

test('dynamic storage validation includes retained unknown groups without expanding admission scope', (t) => {
  const f = fixture(
    t,
    '[defaults]\nenabled=true\nstorage.database="shared.db"',
  );
  const c = f.load(),
    a = c.resolveGroup('22'),
    b = c.resolveGroup('33');
  assert.throws(() => assertStoragePaths(c.storage, [a, b]), ConfigError);
  assert.equal(c.configuredGroupIds.length, 0);
  assert.equal(c.onebot.allowedGroups.size, 0);
  f.config(
    '[defaults]\nenabled=true\n[groups."22".storage]\ndatabase="data/groups/33/listener.sqlite"',
  );
  const d = f.load();
  assert.throws(() => d.resolveGroup('33'), ConfigError);
});
