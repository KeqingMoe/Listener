import { constants } from 'node:fs';
import { mkdir, lstat, open, rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  FACE_CATALOG_VERSION,
  FACE_CATALOG_SOURCE,
  FACE_CATALOG_LICENSE,
  FACE_DATA_LIMIT,
  extractFaceCatalog,
} from '../onebot/catalog/schema.ts';

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (
    !response.ok ||
    !response.body ||
    Number(response.headers.get('content-length')) > FACE_DATA_LIMIT
  ) {
    await response.body?.cancel();
    throw new Error('QQ face source unavailable');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        break;
      }
      bytes += part.value.byteLength;
      if (bytes > FACE_DATA_LIMIT) {
        await reader.cancel();
        throw new Error('QQ face source too large');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function atomicWrite(
  directory: URL,
  name: string,
  data: Uint8Array,
): Promise<void> {
  const temporary = new URL(
    `.${name}.${randomBytes(12).toString('hex')}.tmp`,
    directory,
  );
  let handle;
  let created = false;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, new URL(name, directory));
  } finally {
    await handle?.close();
    if (created) {
      await unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      });
    }
  }
}

/** 只能通过CLI显式触发；import和测试都不会访问网络。 */
export async function syncFaces(): Promise<void> {
  const source = await download(FACE_CATALOG_SOURCE);
  const license = await download(FACE_CATALOG_LICENSE);
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(source);
  const licenseText = new TextDecoder('utf-8', { fatal: true }).decode(license);
  if (
    !licenseText.includes('Limited Redistribution License for NapCat') ||
    !licenseText.includes('Mlikiowa')
  ) {
    throw new Error('Unexpected QQ face source license');
  }
  const catalog = extractFaceCatalog(JSON.parse(decoded));
  const directory = new URL('../../data/', import.meta.url);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('Invalid QQ face data directory');
  }
  // 原始文件连同上游许可证逐字节保存在被git忽略的data/下。
  // 运行时使用的精简表最后原子写入，确保它出现时源文件已就位。
  await atomicWrite(
    directory,
    `napcat-face-config-v${FACE_CATALOG_VERSION}.json`,
    source,
  );
  await atomicWrite(
    directory,
    `NAPCAT-LICENSE-v${FACE_CATALOG_VERSION}.txt`,
    license,
  );
  await atomicWrite(
    directory,
    'qq-faces.json',
    Buffer.from(JSON.stringify(catalog) + '\n'),
  );
  console.log(
    `QQ face catalog synchronized: NapCat ${FACE_CATALOG_VERSION}, ${catalog.faces.length} IDs. Restart Listener to load it.`,
  );
  console.log(
    'Source and full upstream license retained under ignored data/. Check upstream restrictions before redistribution.',
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  syncFaces().catch(() => {
    console.error(
      'faces:sync failed: check network, source format/license, and data directory permissions.',
    );
    process.exitCode = 1;
  });
}
