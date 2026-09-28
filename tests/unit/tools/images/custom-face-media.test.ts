import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import sharp from 'sharp';
import { createOriginalImageDownloader, downloadOriginalImage, prepareImage, validateCustomFaceImageUrl,
  validateImageUrl, validateOriginalImage, type ImageDownloadDependencies } from '../../../../src/tools/images/download.js';

const URL = 'https://gchat.qpic.cn/image?token=SECRET';
const png = () => sharp({ create: { width: 8, height: 4, channels: 4, background: '#ff000080' } }).png().toBuffer();
async function animation(pages = 2): Promise<Buffer> {
  const frames = Buffer.alloc(4 * 4 * 3 * pages);
  for (let i = 0; i < pages; i++) frames.fill((i * 127) % 256, i * 48, (i + 1) * 48);
  return sharp(frames, { raw: { width: 4, height: 4 * pages, channels: 3, pageHeight: 4 } })
    .gif({ loop: 0, delay: Array(pages).fill(100), keepDuplicateFrames: true }).toBuffer();
}
function network(bytes: Buffer, options: { status?: number; headers?: Record<string, string | undefined>; hang?: boolean } = {}) {
  let requestOptions: RequestOptions | undefined, requests = 0, destroyed = false;
  const request: NonNullable<ImageDownloadDependencies['request']> = (opts, callback) => {
    requestOptions = opts; requests++;
    const req = new EventEmitter() as ClientRequest;
    req.destroy = (() => { destroyed = true; return req; }) as ClientRequest['destroy'];
    req.end = (() => {
      if (!options.hang) queueMicrotask(() => {
        const response = new PassThrough() as unknown as IncomingMessage;
        response.statusCode = options.status ?? 200; response.headers = options.headers ?? {}; response.complete = true;
        callback(response);
        if (!response.destroyed) { response.push(bytes); response.push(null); }
      });
      return req;
    }) as ClientRequest['end'];
    return req;
  };
  const lookup: NonNullable<ImageDownloadDependencies['lookup']> = async () => [{ address: '8.8.8.8', family: 4 }];
  return { lookup, request, get options() { return requestOptions; }, get requests() { return requests; }, get destroyed() { return destroyed; } };
}

test('original images preserve exact PNG/JPEG/GIF/WebP bytes and MD5, including metadata', async () => {
  const source = await png();
  const variants = [source, await sharp(source).withMetadata({ orientation: 6 }).jpeg().toBuffer(),
    await sharp(source).gif().toBuffer(), await sharp(source).webp().toBuffer()];
  for (const bytes of variants) {
    const result = await validateOriginalImage(bytes);
    assert.deepEqual(result.bytes, bytes); assert.notEqual(result.bytes, bytes);
    assert.equal(result.md5, createHash('md5').update(bytes).digest('hex'));
    assert.equal(result.format, (await sharp(bytes).metadata()).format);
    assert.equal(result.width, 8); assert.equal(result.height, 4); assert.equal(result.animated, false);
  }
  assert.equal(typeof downloadOriginalImage, 'function');
});

test('animated GIF stays original while existing preview explicitly flattens the first frame', async () => {
  const gif = await animation();
  const original = await validateOriginalImage(gif);
  assert.deepEqual(original.bytes, gif); assert.equal(original.format, 'gif'); assert.equal(original.animated, true);
  assert.equal(original.width, 4); assert.equal(original.height, 4);
  assert.equal((await sharp(original.bytes).metadata()).pages, 2);
  const preview = await prepareImage(gif);
  assert.equal(preview.firstFrameOnly, true); assert.equal(preview.width, 4); assert.equal(preview.height, 4);
  assert.match(preview.dataUrl, /^data:image\/jpeg;base64,/);
  const webp = await sharp(gif, { animated: true }).webp({ lossless: true }).toBuffer();
  const checkedWebp = await validateOriginalImage(webp);
  assert.equal(checkedWebp.animated, true); assert.deepEqual(checkedWebp.bytes, webp);
});

test('validation snapshots input bytes before awaiting native metadata', async () => {
  const bytes = await png(), expected = Buffer.from(bytes);
  const pending = validateOriginalImage(bytes); bytes.fill(0);
  assert.deepEqual((await pending).bytes, expected);
});

test('signature spoofing, unsupported formats, malformed metadata and incomplete pixel data fail closed', async () => {
  const source = await png();
  for (const bytes of [Buffer.from('<svg>SECRET</svg>'), Buffer.from('%PDF-1.7 SECRET'),
    Buffer.from('RIFF0000WAVE'), Buffer.from([255, 216, 255, 0]), await sharp(source).tiff().toBuffer(),
    source.subarray(0, 40), source.subarray(0, source.length - 15), Buffer.alloc(0)]) {
    await assert.rejects(validateOriginalImage(bytes), error => {
      assert.match((error as Error).message, /^(Image decoding failed|Invalid image data size)$/);
      assert.doesNotMatch((error as Error).message, /SECRET|Vips|pngload/); return true;
    });
  }
  const invalidSize = Buffer.from(await animation()); invalidSize.writeUInt16LE(0, 6);
  await assert.rejects(validateOriginalImage(invalidSize), /Image decoding failed/);
});

test('valid larger GIF canvases remain original and pixel decoding is not replaced by metadata inspection', async () => {
  const gif = Buffer.from(await animation()); gif.writeUInt16LE(20, 6); gif.writeUInt16LE(30, 8);
  const result = await validateOriginalImage(gif);
  assert.equal(result.width, 20); assert.equal(result.height, 30); assert.deepEqual(result.bytes, gif);
  const jpeg = await sharp(await png()).jpeg().toBuffer();
  const truncated = jpeg.subarray(0, jpeg.length - 2);
  assert.equal((await sharp(truncated).metadata()).format, 'jpeg');
  await assert.rejects(validateOriginalImage(truncated), /Image decoding failed/);
});

test('unvalidated APNG animation and trailing PNG data are rejected', async () => {
  const source = await png();
  const actl = Buffer.alloc(20); actl.writeUInt32BE(8); actl.write('acTL', 4); actl.writeUInt32BE(2, 8);
  await assert.rejects(validateOriginalImage(Buffer.concat([source.subarray(0, 33), actl, source.subarray(33)])), /Image decoding failed/);
  await assert.rejects(validateOriginalImage(Buffer.concat([source, Buffer.from('SECRET')])), /Image decoding failed/);
});

test('bounded 150-frame and limit-boundary 512-frame GIFs preserve all original frames and bytes', async () => {
  for (const pages of [150, 512]) {
    const bytes = await animation(pages);
    const result = await validateOriginalImage(bytes);
    assert.deepEqual(result.bytes, bytes); assert.equal(result.animated, true);
    assert.equal(result.width, 4); assert.equal(result.height, 4);
    assert.equal((await sharp(result.bytes).metadata()).pages, pages);
    assert.equal(result.md5, createHash('md5').update(bytes).digest('hex'));
  }
});

test('byte, frame and aggregate animation pixel limits apply before accepting originals', async () => {
  await assert.rejects(validateOriginalImage(Buffer.alloc(10 * 1024 * 1024 + 1)), /Invalid image data size/);
  const manyFrames = await animation(513);
  assert.equal((await sharp(manyFrames).metadata()).pages, 513);
  await assert.rejects(validateOriginalImage(manyFrames), /Image decoding failed/);
  // Each frame is below 40M pixels, but two full canvases exceed the aggregate cap.
  const hugeAnimation = Buffer.from(await animation());
  hugeAnimation.writeUInt16LE(6000, 6); hugeAnimation.writeUInt16LE(4000, 8);
  await assert.rejects(validateOriginalImage(hugeAnimation), /Image decoding failed/);
});

test('collection URL policy upgrades only known hosts and leaves generic image policy unchanged', () => {
  for (const host of ['gchat.qpic.cn', 'c2cpicdw.qpic.cn', 'multimedia.nt.qq.com.cn']) {
    assert.equal(validateCustomFaceImageUrl(`http://${host}/image?rkey=SECRET`).protocol, 'https:');
    assert.throws(() => validateImageUrl(`http://${host}/image`));
  }
  for (const host of ['gxh.vip.qq.com', 'i.gtimg.cn']) {
    for (const size of [200, 300]) {
      const url = `https://${host}/club/item/parcel/item/ab/${'ab'.repeat(16)}/raw${size}.gif`;
      assert.equal(validateCustomFaceImageUrl(url).href, url); assert.throws(() => validateImageUrl(url));
      assert.equal(validateCustomFaceImageUrl(url.replace('https:', 'http:')).href, url);
    }
  }
  for (const value of ['file:///etc/passwd', 'data:image/png;base64,AAA', 'http://evil.test/image',
    'https://gchat.qpic.cn.evil.test/image', 'https://gchat.qpic.cn./image', 'https://127.0.0.1/image',
    'https://SECRET@gchat.qpic.cn/image', 'https://gchat.qpic.cn/image#', 'https://gchat.qpic.cn:444/image',
    'http://gchat.qpic.cn:443/image', 'https://gchat.qpic.cn\\@evil.test/image',
    'https://gxh.vip.qq.com/arbitrary.gif', 'https://i.gtimg.cn/club/item/parcel/1/1.json',
    `https://i.gtimg.cn/club/item/parcel/item/00/${'ab'.repeat(16)}/raw300.gif`,
    `https://i.gtimg.cn/club/item/parcel/item/ab/${'ab'.repeat(16)}/raw300.gif?url=SECRET`,
    `https://i.gtimg.cn/club/item/parcel/item/ab/${'ab'.repeat(16)}/%72aw300.gif`]) {
    assert.throws(() => validateCustomFaceImageUrl(value), /^(Error: Invalid image URL|Error: Image URL is not allowed)$/);
  }
});

test('native p.qpic.cn collection paths are narrow, query-free and separate from generic image policy', async () => {
  const md5 = 'aB'.repeat(16);
  const path = `/qq_expression/100000001/100000002_0_0_0_${md5}_0_0/0`;
  const valid = `https://p.qpic.cn${path}`;
  assert.equal(validateCustomFaceImageUrl(valid).href, valid);
  assert.equal(validateCustomFaceImageUrl(valid.replace('https:', 'http:')).href, valid);
  assert.throws(() => validateImageUrl(valid), /Image URL is not allowed/);
  assert.throws(() => validateImageUrl(valid.replace('https:', 'http:')), /Image URL is not allowed/);
  const maxDigits = '9'.repeat(32);
  assert.equal(validateCustomFaceImageUrl(`https://p.qpic.cn/qq_expression/${maxDigits}/1_0_0_0_${md5}_0_0/0`).hostname, 'p.qpic.cn');
  for (const value of [
    'https://p.qpic.cn/arbitrary.png', 'https://p.qpic.cn/',
    valid.replace('p.qpic.cn', 'p.qpic.cn.evil.test'), valid.replace('p.qpic.cn', 'p.qpic.cn.'),
    `${valid}?`, `${valid}?rkey=SECRET`, `${valid}#`, `${valid}/`,
    valid.replace('/100000001/', '/0/'), valid.replace('/100000001/', '/0100000001/'),
    valid.replace('/100000001/', `/${'9'.repeat(33)}/`),
    valid.replace('/100000002_', '/0_'), valid.replace('/100000002_', '/0100000002_'),
    valid.replace('/100000002_', `/${'9'.repeat(33)}_`),
    valid.replace('_0_0_0_', '_0_1_0_'), valid.replace(md5, md5.slice(1)),
    valid.replace(md5, `${md5.slice(0, -1)}G`), valid.replace(md5, `%61${md5.slice(1)}`),
    valid.replace(/\/0$/, '/200'), valid.replace('qq_expression', 'other_expression'),
    valid.replace('https://', 'https://SECRET@'), valid.replace('p.qpic.cn', 'p.qpic.cn:444'),
  ]) assert.throws(() => validateCustomFaceImageUrl(value), /Image URL is not allowed/);
  const bytes = await png(), net = network(bytes);
  const result = await createOriginalImageDownloader(net)(valid.replace('https:', 'http:'), 1024);
  assert.deepEqual(result.bytes, bytes); assert.equal(net.options!.protocol, 'https:');
  assert.equal(net.options!.port, 443); assert.equal(net.options!.hostname, 'p.qpic.cn');
  assert.equal(net.options!.servername, 'p.qpic.cn'); assert.equal(net.options!.path, path);
});

test('original downloader pins public DNS, validates TLS hostname and never transmits HTTP', async () => {
  const source = await png(), net = network(source);
  const result = await createOriginalImageDownloader(net)(URL.replace('https:', 'http:'), 1024);
  assert.deepEqual(result.bytes, source);
  assert.equal(net.options!.protocol, 'https:'); assert.equal(net.options!.port, 443);
  assert.equal(net.options!.servername, 'gchat.qpic.cn'); assert.equal(net.options!.rejectUnauthorized, true);
  assert.equal(net.options!.agent, false);
  const lookup = net.options!.lookup as Function;
  lookup('gchat.qpic.cn', {}, (error: Error | null, address: string, family: number) => {
    assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4);
  });
});

test('mixed/private DNS answers reject before network requests', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:8.8.8.8']) {
    const net = network(await png());
    await assert.rejects(createOriginalImageDownloader({ ...net, lookup: async () => [
      { address: '8.8.8.8', family: 4 }, { address, family: address.includes(':') ? 6 : 4 },
    ] })(URL, 1024), /^Error: Image download failed$/);
    assert.equal(net.requests, 0);
  }
});

test('redirects, encoded bodies, false lengths and oversized transfers are rejected', async () => {
  const source = await png();
  for (const options of [{ status: 302, headers: { location: 'http://127.0.0.1/SECRET' } },
    { headers: { 'content-encoding': 'gzip' } }, { headers: { 'content-length': '9999' } },
    { headers: { 'content-length': '1' } }, { headers: { 'content-length': 'SECRET' } }]) {
    const net = network(source, options);
    await assert.rejects(createOriginalImageDownloader(net)(URL, 1024), /^Error: Image download failed$/);
    assert.equal(net.requests, 1); assert.equal(net.destroyed, true);
  }
  await assert.rejects(createOriginalImageDownloader(network(source))(URL, 1), /^Error: Image download failed$/);
});

test('cancellation and deadlines cover local decoding, uncooperative DNS and hanging transfer', async () => {
  const source = await png(), before = new AbortController(); before.abort('SECRET');
  await assert.rejects(validateOriginalImage(source, before.signal), /^Error: Image operation aborted$/);
  const during = new AbortController(); const pending = validateOriginalImage(source, during.signal); during.abort('SECRET');
  await assert.rejects(pending, /^Error: Image operation aborted$/);
  const net = network(source, { hang: true });
  await assert.rejects(createOriginalImageDownloader({ ...net, timeoutMs: 5 })(URL, 1024), /^Error: Image download timed out$/);
  assert.equal(net.destroyed, true);
  await assert.rejects(createOriginalImageDownloader({ lookup: () => new Promise(() => {}), timeoutMs: 5 })(URL, 1024), /^Error: Image download timed out$/);
  const cancelled = new AbortController();
  const waiting = createOriginalImageDownloader({ lookup: () => new Promise(() => {}) })(URL, 1024, cancelled.signal);
  cancelled.abort('SECRET'); await assert.rejects(waiting, /^Error: Image operation aborted$/);
});
