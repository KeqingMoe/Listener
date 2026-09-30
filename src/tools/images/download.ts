import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import sharp from 'sharp';
import { MODEL_IMAGE_MAX_EDGE } from '../../contracts/tool-limits.ts';
import { log } from '../../observability/logger.ts';

interface DownloadedImage {
  dataUrl: string;
  width: number;
  height: number;
  firstFrameOnly: boolean;
}

export type ImageDownloader = (
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
) => Promise<DownloadedImage>;

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
// 只允许精确匹配的QQ图片CDN主机名，不对调用方提供的主机名做后缀匹配。
const IMAGE_HOSTS = new Set([
  'multimedia.nt.qq.com.cn',
  'gchat.qpic.cn',
  'c2cpicdw.qpic.cn',
]);
const fail = (message: string): Error => new Error(message);

export function validateImageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw fail('Invalid image URL');
  }
  if (
    url.protocol !== 'https:' ||
    (url.port !== '' && url.port !== '443') ||
    url.username ||
    url.password ||
    url.hash ||
    value.includes('#') ||
    !IMAGE_HOSTS.has(url.hostname)
  ) {
    throw fail('Image URL is not allowed');
  }
  return url;
}

/** 拒绝非规范地址、带scope的IPv6、IPv4映射地址以及所有特殊用途网段。 */
export function isPublicAddress(address: string): boolean {
  if (!isIP(address) || address.includes('%')) {
    return false;
  }
  try {
    const parsed = ipaddr.parse(address);
    if (parsed.range() !== 'unicast') {
      return false;
    }
    // IPv6全球单播目前为2000::/3。即使某些ipaddr.js版本把特殊用途分配标为普通unicast，也要排除。
    if (parsed.kind() === 'ipv6') {
      const v6 = parsed as ipaddr.IPv6;
      if (!v6.match(ipaddr.parse('2000::') as ipaddr.IPv6, 3)) {
        return false;
      }
      for (const [network, prefix] of [
        ['2001::', 23],
        ['2001:db8::', 32],
        ['2002::', 16],
        ['3fff::', 20],
      ] as const) {
        if (v6.match(ipaddr.parse(network) as ipaddr.IPv6, prefix)) {
          return false;
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw fail('Image operation aborted');
  }
}

/** 即使DNS或解码工作不响应取消，也让它与取消信号竞速；不暴露其错误。 */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      cleanup();
      reject(fail('Image operation aborted'));
    };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    if (signal.aborted) {
      work.catch(() => {});
      aborted();
      return;
    }
    signal.addEventListener('abort', aborted, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      () => {
        cleanup();
        reject(fail('Image operation failed'));
      },
    );
  });
}

/** 根据文件签名决定是否交给原生解析器，不看调用方可控的MIME类型或文件名。 */
export function hasSupportedImageSignature(bytes: Buffer): boolean {
  if (!Buffer.isBuffer(bytes)) {
    return false;
  }
  const startsWith = (signature: readonly number[]) =>
    bytes.length >= signature.length &&
    signature.every((value, index) => bytes[index] === value);
  return (
    startsWith([0xff, 0xd8, 0xff]) ||
    startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    startsWith([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) ||
    (bytes.length >= 12 &&
      bytes.subarray(0, 4).equals(Buffer.from('RIFF')) &&
      bytes.subarray(8, 12).equals(Buffer.from('WEBP')))
  );
}

/** 模型预览尺寸上限固定，调用方不能请求以原图尺寸输入模型。 */
export function prepareImage(
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<DownloadedImage> {
  return prepareNormalizedImage(bytes, MODEL_IMAGE_MAX_EDGE, signal);
}

/** 只根据字节解码（不看文件名），取第一帧展平并去除元数据。 */
async function prepareNormalizedImage(
  bytes: Buffer,
  maxEdge: number,
  signal?: AbortSignal,
): Promise<DownloadedImage> {
  checkAbort(signal);
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > MAX_INPUT_BYTES
  ) {
    throw fail('Invalid image data size');
  }
  if (!hasSupportedImageSignature(bytes)) {
    throw fail('Image decoding failed');
  }
  const started = performance.now();
  const metrics = () => ({
    phase: 'decode',
    input_bytes: bytes.length,
    duration_ms: performance.now() - started,
  });
  const failed = () =>
    log(signal?.aborted ? 'info' : 'warn', 'image.decode_failed', {
      ...metrics(),
      reason: signal?.aborted ? 'cancelled' : 'decode_failed',
    });
  log('info', 'image.decode_start', {
    phase: 'decode',
    input_bytes: bytes.length,
  });
  let decoder: ReturnType<typeof sharp>;
  try {
    decoder = sharp(bytes, {
      limitInputPixels: MAX_PIXELS,
      animated: false,
      failOn: 'warning',
    });
  } catch {
    failed();
    throw fail('Image decoding failed');
  }
  try {
    decoder.timeout({ seconds: 10 });
  } catch {
    decoder.destroy();
    failed();
    throw fail('Image decoding failed');
  }
  const stop = () => {
    decoder.destroy();
  };
  signal?.addEventListener('abort', stop, { once: true });
  const work = (async () => {
    const metadata = await decoder.metadata();
    if (
      !metadata.format ||
      !['jpeg', 'png', 'webp', 'gif'].includes(metadata.format) ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > MAX_PIXELS
    ) {
      throw fail('Unsupported image data');
    }
    checkAbort(signal);
    const { data, info } = await decoder
      .rotate()
      .resize({
        width: maxEdge,
        height: maxEdge,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
    checkAbort(signal);
    if (data.length > MAX_OUTPUT_BYTES) {
      throw fail('Prepared image is too large');
    }
    return {
      dataUrl: `data:image/jpeg;base64,${data.toString('base64')}`,
      width: info.width,
      height: info.height,
      firstFrameOnly: metadata.format === 'gif' || (metadata.pages ?? 1) > 1,
    };
  })();
  try {
    const result = signal ? await abortable(work, signal) : await work;
    checkAbort(signal);
    log('info', 'image.decode_complete', {
      ...metrics(),
      outcome: 'success',
      width: result.width,
      height: result.height,
      output_bytes: Buffer.byteLength(result.dataUrl),
      first_frame_only: result.firstFrameOnly,
    });
    return result;
  } catch {
    failed();
    throw fail(
      signal?.aborted ? 'Image operation aborted' : 'Image decoding failed',
    );
  } finally {
    signal?.removeEventListener('abort', stop);
    decoder.destroy();
  }
}

export interface ImageDownloadDependencies {
  lookup?: (
    hostname: string,
    options: { all: true; verbatim: true },
  ) => Promise<Array<{ address: string; family: number }>>;
  request?: (
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => ClientRequest;
  /** 测试钩子；生产环境固定使用15秒总超时。 */
  timeoutMs?: number;
}

function createSafeImageDownloader<T>(
  dependencies: ImageDownloadDependencies,
  validateUrl: (value: string) => URL,
  decode: (bytes: Buffer, signal?: AbortSignal) => Promise<T>,
): (url: string, maxBytes: number, signal?: AbortSignal) => Promise<T> {
  const lookup: NonNullable<ImageDownloadDependencies['lookup']> =
    dependencies.lookup ??
    ((hostname, options) => dnsLookup(hostname, options));
  const request = dependencies.request ?? httpsRequest;
  return async (value, maxBytes, callerSignal) => {
    let phase: 'url_validation' | 'dns' | 'download' | 'decode' =
      'url_validation';
    let stageStarted = performance.now();
    let httpStatus: number | undefined;
    const metrics = () => ({
      phase,
      duration_ms: performance.now() - stageStarted,
      ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
    });
    log('info', 'image.download_start', { phase });
    let url: URL;
    try {
      checkAbort(callerSignal);
      url = validateUrl(value);
      if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > MAX_INPUT_BYTES
      ) {
        throw fail('Invalid image byte limit');
      }
    } catch (error) {
      log(callerSignal?.aborted ? 'info' : 'warn', 'image.download_failed', {
        ...metrics(),
        reason: callerSignal?.aborted ? 'cancelled' : 'url_rejected',
      });
      throw error; // 这些预检错误的消息本就是固定且可公开的。
    }
    const controller = new AbortController();
    const signal = controller.signal;
    let timedOut = false;
    const cancel = () => controller.abort();
    callerSignal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, dependencies.timeoutMs ?? 15_000);
    try {
      phase = 'dns';
      stageStarted = performance.now();
      const addresses = await abortable(
        lookup(url.hostname, { all: true, verbatim: true }),
        signal,
      );
      if (
        addresses.length === 0 ||
        addresses.some(
          (entry) =>
            !isPublicAddress(entry.address) ||
            isIP(entry.address) !== entry.family,
        )
      ) {
        throw fail('Image address is not allowed');
      }
      const selected = addresses[0]!;
      checkAbort(signal);
      phase = 'download';
      stageStarted = performance.now();
      const bytes = await new Promise<Buffer>((resolve, reject) => {
        let req: ClientRequest | undefined;
        let response: IncomingMessage | undefined;
        let settled = false;
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        const finish = (error?: Error, result?: Buffer) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          if (error) {
            reject(error);
            response?.destroy();
            req?.destroy();
          } else {
            resolve(result!);
          }
        };
        const onAbort = () => finish(fail('Image operation aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          req = request(
            {
              protocol: 'https:',
              hostname: url.hostname,
              port: 443,
              path: `${url.pathname}${url.search}`,
              method: 'GET',
              servername: url.hostname,
              rejectUnauthorized: true,
              agent: false,
              family: selected.family,
              // 新建连接并固定地址；TLS仍校验CDN主机名。
              lookup: (_hostname, options, callback) => {
                if (options.all) {
                  callback(null, [
                    { address: selected.address, family: selected.family },
                  ]);
                } else {
                  callback(null, selected.address, selected.family);
                }
              },
              headers: {
                Accept: 'image/jpeg, image/png, image/webp, image/gif',
                'Accept-Encoding': 'identity',
              },
            },
            (incoming) => {
              response = incoming;
              if (
                typeof incoming.statusCode === 'number' &&
                Number.isInteger(incoming.statusCode) &&
                incoming.statusCode >= 100 &&
                incoming.statusCode <= 599
              ) {
                httpStatus = incoming.statusCode;
              }
              incoming.on('error', () => finish(fail('Image download failed')));
              if (settled) {
                incoming.destroy();
                return;
              }
              // 所有重定向和错误响应都直接拒绝，不读取也不暴露响应体。
              if (incoming.statusCode !== 200) {
                finish(fail('Image HTTP response rejected'));
                return;
              }
              const encoding = incoming.headers['content-encoding'];
              if (encoding && encoding !== 'identity') {
                finish(fail('Image encoding rejected'));
                return;
              }
              const declared = incoming.headers['content-length'];
              if (
                declared !== undefined &&
                (!/^\d+$/.test(declared) || Number(declared) > maxBytes)
              ) {
                finish(fail('Image exceeds byte limit'));
                return;
              }
              const chunks: Buffer[] = [];
              let total = 0;
              incoming.on('data', (chunk: Buffer) => {
                if (settled) {
                  return;
                }
                total += chunk.length;
                if (total > maxBytes) {
                  finish(fail('Image exceeds byte limit'));
                  return;
                }
                chunks.push(chunk);
              });
              incoming.on('aborted', () =>
                finish(fail('Image download failed')),
              );
              incoming.on('end', () => {
                if (declared !== undefined && total !== Number(declared)) {
                  finish(fail('Image download failed'));
                } else {
                  finish(undefined, Buffer.concat(chunks, total));
                }
              });
              incoming.on('close', () => {
                if (!incoming.complete) {
                  finish(fail('Image download failed'));
                }
              });
            },
          );
          req.on('error', () => finish(fail('Image download failed')));
          if (signal.aborted) {
            onAbort();
          }
          if (settled) {
            req.destroy();
          } else {
            req.end();
          }
        } catch {
          finish(fail('Image download failed'));
        }
      });
      log('info', 'image.download_complete', {
        ...metrics(),
        bytes: bytes.length,
        input_bytes: bytes.length,
        outcome: 'success',
      });
      phase = 'decode';
      stageStarted = performance.now();
      return await decode(bytes, signal);
    } catch {
      log(
        callerSignal?.aborted && !timedOut ? 'info' : 'warn',
        'image.download_failed',
        {
          ...metrics(),
          reason: timedOut
            ? 'timeout'
            : callerSignal?.aborted
              ? 'cancelled'
              : phase === 'dns'
                ? 'dns_rejected'
                : phase === 'decode'
                  ? 'decode_failed'
                  : 'transfer_failed',
        },
      );
      // 不包含远端异常消息、URL中的token、响应文本或二进制数据。
      throw fail(
        timedOut
          ? 'Image download timed out'
          : callerSignal?.aborted
            ? 'Image operation aborted'
            : 'Image download failed',
      );
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', cancel);
    }
  };
}

export function createImageDownloader(
  dependencies: ImageDownloadDependencies = {},
): ImageDownloader {
  return createSafeImageDownloader(
    dependencies,
    validateImageUrl,
    prepareImage,
  );
}

/** 原生群发送按2048px规范化，不使用模型预览的尺寸。 */
export function createSendImageDownloader(
  dependencies: ImageDownloadDependencies = {},
): ImageDownloader {
  return createSafeImageDownloader(
    dependencies,
    validateImageUrl,
    (bytes, signal) => prepareNormalizedImage(bytes, 2048, signal),
  );
}

export const downloadSendImage: ImageDownloader = createSendImageDownloader();

interface OriginalImage {
  bytes: Buffer;
  md5: string;
  format: 'jpeg' | 'png' | 'gif' | 'webp';
  /** 单帧的编码尺寸；不应用EXIF旋转，也不缩放。 */
  width: number;
  height: number;
  animated: boolean;
}

export type OriginalImageDownloader = (
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
) => Promise<OriginalImage>;

/**
 * 仅用于已授权的原生收藏表情URL，不接受模型给出的任意URL。
 * HTTP输入在DNS和网络访问之前升级为HTTPS。通用的view_images策略不受影响。
 */
export function validateCustomFaceImageUrl(value: string): URL {
  let url: URL;
  try {
    if (typeof value !== 'string' || /[\s\\]/.test(value)) {
      throw fail('Invalid image URL');
    }
    url = new URL(value);
  } catch {
    throw fail('Invalid image URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.port !== '' ||
    url.username ||
    url.password ||
    url.hash ||
    value.includes('#')
  ) {
    throw fail('Image URL is not allowed');
  }
  if (url.hostname === 'p.qpic.cn') {
    // 收藏表情URL的格式依据fetch_custom_face_detail的实际返回核实；不假定两个数字字段表示同一身份。
    if (
      value.includes('?') ||
      !/^\/qq_expression\/[1-9]\d{0,31}\/[1-9]\d{0,31}_0_0_0_[a-fA-F0-9]{32}_0_0\/0$/.test(
        url.pathname,
      )
    ) {
      throw fail('Image URL is not allowed');
    }
  } else if (!IMAGE_HOSTS.has(url.hostname)) {
    if (
      !['gxh.vip.qq.com', 'i.gtimg.cn'].includes(url.hostname) ||
      url.search
    ) {
      throw fail('Image URL is not allowed');
    }
    const path =
      /^\/club\/item\/parcel\/item\/([a-fA-F0-9]{2})\/([a-fA-F0-9]{32})\/raw(?:200|300)\.gif$/.exec(
        url.pathname,
      );
    if (
      !path ||
      path[1]!.toLowerCase() !== path[2]!.slice(0, 2).toLowerCase()
    ) {
      throw fail('Image URL is not allowed');
    }
  }
  url.protocol = 'https:';
  return url;
}

const MAX_ORIGINAL_FRAMES = 512;

/**
 * 同时限制GIF逻辑画布和解码后帧的尺寸：libvips可能只报告图像矩形，
 * 忽略恶意设置的超大画布。
 */
function validateGifStructure(bytes: Buffer): {
  width: number;
  height: number;
  frames: number;
} {
  if (bytes.length < 13) {
    throw fail('Image decoding failed');
  }
  const width = bytes.readUInt16LE(6),
    height = bytes.readUInt16LE(8);
  if (!width || !height || width * height > MAX_PIXELS) {
    throw fail('Image decoding failed');
  }
  let offset = 13,
    frames = 0;
  const consume = (length: number) => {
    if (length > bytes.length - offset) {
      throw fail('Image decoding failed');
    }
    offset += length;
  };
  const blocks = () => {
    while (true) {
      if (offset >= bytes.length) {
        throw fail('Image decoding failed');
      }
      const length = bytes[offset++]!;
      if (!length) {
        return;
      }
      consume(length);
    }
  };
  if (bytes[10]! & 0x80) {
    consume(3 * 2 ** ((bytes[10]! & 7) + 1));
  }
  while (offset < bytes.length) {
    const tag = bytes[offset++]!;
    if (tag === 0x3b) {
      if (!frames || offset !== bytes.length) {
        throw fail('Image decoding failed');
      }
      return { width, height, frames };
    }
    if (tag === 0x21) {
      consume(1);
      blocks();
      continue;
    }
    if (tag !== 0x2c || bytes.length - offset < 9) {
      throw fail('Image decoding failed');
    }
    const left = bytes.readUInt16LE(offset),
      top = bytes.readUInt16LE(offset + 2);
    const frameWidth = bytes.readUInt16LE(offset + 4),
      frameHeight = bytes.readUInt16LE(offset + 6);
    const packed = bytes[offset + 8]!;
    consume(9);
    if (
      !frameWidth ||
      !frameHeight ||
      left + frameWidth > width ||
      top + frameHeight > height ||
      ++frames > MAX_ORIGINAL_FRAMES ||
      width * height * frames > MAX_PIXELS
    ) {
      throw fail('Image decoding failed');
    }
    if (packed & 0x80) {
      consume(3 * 2 ** ((packed & 7) + 1));
    }
    if (offset >= bytes.length || bytes[offset]! < 2 || bytes[offset]! > 8) {
      throw fail('Image decoding failed');
    }
    consume(1);
    blocks();
  }
  throw fail('Image decoding failed');
}

/**
 * libvips不校验APNG的附加帧。不能把它当作完整校验过的静态PNG，
 * 把未校验的动画交给其他解码器。
 */
function rejectApng(bytes: Buffer): void {
  if (
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    return;
  }
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) {
      throw fail('Image decoding failed');
    }
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    if (kind === 'acTL' || kind === 'fcTL' || kind === 'fdAT') {
      throw fail('Image decoding failed');
    }
    offset += length + 12;
    if (kind === 'IEND') {
      if (offset !== bytes.length) {
        throw fail('Image decoding failed');
      }
      return;
    }
  }
  throw fail('Image decoding failed');
}

/**
 * 校验所有帧，但返回原始字节的私有副本。
 * 解码出的像素只是临时校验数据，不作为返回或发送的图片。
 */
export async function validateOriginalImage(
  input: Buffer,
  callerSignal?: AbortSignal,
): Promise<OriginalImage> {
  checkAbort(callerSignal);
  if (
    !Buffer.isBuffer(input) ||
    input.length === 0 ||
    input.length > MAX_INPUT_BYTES
  ) {
    throw fail('Invalid image data size');
  }
  const bytes = Buffer.from(input);
  if (!hasSupportedImageSignature(bytes)) {
    throw fail('Image decoding failed');
  }
  rejectApng(bytes);
  const expectedFormat: OriginalImage['format'] =
    bytes[0] === 0xff
      ? 'jpeg'
      : bytes[0] === 0x89
        ? 'png'
        : bytes[0] === 0x47
          ? 'gif'
          : 'webp';
  const gif =
    expectedFormat === 'gif' ? validateGifStructure(bytes) : undefined;
  const controller = new AbortController(),
    signal = controller.signal;
  const cancel = () => controller.abort();
  callerSignal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 15_000);
  let decoder: ReturnType<typeof sharp> | undefined;
  const stop = () => decoder?.destroy();
  signal.addEventListener('abort', stop, { once: true });
  try {
    decoder = sharp(bytes, {
      animated: true,
      limitInputPixels: MAX_PIXELS,
      failOn: 'warning',
    });
    decoder.timeout({ seconds: 10 });
    const work = (async (): Promise<OriginalImage> => {
      const metadata = await decoder!.metadata();
      const { width, height } = metadata;
      const pages = metadata.pages ?? 1;
      const frameHeight = metadata.pageHeight ?? height;
      if (
        metadata.format !== expectedFormat ||
        !Number.isSafeInteger(width) ||
        !width ||
        width < 1 ||
        !Number.isSafeInteger(height) ||
        !height ||
        height < 1 ||
        !Number.isSafeInteger(pages) ||
        pages < 1 ||
        pages > MAX_ORIGINAL_FRAMES ||
        !Number.isSafeInteger(frameHeight) ||
        !frameHeight ||
        frameHeight < 1 ||
        height !== frameHeight * pages ||
        width * height > MAX_PIXELS ||
        (pages > 1 && expectedFormat !== 'gif' && expectedFormat !== 'webp') ||
        (gif &&
          (width > gif.width ||
            frameHeight > gif.height ||
            gif.frames !== pages))
      ) {
        throw fail('Image decoding failed');
      }
      checkAbort(signal);
      // 转为sRGB并加alpha，使校验用的原始缓冲区固定为每像素4字节。
      const { data, info } = await decoder!
        .toColourspace('srgb')
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      checkAbort(signal);
      if (
        info.width !== width ||
        info.height !== height ||
        info.channels !== 4 ||
        data.length !== width * height * 4
      ) {
        throw fail('Image decoding failed');
      }
      return {
        bytes,
        md5: createHash('md5').update(bytes).digest('hex'),
        format: expectedFormat,
        width: gif?.width ?? width,
        height: gif?.height ?? frameHeight,
        animated: pages > 1,
      };
    })();
    const result = await abortable(work, signal);
    checkAbort(signal);
    return result;
  } catch {
    throw fail(
      signal.aborted ? 'Image operation aborted' : 'Image decoding failed',
    );
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', cancel);
    signal.removeEventListener('abort', stop);
    decoder?.destroy();
  }
}

export function createOriginalImageDownloader(
  dependencies: ImageDownloadDependencies = {},
): OriginalImageDownloader {
  return createSafeImageDownloader(
    dependencies,
    validateCustomFaceImageUrl,
    validateOriginalImage,
  );
}

export const downloadOriginalImage: OriginalImageDownloader =
  createOriginalImageDownloader();
export const downloadImage: ImageDownloader = createImageDownloader();

/** 把规范化后的模型图片解码为RGBA像素供沙箱代码使用（仅第一帧）。 */
export async function imagePixels(
  dataUrl: string,
): Promise<{ width: number; height: number; pixels: Uint8Array }> {
  const match =
    /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      dataUrl,
    );
  if (!match) {
    throw new Error('invalid_image');
  }
  const { data, info } = await sharp(Buffer.from(match[1]!, 'base64'), {
    pages: 1,
    limitInputPixels: MODEL_IMAGE_MAX_EDGE * MODEL_IMAGE_MAX_EDGE * 4,
  })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) {
    throw new Error('invalid_image');
  }
  return {
    width: info.width,
    height: info.height,
    pixels: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  };
}
