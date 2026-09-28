import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ClientRequest } from 'node:http';
import type { RequestOptions } from 'node:https';
import sharp from 'sharp';
import { createImageDownloader, hasSupportedImageSignature, isPublicAddress, prepareImage, validateImageUrl, type ImageDownloadDependencies } from '../../../../src/tools/images/download.js';

const URL = 'https://gchat.qpic.cn/image?token=SECRET';
const png = () => sharp({ create: { width: 8, height: 4, channels: 4, background: '#ff000080' } }).png().toBuffer();
function fakeNetwork(body: Buffer, settings: { status?: number; headers?: Record<string, string>; chunks?: Buffer[]; hang?: boolean } = {}) {
  let options: RequestOptions | undefined;
  let destroyed = false;
  let requests = 0;
  const request: NonNullable<ImageDownloadDependencies['request']> = (opts, callback) => {
    options = opts;
    requests++;
    const req = new EventEmitter() as ClientRequest;
    req.destroy = (() => { destroyed = true; return req; }) as ClientRequest['destroy'];
    req.end = (() => {
      if (settings.hang) return req;
      queueMicrotask(() => {
        const stream = new PassThrough() as unknown as IncomingMessage;
        stream.statusCode = settings.status ?? 200;
        stream.headers = settings.headers ?? {};
        stream.complete = true;
        callback(stream);
        if (!stream.destroyed) {
          for (const chunk of settings.chunks ?? [body]) stream.push(chunk);
          stream.push(null);
        }
      });
      return req;
    }) as ClientRequest['end'];
    return req;
  };
  const lookup: NonNullable<ImageDownloadDependencies['lookup']> = async (host, opts) => {
    assert.equal(host, 'gchat.qpic.cn');
    assert.deepEqual(opts, { all: true, verbatim: true });
    return [{ address: '8.8.8.8', family: 4 }];
  };
  return { request, lookup, get options() { return options; }, get destroyed() { return destroyed; }, get requests() { return requests; } };
}

test('signature gate rejects SVG/PDF/HEIF and spoofed MIME data before native decoding', async () => {
  for (const bytes of [
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'),
    Buffer.from('%PDF-1.7 SECRET'), Buffer.from('00000018667479706865696300000000', 'hex'),
    Buffer.from('RIFF0000WAVE'), Buffer.from('GIF90a'), Buffer.from([0xff, 0xd8]),
    Buffer.from('image/png; SECRET'), Buffer.alloc(0),
  ]) {
    assert.equal(hasSupportedImageSignature(bytes), false);
    await assert.rejects(prepareImage(bytes), /^(Error: Image decoding failed|Error: Invalid image data size)$/);
  }
  const source = await png();
  for (const bytes of [source, await sharp(source).jpeg().toBuffer(), await sharp(source).gif().toBuffer(), await sharp(source).webp().toBuffer()]) {
    assert.equal(hasSupportedImageSignature(bytes), true);
  }
  // Matching magic alone is insufficient: malformed supported files still fail safely.
  await assert.rejects(prepareImage(Buffer.from([0xff, 0xd8, 0xff, 0x53, 0x45, 0x43])), /^Error: Image decoding failed$/);
});

test('URL policy rejects SSRF inputs, host suffix tricks, credentials, fragments and ports', () => {
  for (const value of [
    'http://gchat.qpic.cn/x', 'file:///etc/passwd', 'data:image/png;base64,AAAA',
    'https://localhost/x', 'https://127.0.0.1/x', 'https://2130706433/', 'https://0x7f000001/',
    'https://0177.0.0.1/', 'https://[::1]/', 'https://[::ffff:127.0.0.1]/',
    'https://gchat.qpic.cn.evil.test/', 'https://evilgchat.qpic.cn/', 'https://gchat.qpic.cn./',
    'https://gchat.qpic.cn@evil.test/', 'https://user:SECRET@gchat.qpic.cn/',
    'https://gchat.qpic.cn:444/', 'https://gchat.qpic.cn/#SECRET', 'https://gchat.qpic.cn/#',
  ]) assert.throws(() => validateImageUrl(value), /image URL/i);
  for (const host of ['gchat.qpic.cn', 'multimedia.nt.qq.com.cn', 'c2cpicdw.qpic.cn']) {
    assert.equal(validateImageUrl(`https://${host}:443/x`).hostname, host);
  }
});

test('IP policy accepts only canonical public global unicast', () => {
  for (const address of [
    '127.0.0.1', '127.1', '2130706433', '0x08080808', '010.0.0.1', '10.0.0.1', '172.16.0.1',
    '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '192.0.0.1', '192.0.2.1',
    '198.51.100.1', '203.0.113.1', '198.18.0.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:8.8.8.8', '::ffff:127.0.0.1',
    '64:ff9b::808:808', '2001:db8::1', '2001::1', '2002:808:808::', '3fff::1',
    'fe80::1%eth0', '2606:4700::1111%eth0', '100::1', '4000::1',
  ]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '240e::1']) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test('download validates every DNS record, pins address, retains TLS hostname and minimal headers', async () => {
  const fake = fakeNetwork(await png());
  const result = await createImageDownloader(fake)(URL, 1024);
  assert.equal(result.width, 8);
  assert.equal(fake.options?.hostname, 'gchat.qpic.cn');
  assert.equal(fake.options?.servername, 'gchat.qpic.cn');
  assert.equal(fake.options?.rejectUnauthorized, true);
  assert.equal(fake.options?.agent, false);
  assert.deepEqual(Object.keys(fake.options!.headers!).sort(), ['Accept', 'Accept-Encoding']);
  const pinned = fake.options!.lookup as Function;
  pinned('ignored.evil', {}, (err: Error | null, address: string, family: number) => {
    assert.equal(err, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4);
  });
  pinned('ignored', { all: true }, (err: Error | null, entries: unknown) => {
    assert.equal(err, null); assert.deepEqual(entries, [{ address: '8.8.8.8', family: 4 }]);
  });
  for (const records of [[], [{ address: '8.8.8.8', family: 6 }],
    [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]]) {
    const blocked = fakeNetwork(await png());
    await assert.rejects(createImageDownloader({ ...blocked, lookup: async () => records })(URL, 1024), /Image download failed/);
    assert.equal(blocked.requests, 0);
  }
});

test('rejects redirects, HTTP errors, encoded bodies and declared or streamed oversize without leaking data', async () => {
  const body = Buffer.from('SECRET remote error body');
  for (const settings of [
    { status: 301, headers: { location: 'https://localhost/SECRET' } }, { status: 500 },
    { headers: { 'content-length': '1025' } }, { headers: { 'content-length': 'SECRET' } },
    { headers: { 'content-encoding': 'gzip' } }, { headers: { 'content-length': '1' } },
    { chunks: [Buffer.alloc(600), Buffer.alloc(600)] },
  ] as NonNullable<Parameters<typeof fakeNetwork>[1]>[]) {
    const fake = fakeNetwork(body, settings);
    await assert.rejects(createImageDownloader(fake)(URL, 1024), error => {
      assert.equal((error as Error).message, 'Image download failed'); return true;
    });
    assert.equal(fake.requests, 1);
    assert.equal(fake.destroyed, true);
  }
  for (const limit of [0, -1, 1.5, NaN, Infinity, 10 * 1024 * 1024 + 1]) {
    await assert.rejects(createImageDownloader(fakeNetwork(body))(URL, limit), /Invalid image byte limit/);
  }
  await assert.rejects(createImageDownloader(fakeNetwork(body))(URL, 1), /Image download failed/);
});

test('total deadline includes hanging DNS and hanging transport; abort never exposes reason', async () => {
  await assert.rejects(createImageDownloader({ lookup: () => new Promise(() => {}), timeoutMs: 10 })(URL, 1024), /timed out/);
  const fake = fakeNetwork(Buffer.alloc(0), { hang: true });
  await assert.rejects(createImageDownloader({ ...fake, timeoutMs: 10 })(URL, 1024), /timed out/);
  assert.equal(fake.destroyed, true);
  const streaming = fakeNetwork(Buffer.alloc(0), { hang: true });
  const streamingController = new AbortController();
  const streamingWork = createImageDownloader(streaming)(URL, 1024, streamingController.signal);
  await new Promise<void>(resolve => setImmediate(resolve));
  streamingController.abort('SECRET');
  await assert.rejects(streamingWork, /Image operation aborted/);
  assert.equal(streaming.destroyed, true);
  const already = new AbortController(); already.abort('SECRET');
  await assert.rejects(createImageDownloader(fake)(URL, 1024, already.signal), /Image operation aborted/);
  const during = new AbortController();
  const work = createImageDownloader({ lookup: () => new Promise(() => {}), timeoutMs: 1000 })(URL, 1024, during.signal);
  during.abort(new Error('SECRET'));
  await assert.rejects(work, /Image operation aborted/);
  await assert.rejects(createImageDownloader({ lookup: async () => { throw new Error('SECRET'); } })(URL, 1024), /^Error: Image download failed$/);
});

test('real PNG/JPEG/GIF decode produces only JPEG with first-frame policy and stripped metadata', async () => {
  const source = await png();
  const jpeg = await sharp(source).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const gif = await sharp(source).gif().toBuffer();
  const webp = await sharp(source).webp().toBuffer();
  for (const [bytes, firstFrameOnly] of [[source, false], [jpeg, false], [gif, true], [webp, false]] as const) {
    const result = await prepareImage(bytes);
    assert.match(result.dataUrl, /^data:image\/jpeg;base64,/);
    assert.equal(result.firstFrameOnly, firstFrameOnly);
    const output = await sharp(Buffer.from(result.dataUrl.split(',')[1]!, 'base64')).metadata();
    assert.equal(output.format, 'jpeg'); assert.equal(output.exif, undefined); assert.equal(output.icc, undefined);
    assert.equal(output.orientation, undefined);
    assert.equal(result.width, bytes === jpeg ? 4 : 8);
    assert.equal(result.height, bytes === jpeg ? 8 : 4);
  }
  const frames = Buffer.concat([Buffer.alloc(4 * 4 * 3, 0), Buffer.alloc(4 * 4 * 3, 255)]);
  const animated = await sharp(frames, { raw: { width: 4, height: 8, channels: 3, pageHeight: 4 } }).gif({ loop: 0, delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(animated).metadata()).pages, 2);
  const first = await prepareImage(animated);
  assert.equal(first.firstFrameOnly, true); assert.equal(first.width, 4); assert.equal(first.height, 4);
});

test('resizes without enlargement and rejects huge dimensions, malformed, HTML, SVG and unsupported formats', async () => {
  const large = await sharp({ create: { width: 4096, height: 1024, channels: 3, background: 'red' } }).png().toBuffer();
  const result = await prepareImage(large);
  assert.equal(result.width, 2048); assert.equal(result.height, 512);
  const huge = await sharp({ create: { width: 7000, height: 6000, channels: 3, background: 'red' } }).png().toBuffer();
  const tiff = await sharp(await png()).tiff().toBuffer();
  for (const bytes of [huge, tiff, Buffer.alloc(0), Buffer.from('SECRET <html>not an image</html>'),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="5" height="5"><rect width="5" height="5"/></svg>'),
    (await png()).subarray(0, 40)]) {
    await assert.rejects(prepareImage(bytes), error => {
      assert.doesNotMatch((error as Error).message, /SECRET|svg|pngload|Vips/); return true;
    });
  }
  const controller = new AbortController();
  const pending = prepareImage(large, controller.signal); controller.abort('SECRET');
  await assert.rejects(pending, /Image operation aborted/);
});
