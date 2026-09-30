import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import {
  FACE_CATALOG_VERSION,
  FACE_CATALOG_SOURCE,
  FACE_DATA_LIMIT,
  validateFaceCatalog,
  type FaceCatalogEntry,
} from './schema.ts';

export { FACE_CATALOG_VERSION, FACE_CATALOG_SOURCE, validateFaceCatalog };
export type { FaceCatalogEntry };
export const FACE_CATALOG_PATH = new URL(
  '../../../data/qq-faces.json',
  import.meta.url,
);

// 少量手工维护的公开示例，不是从上游拷贝的目录。
// 全新的离线checkout也能渲染/发送这些表情；显式运行faces:sync才会把固定版本的全部数字sysface ID
// 安装到被git忽略的本地data/目录。
export const EXAMPLE_FACE_CATALOG: readonly FaceCatalogEntry[] =
  validateFaceCatalog({
    version: FACE_CATALOG_VERSION,
    faces: [
      { id: '0', name: '惊讶', animated: false },
      { id: '6', name: '害羞', animated: false },
      { id: '14', name: '微笑', animated: false },
      { id: '20', name: '偷笑', animated: false },
      { id: '21', name: '可爱', animated: false },
      { id: '22', name: '白眼', animated: false },
      { id: '32', name: '疑问', animated: false },
      { id: '375', name: '超级鼓掌', animated: true },
    ],
  });

/** 启动时加载一次；文件不存在时用示例目录，已存在但格式错误则直接报错，绝不回退。 */
export function loadFaceCatalog(
  path: string | URL = FACE_CATALOG_PATH,
): readonly FaceCatalogEntry[] {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return EXAMPLE_FACE_CATALOG;
    }
    throw new Error(
      'Cannot read local QQ face catalog; run faces:sync to repair it',
    );
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > FACE_DATA_LIMIT) {
      throw new Error();
    }
    const buffer = Buffer.alloc(FACE_DATA_LIMIT + 1);
    let size = 0;
    while (size < buffer.length) {
      const bytes = readSync(fd, buffer, size, buffer.length - size, null);
      if (!bytes) {
        break;
      }
      size += bytes;
    }
    if (size > FACE_DATA_LIMIT) {
      throw new Error();
    }
    return validateFaceCatalog(
      JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(
          buffer.subarray(0, size),
        ),
      ),
    );
  } catch {
    throw new Error(
      'Invalid local QQ face catalog; run faces:sync to repair it',
    );
  } finally {
    closeSync(fd);
  }
}

export const FACE_CATALOG = loadFaceCatalog();
