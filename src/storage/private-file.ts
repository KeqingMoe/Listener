import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
} from 'node:fs';

/**
 * 在交给SQLite打开之前，确保数据库文件是当前用户私有的普通文件。
 *
 * - 已有的-journal/-wal/-shm旁路文件必须是本用户所有、单链接、无组或其他人权限的普通文件。
 * - 主文件以O_NOFOLLOW创建或打开，拒绝符号链接、硬链接和打开期间被替换的路径，最后收紧为0600。
 *
 * 不满足条件时抛出 `new Error(code)`。
 */
export function preparePrivateDatabase(path: string, code: string): void {
  for (const suffix of ['-journal', '-wal', '-shm']) {
    try {
      const stat = lstatSync(path + suffix);
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0
      ) {
        throw new Error(code);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  const fd = openSync(
    path,
    constants.O_RDWR |
      constants.O_CREAT |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    0o600,
  );
  try {
    const stat = fstatSync(fd),
      current = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      current.isSymbolicLink() ||
      stat.ino !== current.ino ||
      stat.dev !== current.dev
    ) {
      throw new Error(code);
    }
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}
