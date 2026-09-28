import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { configureLogging, withLogContext } from '../src/observability/logger.js';
import { createImageDownloader, prepareImage, type ImageDownloadDependencies } from '../src/tools/images/download.js';
import { ImageTools } from '../src/tools/images/tools.js';
import { LISTENER_GROUP, type Memory } from '../src/contracts/index.js';

const secret = 'PRIVATE_IMAGE_HEADER_BODY_TOKEN';
const url = `https://gchat.qpic.cn/image?token=${secret}`;
async function capture(work: () => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'listener-image-log-'));
  const logger = configureLogging({ level: 'debug', console: false, file: true, directory, retentionDays: 1, maxFileMb: 1, maxTotalMb: 2 });
  try {
    await withLogContext({ turn_id: 't_0123456789abcdef' }, work);
    await logger.flush();
    const text = (await Promise.all((await readdir(directory)).map(name => readFile(join(directory, name), 'utf8')))).join('');
    assert.ok(!text.includes(secret)); assert.ok(!text.includes('https://')); assert.ok(!text.includes('base64'));
    return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, any>);
  } finally { await logger.close(); await rm(directory, { recursive: true, force: true }); }
}
function network(body: Buffer, status = 200): ImageDownloadDependencies {
  return {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: (_options, callback) => {
      const req = new EventEmitter() as ClientRequest;
      req.destroy = (() => req) as ClientRequest['destroy'];
      req.end = (() => {
        queueMicrotask(() => {
          const stream = new PassThrough() as unknown as IncomingMessage;
          stream.statusCode = status; stream.headers = { 'x-secret': secret }; stream.complete = true;
          callback(stream);
          if (!stream.destroyed) { stream.push(body); stream.push(null); }
        });
        return req;
      }) as ClientRequest['end'];
      return req;
    },
  };
}

test('actual transfer and native decode have separate timings and inherit image ID from ImageTools', async () => {
  const bytes = await sharp({ create: { width: 8, height: 4, channels: 3, background: 'red' } }).png().toBuffer();
  const rows = await capture(async () => {
    const memory: Memory = { recent: () => [{ messageId: '1', userId: '123', nickname: secret, text: secret, time: 1, images: [{ id: 'img_1_0', index: 0 }] }], find: () => undefined, append: () => true, context: () => '', compact: async () => {}, clear() {}, close() {} };
    const tools = new ImageTools({ async call() { return { message_type: 'group', group_id: LISTENER_GROUP, message_id: '1', sender: { user_id: '123', card: secret }, message: [{ type: 'image', data: { url } }] }; } }, memory,
      { enabled: true, maxPerTurn: 1, maxDownloadMb: 1 }, createImageDownloader(network(bytes)));
    const result = await tools.view({ image_ids: ['img_1_0'] }, { actorId: '123', selfId: '999', groupId: LISTENER_GROUP, messageId: '1' }, tools.createTurn());
    assert.equal(result.result.status, 'ok');
  });
  const low = rows.filter(row => /^image\.(download|decode)_/.test(row.event));
  assert.deepEqual(low.map(row => row.event), ['image.download_start', 'image.download_complete', 'image.decode_start', 'image.decode_complete']);
  for (const row of low) { assert.equal(row.image_id, 'img_1_0'); assert.equal(row.turn_id, 't_0123456789abcdef'); }
  const transfer = low[1]!; const decode = low[3]!;
  assert.equal(transfer.phase, 'download'); assert.equal(transfer.bytes, bytes.length); assert.equal(transfer.http_status, 200);
  assert.equal(decode.phase, 'decode'); assert.equal(decode.width, 8); assert.equal(decode.height, 4);
  assert.equal(decode.input_bytes, bytes.length); assert.ok(decode.output_bytes > 0);
  assert.ok(transfer.duration_ms >= 0); assert.ok(decode.duration_ms >= 0);
});

test('downloader classifies rejected URL DNS transfer decode and timeout without changing public errors', async () => {
  const rows = await capture(async () => {
    await assert.rejects(createImageDownloader(network(Buffer.from(secret)))(`https://example.invalid/${secret}`, 1024), /^Error: Image URL is not allowed$/);
    await assert.rejects(createImageDownloader({ ...network(Buffer.from(secret)), lookup: async () => { throw Error(secret); } })(url, 1024), /^Error: Image download failed$/);
    await assert.rejects(createImageDownloader(network(Buffer.from(secret), 403))(url, 1024), /^Error: Image download failed$/);
    await assert.rejects(createImageDownloader(network(Buffer.from(secret)))(url, 1024), /^Error: Image download failed$/);
    await assert.rejects(createImageDownloader({ lookup: async () => new Promise(() => {}), timeoutMs: 5 })(url, 1024), /^Error: Image download timed out$/);
    const controller = new AbortController(); controller.abort(Error(secret));
    await assert.rejects(createImageDownloader()(url, 1024, controller.signal), /^Error: Image operation aborted$/);
  });
  const failures = rows.filter(row => row.event === 'image.download_failed');
  assert.deepEqual(failures.map(row => [row.phase, row.reason]), [
    ['url_validation', 'url_rejected'], ['dns', 'dns_rejected'], ['download', 'transfer_failed'], ['decode', 'decode_failed'], ['dns', 'timeout'], ['url_validation', 'cancelled'],
  ]);
  assert.equal(failures[2]!.http_status, 403);
  for (const row of failures) assert.ok(row.duration_ms >= 0);
  assert.ok(!rows.some(row => row.event === 'image.decode_start')); // Signature rejection occurs before native decoder.
});

test('native decoder logs sanitized failure only after byte size and signature gates pass', async () => {
  const rows = await capture(async () => {
    await assert.rejects(prepareImage(Buffer.from(secret)), /^Error: Image decoding failed$/);
    await assert.rejects(prepareImage(Buffer.from([0xff, 0xd8, 0xff, ...Buffer.from(secret)])), /^Error: Image decoding failed$/);
  });
  assert.deepEqual(rows.map(row => row.event), ['image.decode_start', 'image.decode_failed']);
  assert.equal(rows[1]!.reason, 'decode_failed'); assert.equal(rows[1]!.phase, 'decode'); assert.ok(rows[1]!.duration_ms >= 0);
});
