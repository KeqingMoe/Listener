import { lstatSync, readlinkSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AppConfig, ResolvedGroupConfig } from './app.ts';
import { ConfigError, configFail as fail } from './errors.ts';

function canonicalStoragePath(
  path: string,
  field: string,
  depth = 0,
  cache = new Map<string, string>(),
): string {
  if (depth > 40) {
    return fail(field, '无法核验存储路径');
  }
  // 逐段解析而不是先规范化：内核会先解引用每个符号链接再应用后面的`..`，
  // 即使最终文件不存在也是如此，所以链接目标里的`.`/`..`必须保留到解析时处理。
  const parts = path.split('/').filter(Boolean);
  let current = '/';
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === '.') {
      continue;
    }
    if (part === '..') {
      current = dirname(current);
      continue;
    }
    current = current === '/' ? '/' + part : current + '/' + part;
    const original = current;
    const known = cache.get(original);
    if (known !== undefined) {
      current = known;
      continue;
    }
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(current);
        current = canonicalStoragePath(
          target.startsWith('/') ? target : dirname(current) + '/' + target,
          field,
          depth + 1,
          cache,
        );
      } else if (i < parts.length - 1 && !stat.isDirectory()) {
        fail(field, '存储路径父目录无效');
      }
    } catch (error) {
      if (error instanceof ConfigError) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        fail(field, '无法核验存储路径');
      }
    }
    cache.set(original, current);
  }
  return current;
}

/**
 * 检查所有存储路径（含SQLite的-wal/-shm/-journal伴随文件）在路径名和inode上互不冲突、互不嵌套。
 * 动态加入新群时，须在打开数据库前对保留的群加上新候选群再调用一次。不修改、不枚举目录、不创建文件。
 */
export function assertStoragePaths(
  storage: AppConfig['storage'],
  groups: readonly ResolvedGroupConfig[],
): void {
  const canonicalCache = new Map<string, string>();
  const databases = [
    { path: storage.telemetryPath, field: 'storage.telemetry_path' },
    {
      path: resolve(storage.directory, 'custom-faces.sqlite'),
      field: 'storage.directory',
    },
    {
      path: resolve(storage.directory, 'custom-face-operations.sqlite'),
      field: 'storage.directory',
    },
    {
      path: resolve(storage.directory, 'reminders.sqlite'),
      field: 'storage.directory',
    },
    {
      path: resolve(storage.directory, 'sandbox.sqlite'),
      field: 'storage.directory',
    },
    {
      path: resolve(storage.directory, 'artifacts.sqlite'),
      field: 'storage.directory',
    },
  ];
  for (const group of groups) {
    for (const path of [
      group.storage.databasePath,
      group.storage.databasePath + '.events.sqlite',
      group.storage.databasePath + '.session.sqlite',
    ]) {
      databases.push({ path, field: 'groups.storage.database' });
    }
  }
  const paths: Array<{ path: string; field: string; owner: string }> = [
    {
      path: storage.registryPath,
      field: 'storage.registry_path',
      owner: 'registry',
    },
  ];
  databases.forEach(({ path, field }, index) => {
    const canonical = canonicalStoragePath(path, field, 0, canonicalCache);
    paths.push({ path, field, owner: `${index}:main` });
    // SQLite把伴随文件放在主数据库的规范路径旁。两种写法都要占位，
    // 但视为同一个物理文件的别名（owner相同），不算冲突。
    for (const suffix of ['-wal', '-shm', '-journal']) {
      for (const base of new Set([path, canonical])) {
        paths.push({ path: base + suffix, field, owner: `${index}:${suffix}` });
      }
    }
  });
  const names = new Map<string, string>(),
    inodes = new Map<string, string>();
  for (const { path, field, owner } of paths) {
    const canonical = canonicalStoragePath(path, field, 0, canonicalCache);
    if (names.has(canonical) && names.get(canonical) !== owner) {
      fail(field, '存储文件路径发生冲突');
    }
    names.set(canonical, owner);
    try {
      const stat = statSync(path, { bigint: true });
      if (!stat.isFile()) {
        fail(field, '存储路径必须是普通文件');
      }
      const identity = `${stat.dev}:${stat.ino}`;
      if (inodes.has(identity) && inodes.get(identity) !== owner) {
        fail(field, '存储文件路径发生冲突');
      }
      inodes.set(identity, owner);
    } catch (error) {
      if (error instanceof ConfigError) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        fail(field, '无法核验存储路径');
      }
    }
  }
  const ordered = [...names.keys()].map((path) => path + '/').sort();
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i]!.startsWith(ordered[i - 1]!)) {
      fail('storage', '存储文件与父路径冲突');
    }
  }
  const originals = canonicalStoragePath(
    storage.customFaceDirectory,
    'storage.custom_face_directory',
    0,
    canonicalCache,
  );
  for (const path of names.keys()) {
    if (
      path === originals ||
      path.startsWith(originals + '/') ||
      originals.startsWith(path + '/')
    ) {
      fail('storage.custom_face_directory', '原始素材目录必须独立于存储文件');
    }
  }
  const artifacts = canonicalStoragePath(
    storage.artifactDirectory,
    'storage.artifact_directory',
    0,
    canonicalCache,
  );
  for (const path of [...names.keys(), originals]) {
    if (
      path === artifacts ||
      path.startsWith(artifacts + '/') ||
      artifacts.startsWith(path + '/')
    ) {
      fail(
        'storage.artifact_directory',
        '产物目录必须独立于存储文件和原始素材目录',
      );
    }
  }
  try {
    const stat = lstatSync(storage.artifactDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail('storage.artifact_directory', '必须是独立普通目录');
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      fail('storage.artifact_directory', '无法核验产物目录');
    }
  }
  try {
    const stat = lstatSync(storage.customFaceDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail('storage.custom_face_directory', '必须是独立普通目录');
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      throw error;
    }
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      fail('storage.custom_face_directory', '无法核验素材目录');
    }
  }
}
