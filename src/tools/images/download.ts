import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import sharp from 'sharp';
import { MODEL_IMAGE_MAX_EDGE } from '../../contracts/tool-limits.js';
import { log } from '../../observability/logger.js';

export interface DownloadedImage {
  dataUrl: string;
  width: number;
  height: number;
  firstFrameOnly: boolean;
}
export type ImageDownloader = (url: string, maxBytes: number, signal?: AbortSignal) => Promise<DownloadedImage>;

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_PIXELS = 40_000_000;
// Exact QQ image CDN hosts only; never suffix-match a caller-supplied hostname.
const IMAGE_HOSTS = new Set(['multimedia.nt.qq.com.cn', 'gchat.qpic.cn', 'c2cpicdw.qpic.cn']);
const fail = (message: string): Error => new Error(message);

export function validateImageUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw fail('Invalid image URL'); }
  if (url.protocol !== 'https:' || (url.port !== '' && url.port !== '443') ||
      url.username || url.password || url.hash || value.includes('#') ||
      !IMAGE_HOSTS.has(url.hostname)) {
    throw fail('Image URL is not allowed');
  }
  return url;
}

/** Reject noncanonical addresses, scoped IPv6, mapped IPv4, and all special ranges. */
export function isPublicAddress(address: string): boolean {
  if (!isIP(address) || address.includes('%')) return false;
  try {
    const parsed = ipaddr.parse(address);
    if (parsed.range() !== 'unicast') return false;
    // IPv6 global unicast is currently 2000::/3. Exclude special-purpose allocations
    // even on ipaddr.js versions which label them plain unicast.
    if (parsed.kind() === 'ipv6') {
      const v6 = parsed as ipaddr.IPv6;
      if (!v6.match(ipaddr.parse('2000::') as ipaddr.IPv6, 3)) return false;
      for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) {
        if (v6.match(ipaddr.parse(network) as ipaddr.IPv6, prefix)) return false;
      }
    }
    return true;
  } catch { return false; }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw fail('Image operation aborted');
}

/** Race even uncooperative DNS/decoder work against cancellation; never expose its errors. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => { cleanup(); reject(fail('Image operation aborted')); };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    if (signal.aborted) { work.catch(() => {}); aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
    work.then(value => { cleanup(); resolve(value); }, () => {
      cleanup(); reject(fail('Image operation failed'));
    });
  });
}

/** Gate native parsers using signatures, not caller-controlled MIME types or filenames. */
export function hasSupportedImageSignature(bytes: Buffer): boolean {
  if (!Buffer.isBuffer(bytes)) return false;
  const startsWith = (signature: readonly number[]) => bytes.length >= signature.length &&
    signature.every((value, index) => bytes[index] === value);
  return startsWith([0xff, 0xd8, 0xff]) ||
    startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    startsWith([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) ||
    (bytes.length >= 12 && bytes.subarray(0, 4).equals(Buffer.from('RIFF')) &&
      bytes.subarray(8, 12).equals(Buffer.from('WEBP')));
}

/** Fixed model preview bound; callers cannot request original-size model input. */
export function prepareImage(bytes: Buffer, signal?: AbortSignal): Promise<DownloadedImage> {
  return prepareNormalizedImage(bytes, MODEL_IMAGE_MAX_EDGE, signal);
}

/** Decode bytes only (never filenames), flatten the first frame, strip metadata. */
async function prepareNormalizedImage(bytes: Buffer, maxEdge: number, signal?: AbortSignal): Promise<DownloadedImage> {
  checkAbort(signal);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_INPUT_BYTES) {
    throw fail('Invalid image data size');
  }
  if (!hasSupportedImageSignature(bytes)) throw fail('Image decoding failed');
  const started = performance.now();
  const metrics = () => ({ phase: 'decode', input_bytes: bytes.length, duration_ms: performance.now() - started });
  const failed = () => log(signal?.aborted ? 'info' : 'warn', 'image.decode_failed', { ...metrics(), reason: signal?.aborted ? 'cancelled' : 'decode_failed' });
  log('info', 'image.decode_start', { phase: 'decode', input_bytes: bytes.length });
  let decoder: ReturnType<typeof sharp>;
  try {
    decoder = sharp(bytes, { limitInputPixels: MAX_PIXELS, animated: false, failOn: 'warning' });
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
  const stop = () => { decoder.destroy(); };
  signal?.addEventListener('abort', stop, { once: true });
  const work = (async () => {
    const metadata = await decoder.metadata();
    if (!metadata.format || !['jpeg', 'png', 'webp', 'gif'].includes(metadata.format) ||
        !metadata.width || !metadata.height || metadata.width * metadata.height > MAX_PIXELS) {
      throw fail('Unsupported image data');
    }
    checkAbort(signal);
    const { data, info } = await decoder.rotate()
      .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
    checkAbort(signal);
    if (data.length > MAX_OUTPUT_BYTES) throw fail('Prepared image is too large');
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
    log('info', 'image.decode_complete', { ...metrics(), outcome: 'success', width: result.width, height: result.height,
      output_bytes: Buffer.byteLength(result.dataUrl), first_frame_only: result.firstFrameOnly });
    return result;
  } catch {
    failed();
    throw fail(signal?.aborted ? 'Image operation aborted' : 'Image decoding failed');
  } finally {
    signal?.removeEventListener('abort', stop);
    decoder.destroy();
  }
}

export interface ImageDownloadDependencies {
  lookup?: (hostname: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>>;
  request?: (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
  /** Testing hook; production always uses the 15 second total deadline. */
  timeoutMs?: number;
}

function createSafeImageDownloader<T>(
  dependencies: ImageDownloadDependencies,
  validateUrl: (value: string) => URL,
  decode: (bytes: Buffer, signal?: AbortSignal) => Promise<T>,
): (url: string, maxBytes: number, signal?: AbortSignal) => Promise<T> {
  const lookup: NonNullable<ImageDownloadDependencies['lookup']> = dependencies.lookup ??
    ((hostname, options) => dnsLookup(hostname, options));
  const request = dependencies.request ?? httpsRequest;
  return async (value, maxBytes, callerSignal) => {
    let phase: 'url_validation' | 'dns' | 'download' | 'decode' = 'url_validation';
    let stageStarted = performance.now();
    let httpStatus: number | undefined;
    const metrics = () => ({ phase, duration_ms: performance.now() - stageStarted,
      ...(httpStatus === undefined ? {} : { http_status: httpStatus }) });
    log('info', 'image.download_start', { phase });
    let url: URL;
    try {
      checkAbort(callerSignal);
      url = validateUrl(value);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_INPUT_BYTES) {
        throw fail('Invalid image byte limit');
      }
    } catch (error) {
      log(callerSignal?.aborted ? 'info' : 'warn', 'image.download_failed', { ...metrics(), reason: callerSignal?.aborted ? 'cancelled' : 'url_rejected' });
      throw error; // These preflight errors already have fixed, public messages.
    }
    const controller = new AbortController();
    const signal = controller.signal;
    let timedOut = false;
    const cancel = () => controller.abort();
    callerSignal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, dependencies.timeoutMs ?? 15_000);
    try {
      phase = 'dns'; stageStarted = performance.now();
      const addresses = await abortable(lookup(url.hostname, { all: true, verbatim: true }), signal);
      if (addresses.length === 0 || addresses.some(entry =>
        !isPublicAddress(entry.address) || isIP(entry.address) !== entry.family)) {
        throw fail('Image address is not allowed');
      }
      const selected = addresses[0]!;
      checkAbort(signal);
      phase = 'download'; stageStarted = performance.now();
      const bytes = await new Promise<Buffer>((resolve, reject) => {
        let req: ClientRequest | undefined;
        let response: IncomingMessage | undefined;
        let settled = false;
        const cleanup = () => signal.removeEventListener('abort', onAbort);
        const finish = (error?: Error, result?: Buffer) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) {
            reject(error);
            response?.destroy();
            req?.destroy();
          } else resolve(result!);
        };
        const onAbort = () => finish(fail('Image operation aborted'));
        signal.addEventListener('abort', onAbort, { once: true });
        try {
          req = request({
            protocol: 'https:', hostname: url.hostname, port: 443,
            path: `${url.pathname}${url.search}`, method: 'GET',
            servername: url.hostname, rejectUnauthorized: true,
            agent: false, family: selected.family,
            // A fresh connection with a pinned address; TLS still validates the CDN hostname.
            lookup: (_hostname, options, callback) => {
              if (options.all) callback(null, [{ address: selected.address, family: selected.family }]);
              else callback(null, selected.address, selected.family);
            },
            headers: { Accept: 'image/jpeg, image/png, image/webp, image/gif', 'Accept-Encoding': 'identity' },
          }, incoming => {
            response = incoming;
            if (typeof incoming.statusCode === 'number' && Number.isInteger(incoming.statusCode) && incoming.statusCode >= 100 && incoming.statusCode <= 599) httpStatus = incoming.statusCode;
            incoming.on('error', () => finish(fail('Image download failed')));
            if (settled) { incoming.destroy(); return; }
            // All redirects and errors are rejected without reading or exposing their bodies.
            if (incoming.statusCode !== 200) { finish(fail('Image HTTP response rejected')); return; }
            const encoding = incoming.headers['content-encoding'];
            if (encoding && encoding !== 'identity') { finish(fail('Image encoding rejected')); return; }
            const declared = incoming.headers['content-length'];
            if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
              finish(fail('Image exceeds byte limit')); return;
            }
            const chunks: Buffer[] = [];
            let total = 0;
            incoming.on('data', (chunk: Buffer) => {
              if (settled) return;
              total += chunk.length;
              if (total > maxBytes) { finish(fail('Image exceeds byte limit')); return; }
              chunks.push(chunk);
            });
            incoming.on('aborted', () => finish(fail('Image download failed')));
            incoming.on('end', () => {
              if (declared !== undefined && total !== Number(declared)) finish(fail('Image download failed'));
              else finish(undefined, Buffer.concat(chunks, total));
            });
            incoming.on('close', () => { if (!incoming.complete) finish(fail('Image download failed')); });
          });
          req.on('error', () => finish(fail('Image download failed')));
          if (signal.aborted) onAbort();
          if (settled) req.destroy();
          else req.end();
        } catch { finish(fail('Image download failed')); }
      });
      log('info', 'image.download_complete', { ...metrics(), bytes: bytes.length, input_bytes: bytes.length, outcome: 'success' });
      phase = 'decode'; stageStarted = performance.now();
      return await decode(bytes, signal);
    } catch {
      log(callerSignal?.aborted && !timedOut ? 'info' : 'warn', 'image.download_failed', { ...metrics(),
        reason: timedOut ? 'timeout' : callerSignal?.aborted ? 'cancelled' : phase === 'dns' ? 'dns_rejected' : phase === 'decode' ? 'decode_failed' : 'transfer_failed' });
      // Never include remote exception messages, URL tokens, response text, or binary data.
      throw fail(timedOut ? 'Image download timed out' : callerSignal?.aborted ? 'Image operation aborted' : 'Image download failed');
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', cancel);
    }
  };
}

export function createImageDownloader(dependencies: ImageDownloadDependencies = {}): ImageDownloader {
  return createSafeImageDownloader(dependencies, validateImageUrl, prepareImage);
}

/** Native group sends retain their previous normalized 2048px policy, not model previews. */
export function createSendImageDownloader(dependencies: ImageDownloadDependencies = {}): ImageDownloader {
  return createSafeImageDownloader(dependencies, validateImageUrl,
    (bytes, signal) => prepareNormalizedImage(bytes, 2048, signal));
}
export const downloadSendImage: ImageDownloader = createSendImageDownloader();

export interface OriginalImage {
  bytes: Buffer;
  md5: string;
  format: 'jpeg' | 'png' | 'gif' | 'webp';
  /** Encoded dimensions of a single frame; no EXIF rotation or resizing is applied. */
  width: number;
  height: number;
  animated: boolean;
}
export type OriginalImageDownloader = (url: string, maxBytes: number, signal?: AbortSignal) => Promise<OriginalImage>;

/** Only for already-authorized native collection URLs, never arbitrary model URLs.
 * HTTP input is upgraded before DNS/network work. Generic view_images policy is unchanged. */
export function validateCustomFaceImageUrl(value: string): URL {
  let url: URL;
  try {
    if (typeof value !== 'string' || /[\s\\]/.test(value)) throw fail('Invalid image URL');
    url = new URL(value);
  } catch { throw fail('Invalid image URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.port !== '' || url.username || url.password ||
      url.hash || value.includes('#')) throw fail('Image URL is not allowed');
  if (url.hostname === 'p.qpic.cn') {
    // Native collection URL shape verified from fetch_custom_face_detail. The
    // two numeric fields are not assumed to carry the same identity.
    if (value.includes('?') || !/^\/qq_expression\/[1-9]\d{0,31}\/[1-9]\d{0,31}_0_0_0_[a-fA-F0-9]{32}_0_0\/0$/.test(url.pathname)) {
      throw fail('Image URL is not allowed');
    }
  } else if (!IMAGE_HOSTS.has(url.hostname)) {
    if (!['gxh.vip.qq.com', 'i.gtimg.cn'].includes(url.hostname) || url.search) throw fail('Image URL is not allowed');
    const path = /^\/club\/item\/parcel\/item\/([a-fA-F0-9]{2})\/([a-fA-F0-9]{32})\/raw(?:200|300)\.gif$/.exec(url.pathname);
    if (!path || path[1]!.toLowerCase() !== path[2]!.slice(0, 2).toLowerCase()) throw fail('Image URL is not allowed');
  }
  url.protocol = 'https:';
  return url;
}

const MAX_ORIGINAL_FRAMES = 512;

/** Bound GIF logical canvases as well as decoded frame extents: libvips can
 * report only the image rectangles, ignoring a maliciously oversized canvas. */
function validateGifStructure(bytes: Buffer): { width: number; height: number; frames: number } {
  if (bytes.length < 13) throw fail('Image decoding failed');
  const width = bytes.readUInt16LE(6), height = bytes.readUInt16LE(8);
  if (!width || !height || width * height > MAX_PIXELS) throw fail('Image decoding failed');
  let offset = 13, frames = 0;
  const consume = (length: number) => {
    if (length > bytes.length - offset) throw fail('Image decoding failed');
    offset += length;
  };
  const blocks = () => {
    while (true) {
      if (offset >= bytes.length) throw fail('Image decoding failed');
      const length = bytes[offset++]!;
      if (!length) return;
      consume(length);
    }
  };
  if (bytes[10]! & 0x80) consume(3 * (2 ** ((bytes[10]! & 7) + 1)));
  while (offset < bytes.length) {
    const tag = bytes[offset++]!;
    if (tag === 0x3b) {
      if (!frames || offset !== bytes.length) throw fail('Image decoding failed');
      return { width, height, frames };
    }
    if (tag === 0x21) { consume(1); blocks(); continue; }
    if (tag !== 0x2c || bytes.length - offset < 9) throw fail('Image decoding failed');
    const left = bytes.readUInt16LE(offset), top = bytes.readUInt16LE(offset + 2);
    const frameWidth = bytes.readUInt16LE(offset + 4), frameHeight = bytes.readUInt16LE(offset + 6);
    const packed = bytes[offset + 8]!;
    consume(9);
    if (!frameWidth || !frameHeight || left + frameWidth > width || top + frameHeight > height ||
        ++frames > MAX_ORIGINAL_FRAMES || width * height * frames > MAX_PIXELS) throw fail('Image decoding failed');
    if (packed & 0x80) consume(3 * (2 ** ((packed & 7) + 1)));
    if (offset >= bytes.length || bytes[offset]! < 2 || bytes[offset]! > 8) throw fail('Image decoding failed');
    consume(1); blocks();
  }
  throw fail('Image decoding failed');
}

/** libvips does not validate APNG's additional frames. Do not treat it as a fully
 * validated static PNG and pass its unvalidated animation on to another decoder. */
function rejectApng(bytes: Buffer): void {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) throw fail('Image decoding failed');
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    if (kind === 'acTL' || kind === 'fcTL' || kind === 'fdAT') throw fail('Image decoding failed');
    offset += length + 12;
    if (kind === 'IEND') {
      if (offset !== bytes.length) throw fail('Image decoding failed');
      return;
    }
  }
  throw fail('Image decoding failed');
}

/** Validate all frames, but return a private copy of the exact original bytes.
 * Decoded pixels are temporary validation data, never the returned/sendable image. */
export async function validateOriginalImage(input: Buffer, callerSignal?: AbortSignal): Promise<OriginalImage> {
  checkAbort(callerSignal);
  if (!Buffer.isBuffer(input) || input.length === 0 || input.length > MAX_INPUT_BYTES) throw fail('Invalid image data size');
  const bytes = Buffer.from(input);
  if (!hasSupportedImageSignature(bytes)) throw fail('Image decoding failed');
  rejectApng(bytes);
  const expectedFormat: OriginalImage['format'] = bytes[0] === 0xff ? 'jpeg' : bytes[0] === 0x89 ? 'png' : bytes[0] === 0x47 ? 'gif' : 'webp';
  const gif = expectedFormat === 'gif' ? validateGifStructure(bytes) : undefined;
  const controller = new AbortController(), signal = controller.signal;
  const cancel = () => controller.abort();
  callerSignal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, 15_000);
  let decoder: ReturnType<typeof sharp> | undefined;
  const stop = () => decoder?.destroy();
  signal.addEventListener('abort', stop, { once: true });
  try {
    decoder = sharp(bytes, { animated: true, limitInputPixels: MAX_PIXELS, failOn: 'warning' });
    decoder.timeout({ seconds: 10 });
    const work = (async (): Promise<OriginalImage> => {
      const metadata = await decoder!.metadata();
      const { width, height } = metadata;
      const pages = metadata.pages ?? 1;
      const frameHeight = metadata.pageHeight ?? height;
      if (metadata.format !== expectedFormat || !Number.isSafeInteger(width) || !width || width < 1 ||
          !Number.isSafeInteger(height) || !height || height < 1 ||
          !Number.isSafeInteger(pages) || pages < 1 || pages > MAX_ORIGINAL_FRAMES ||
          !Number.isSafeInteger(frameHeight) || !frameHeight || frameHeight < 1 ||
          height !== frameHeight * pages || width * height > MAX_PIXELS ||
          (pages > 1 && expectedFormat !== 'gif' && expectedFormat !== 'webp') ||
          (gif && (width > gif.width || frameHeight > gif.height || gif.frames !== pages))) throw fail('Image decoding failed');
      checkAbort(signal);
      // sRGB+alpha bounds the raw validation allocation to four bytes per pixel.
      const { data, info } = await decoder!.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      checkAbort(signal);
      if (info.width !== width || info.height !== height || info.channels !== 4 ||
          data.length !== width * height * 4) throw fail('Image decoding failed');
      return { bytes, md5: createHash('md5').update(bytes).digest('hex'), format: expectedFormat,
        width: gif?.width ?? width, height: gif?.height ?? frameHeight, animated: pages > 1 };
    })();
    const result = await abortable(work, signal);
    checkAbort(signal);
    return result;
  } catch {
    throw fail(signal.aborted ? 'Image operation aborted' : 'Image decoding failed');
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', cancel);
    signal.removeEventListener('abort', stop);
    decoder?.destroy();
  }
}

export function createOriginalImageDownloader(dependencies: ImageDownloadDependencies = {}): OriginalImageDownloader {
  return createSafeImageDownloader(dependencies, validateCustomFaceImageUrl, validateOriginalImage);
}

export const downloadOriginalImage: OriginalImageDownloader = createOriginalImageDownloader();
export const downloadImage: ImageDownloader = createImageDownloader();
export default downloadImage;
/** Decode a normalized model image into RGBA pixels for sandbox code (first frame only). */
export async function imagePixels(dataUrl: string): Promise<{ width: number; height: number; pixels: Uint8Array }> {
  const match = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match) throw new Error('invalid_image');
  const { data, info } = await sharp(Buffer.from(match[1]!, 'base64'), { pages: 1, limitInputPixels: MODEL_IMAGE_MAX_EDGE * MODEL_IMAGE_MAX_EDGE * 4 })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error('invalid_image');
  return { width: info.width, height: info.height, pixels: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}
