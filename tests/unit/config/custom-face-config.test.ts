import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAppConfig } from '../../../src/config/loader.ts';
import {
  applyToolPolicies,
  toListenerConfig,
} from '../../../src/config/runtime.ts';
import { inspectGroupConfig } from '../../../src/config/inspect.ts';
import { buildToolDefinitions } from '../../../src/agent/tool-definitions.ts';
import { buildCustomFaceToolDefinitions } from '../../../src/tools/custom-faces/tools.ts';
import {
  TOOL_CAPABILITIES,
  TOOL_NAMES,
} from '../../../src/config/tool-policy.ts';
import { enabledExtendedTools } from '../../../src/config/extended-tools.ts';

const GROUP = '100000002',
  OTHER_GROUP = '100000003';
const ALL = [
  'list_custom_faces',
  'view_custom_face',
  'send_custom_face',
  'add_custom_face',
  'delete_custom_face',
  'set_custom_face_description',
] as const;
const READONLY = ['list_custom_faces', 'view_custom_face'] as const;
const WRITES = [
  'send_custom_face',
  'add_custom_face',
  'delete_custom_face',
  'set_custom_face_description',
] as const;
const DATABASES = [
  'custom-faces.sqlite',
  'custom-face-operations.sqlite',
  'sandbox.sqlite',
];
const SUFFIXES = ['', '-wal', '-shm', '-journal'];

function fixture(
  t: { after(fn: () => void): void },
  input: { storage?: string; defaults?: string; groups?: string } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'qqbot-custom-face-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, 'config.toml');
  writeFileSync(join(root, 'persona.md'), 'Synthetic fixture persona');
  writeFileSync(
    configPath,
    `[bot]\nowner_id="100000001"\n[model]\nmodel="fixture-model"\n[logging]\nfile=false\n${input.storage !== undefined ? `[storage]\n${input.storage}\n` : ''}[defaults]\npersona="persona.md"\n${input.defaults ?? ''}\n${input.groups ?? ''}\n`,
  );
  const load = () =>
    loadAppConfig({
      configPath,
      env: {
        ONEBOT_ACCESS_TOKEN: 'fixture-token',
        OPENAI_API_KEY: 'fixture-key',
      },
    });
  return { root, configPath, load };
}

test('six favorite tools default direct without implicitly enabling any group or low-level registry', (t) => {
  const f = fixture(t),
    app = f.load(),
    group = app.resolveGroup(GROUP);
  assert.equal(app.defaultsEnabled, false);
  assert.equal(group.enabled, false);
  assert.equal(TOOL_NAMES.length, 61);
  assert.equal(
    TOOL_NAMES.filter(
      (name) => TOOL_CAPABILITIES[name].defaultMode === 'direct',
    ).length,
    42,
  );
  assert.equal(
    TOOL_NAMES.filter(
      (name) => TOOL_CAPABILITIES[name].defaultMode === 'confirm',
    ).length,
    18,
  );
  assert.equal(
    TOOL_NAMES.filter((name) => TOOL_CAPABILITIES[name].defaultMode === 'off')
      .length,
    1,
  );
  const sources = inspectGroupConfig(app, GROUP).sources as Record<
    string,
    string
  >;
  for (const name of ALL) {
    assert.equal(group.tools[name].mode, 'direct', name);
    assert.equal(TOOL_CAPABILITIES[name].defaultMode, 'direct', name);
    assert.equal(sources[`tools.${name}`], 'program_default', name);
  }
  for (const name of READONLY) {
    assert.equal(TOOL_CAPABILITIES[name].confirm, false, name);
  }
  for (const name of WRITES) {
    assert.equal(TOOL_CAPABILITIES[name].confirm, true, name);
  }
  assert.deepEqual(enabledExtendedTools(), []);
  assert.deepEqual(buildCustomFaceToolDefinitions(), []);
  assert.equal(
    existsSync(join(f.root, 'data')),
    false,
    'configuration/schema inspection cannot create storage',
  );
});

test('four favorite writes allow confirm while readonly confirmation is rejected', (t) => {
  const f = fixture(t, {
    defaults: `[defaults.tools]\n${WRITES.map((name) => `${name}="confirm"`).join('\n')}`,
  });
  const app = f.load(),
    group = app.resolveGroup(GROUP);
  const definitions = buildToolDefinitions(toListenerConfig(app, group), true);
  for (const name of WRITES) {
    assert.equal(group.tools[name].mode, 'confirm');
    assert.match(
      definitions.find((tool) => tool.function.name === name)!.function
        .description,
      /confirm|确认/,
    );
  }
  for (const name of READONLY) {
    const bad = fixture(t, { defaults: `[defaults.tools]\n${name}="confirm"` });
    assert.throws(bad.load, new RegExp(name));
    const objectMode = fixture(t, {
      defaults: `[defaults.tools]\n${name}={mode="confirm"}`,
    });
    assert.throws(objectMode.load, new RegExp(name));
  }
});

test('explicit off survives defaults and only the selected group override re-enables a capability', (t) => {
  const f = fixture(t, {
    defaults: `[defaults.tools]\n${ALL.map((name) => `${name}="off"`).join('\n')}`,
    groups: `[groups."${GROUP}"]\nenabled=true\ntools.view_custom_face="direct"\ntools.add_custom_face="confirm"\n[groups."${OTHER_GROUP}"]\nenabled=true`,
  });
  const app = f.load(),
    group = app.resolveGroup(GROUP),
    other = app.resolveGroup(OTHER_GROUP);
  for (const name of ALL) {
    assert.equal(other.tools[name].mode, 'off', name);
  }
  assert.equal(group.tools.view_custom_face.mode, 'direct');
  assert.equal(group.tools.add_custom_face.mode, 'confirm');
  for (const name of ALL.filter(
    (name) => name !== 'view_custom_face' && name !== 'add_custom_face',
  )) {
    assert.equal(group.tools[name].mode, 'off', name);
  }
  const names = buildToolDefinitions(toListenerConfig(app, group), true).map(
    (tool) => tool.function.name,
  );
  assert.deepEqual(
    ALL.filter((name) => names.includes(name)),
    ['view_custom_face', 'add_custom_face'],
  );
  const sources = inspectGroupConfig(app, GROUP).sources as Record<
    string,
    string
  >;
  assert.equal(sources['tools.view_custom_face'], 'group');
  assert.equal(sources['tools.delete_custom_face'], 'defaults');
});

test('favorite view permission is independent while the existing image parameters supply shared limits', (t) => {
  const configured = fixture(t, {
    defaults: 'tools.view_images={mode="direct",max_download_mb=2}',
  }).load();
  const first = applyToolPolicies(
    toListenerConfig(configured, configured.resolveGroup(GROUP)),
  );
  assert.equal(first.images.maxDownloadMb, 2);
  assert.equal(first.tools.extended?.view_custom_face, 'direct');
  const disabled = fixture(t, { defaults: 'tools.view_images="off"' }).load();
  const second = applyToolPolicies(
    toListenerConfig(disabled, disabled.resolveGroup(GROUP)),
  );
  assert.equal(second.images.enabled, false);
  assert.equal(second.images.maxDownloadMb, 10);
  const names = buildToolDefinitions(second, true).map(
    (tool) => tool.function.name,
  );
  assert.equal(names.includes('view_images'), false);
  assert.equal(names.includes('view_custom_face'), true);
  const wrongPlace = fixture(t, {
    defaults: 'tools.view_custom_face={mode="direct",max_per_turn=1}',
  });
  assert.throws(wrongPlace.load, /view_custom_face/);
});

test('two original-directory paths resolve deliberately without creating files', (t) => {
  const f = fixture(t),
    app = f.load();
  assert.equal(
    app.storage.customFaceDirectory,
    join(f.root, 'data', 'custom-face-originals'),
  );
  assert.equal(
    app.storage.napcatCustomFaceDirectory,
    app.storage.customFaceDirectory,
  );
  assert.equal(existsSync(join(f.root, 'data')), false);
  const custom = fixture(t, {
    storage:
      'directory="state"\ncustom_face_directory="assets/originals"\nnapcat_custom_face_directory="/opt/qqbot/shared-faces"',
  });
  const selected = custom.load();
  assert.equal(selected.storage.directory, join(custom.root, 'state'));
  assert.equal(
    selected.storage.customFaceDirectory,
    join(custom.root, 'assets', 'originals'),
  );
  assert.equal(
    selected.storage.napcatCustomFaceDirectory,
    '/opt/qqbot/shared-faces',
  );
  assert.equal(existsSync(join(custom.root, 'assets')), false);
  const directoryOnly = fixture(t, { storage: 'directory="state"' });
  assert.equal(
    directoryOnly.load().storage.customFaceDirectory,
    join(directoryOnly.root, 'state', 'custom-face-originals'),
  );
});

test('artifact directory pair defaults beside storage and validates the NapCat side', (t) => {
  const f = fixture(t),
    app = f.load();
  assert.equal(
    app.storage.artifactDirectory,
    join(f.root, 'data', 'artifacts'),
  );
  assert.equal(
    app.storage.napcatArtifactDirectory,
    app.storage.artifactDirectory,
  );
  const custom = fixture(t, {
    storage:
      'artifact_directory="shared/art"\nnapcat_artifact_directory="/app/art"',
  }).load();
  assert.equal(
    custom.storage.artifactDirectory,
    join(custom.configPath, '..', 'shared', 'art'),
  );
  assert.equal(custom.storage.napcatArtifactDirectory, '/app/art');
  for (const value of ['', '/', 'relative', '/a/../b', '/a\\b']) {
    assert.throws(
      fixture(t, {
        storage: `napcat_artifact_directory=${JSON.stringify(value)}`,
      }).load,
      /napcat_artifact_directory/,
      value,
    );
  }
  assert.throws(
    fixture(t, { storage: 'artifact_directory="data/custom-face-originals"' })
      .load,
    /artifact_directory/,
  );
});

test('NapCat directory must be a dedicated absolute POSIX path, not a relative or traversing path', (t) => {
  for (const value of [
    '',
    '/',
    'relative/faces',
    '/opt/../faces',
    '/opt/./faces',
    'C:\\faces',
    '/opt\\faces',
  ]) {
    const f = fixture(t, {
      storage: `napcat_custom_face_directory=${JSON.stringify(value)}`,
    });
    assert.throws(f.load, /napcat_custom_face_directory/, value);
  }
  const badHost = fixture(t, { storage: 'custom_face_directory=""' });
  assert.throws(badHost.load, /custom_face_directory/);
  const misplaced = fixture(t, {
    defaults: 'storage.custom_face_directory="faces"',
  });
  assert.throws(misplaced.load, /defaults\.storage.*未知字段/);
  const forbiddenDatabaseOption = fixture(t, {
    storage: 'custom_face_database="faces.sqlite"',
  });
  assert.throws(forbiddenDatabaseOption.load, /storage.*未知字段/);
});

test('both derived global databases and every SQLite companion are reserved against group files', (t) => {
  for (const database of DATABASES) {
    for (const suffix of SUFFIXES) {
      const f = fixture(t, {
        groups: `[groups."${GROUP}"]\nenabled=false\nstorage.database="data/${database}${suffix}"`,
      });
      assert.throws(f.load, /冲突/, `${database}${suffix}`);
    }
  }
});

test('telemetry and registry cannot alias either global favorite database or its companions', (t) => {
  for (const field of ['telemetry_path', 'registry_path']) {
    for (const database of DATABASES) {
      for (const suffix of SUFFIXES) {
        const f = fixture(t, {
          storage: `${field}="data/${database}${suffix}"`,
        });
        assert.throws(f.load, /冲突/, `${field}: ${database}${suffix}`);
      }
    }
  }
});

test('symlink and hardlink aliases of global favorite storage cannot evade collision detection', (t) => {
  for (const method of ['symlink', 'hardlink'] as const) {
    const f = fixture(t, {
      groups: `[groups."${GROUP}"]\nenabled=true\nstorage.database="alias.sqlite"`,
    });
    mkdirSync(join(f.root, 'data'));
    const main = join(f.root, 'data', 'custom-faces.sqlite');
    writeFileSync(
      main,
      'Synthetic storage-path fixture, not a production database.',
    );
    if (method === 'symlink') {
      symlinkSync(main, join(f.root, 'alias.sqlite'));
    } else {
      linkSync(main, join(f.root, 'alias.sqlite'));
    }
    assert.throws(f.load, /冲突/);
    assert.equal(
      readFileSync(main, 'utf8'),
      'Synthetic storage-path fixture, not a production database.',
    );
  }
});

test('originals directory cannot contain, equal or live below reserved storage files', (t) => {
  for (const value of [
    'data',
    'data/telemetry.sqlite',
    'data/group-registry.json',
    ...DATABASES.flatMap((name) =>
      SUFFIXES.map((suffix) => `data/${name}${suffix}`),
    ),
    'data/custom-faces.sqlite/inside',
  ]) {
    const f = fixture(t, {
      storage: `custom_face_directory=${JSON.stringify(value)}`,
    });
    assert.throws(f.load, /storage|存储|目录/, value);
  }
  const contained = fixture(t, {
    storage: 'telemetry_path="data/custom-face-originals/usage.sqlite"',
  });
  assert.throws(contained.load, /custom_face_directory/);
  const groupContained = fixture(t, {
    groups: `[groups."${GROUP}"]\nenabled=true\nstorage.database="data/custom-face-originals/listener.sqlite"`,
  });
  assert.throws(groupContained.load, /custom_face_directory/);
});

test('originals directory rejects an ordinary file or symlink even when not aliasing any database', (t) => {
  const file = fixture(t, {
    storage: 'custom_face_directory="not-a-directory"',
  });
  writeFileSync(join(file.root, 'not-a-directory'), 'Synthetic fixture');
  assert.throws(file.load, /custom_face_directory/);
  const link = fixture(t, {
    storage: 'custom_face_directory="originals-link"',
  });
  mkdirSync(join(link.root, 'actual-originals'));
  symlinkSync(
    join(link.root, 'actual-originals'),
    join(link.root, 'originals-link'),
  );
  assert.throws(link.load, /custom_face_directory/);
});

test('public custom-face usage documents the actual six schemas rather than native ID parameters', () => {
  const definitions = buildCustomFaceToolDefinitions(ALL);
  const expected: Record<string, { keys: string[]; required: string[] }> = {
    list_custom_faces: { keys: ['cursor', 'limit', 'query'], required: [] },
    view_custom_face: { keys: ['face_ref'], required: ['face_ref'] },
    send_custom_face: { keys: ['face_ref'], required: ['face_ref'] },
    add_custom_face: {
      keys: ['description', 'image_id', 'tags'],
      required: ['description', 'image_id'],
    },
    delete_custom_face: { keys: ['face_ref'], required: ['face_ref'] },
    set_custom_face_description: {
      keys: ['description', 'face_ref', 'tags'],
      required: ['description', 'face_ref'],
    },
  };
  const doc = readFileSync(
    new URL('../../../docs/configuration.md', import.meta.url),
    'utf8',
  );
  for (const def of definitions) {
    const schema = def.function.parameters as {
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties: boolean;
    };
    assert.deepEqual(
      Object.keys(schema.properties).sort(),
      expected[def.function.name]!.keys,
    );
    assert.deepEqual(
      [...schema.required].sort(),
      expected[def.function.name]!.required,
    );
    assert.equal(schema.additionalProperties, false);
    assert.ok(doc.includes(`| \`${def.function.name}\` |`));
  }
  assert.match(doc, /账号.*共享收藏|共享收藏.*账号/);
  assert.match(doc, /observed_prefix/);
  assert.match(doc, /directory_complete=false/);
  assert.match(doc, /不是QQ.*字段|不是QQ服务端标签/);
  assert.match(doc, /首帧/);
  assert.match(doc, /APNG/);
  assert.match(doc, /512帧/);
  assert.match(doc, /512MiB/);
  assert.match(doc, /4096个文件/);
  assert.match(doc, /不做TTL清理/);
});
