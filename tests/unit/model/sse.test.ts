import test from 'node:test';
import assert from 'node:assert/strict';
import { readSse, SseError } from '../../../src/model/sse.ts';

function stream(
  chunks: Uint8Array[],
  onCancel?: () => void,
): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

const utf8 = (value: string) => new TextEncoder().encode(value);

async function collect(
  body: ReadableStream<Uint8Array>,
  options: Partial<Parameters<typeof readSse>[2]> = {},
) {
  const events: Array<{ data: string; at: number }> = [];
  await readSse(
    body,
    (data, at) => {
      if (data === '[DONE]') {
        return true;
      }
      events.push({ data, at });
    },
    { maxBytes: 1024, ...options },
  );
  return events;
}

test('parses UTF-8 and CRLF split across chunks', async () => {
  const bytes = utf8('data: 你好\r\n\r\ndata: [DONE]\r\n\r\n');
  const events = await collect(
    stream([bytes.subarray(0, 8), bytes.subarray(8, 11), bytes.subarray(11)]),
  );
  assert.deepEqual(
    events.map((x) => x.data),
    ['你好'],
  );
});

test('supports CR separators split across chunks', async () => {
  const events = await collect(
    stream([utf8('data: first\r'), utf8('\rdata: second\r\rdata: [DONE]\r\r')]),
  );
  assert.deepEqual(
    events.map((x) => x.data),
    ['first', 'second'],
  );
});

test('events from one network read share one arrival timestamp', async () => {
  const events = await collect(
    stream([utf8('data: a\n\ndata: b\n\ndata: [DONE]\n\n')]),
  );
  assert.equal(events.length, 2);
  assert.equal(events[0]!.at, events[1]!.at);
});

test('strips BOM, ignores comments and unknown fields, and joins multiple data lines', async () => {
  const events = await collect(
    stream([
      utf8(
        '\uFEFF: heartbeat\nunknown: ignored\ndata: one\ndata: two\n\ndata: [DONE]\n\n',
      ),
    ]),
  );
  assert.deepEqual(
    events.map((x) => x.data),
    ['one\ntwo'],
  );
});

test('does not emit incomplete event at EOF and rejects non-terminal EOF', async () => {
  await assert.rejects(
    collect(stream([utf8('data: incomplete\n')])),
    (error: unknown) =>
      error instanceof SseError && error.code === 'invalid_response',
  );
});

test('rejects invalid UTF-8', async () => {
  await assert.rejects(
    collect(
      stream([
        Uint8Array.of(0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0x0a, 0x0a),
      ]),
    ),
    (error: unknown) =>
      error instanceof SseError && error.code === 'invalid_response',
  );
});

test('enforces byte cap', async () => {
  await assert.rejects(
    readSse(stream([utf8('data: too-large\n\n')]), () => {}, { maxBytes: 4 }),
    (error: unknown) =>
      error instanceof SseError && error.code === 'response_too_large',
  );
});

test('terminal callback cancels the body and returns without requiring EOF', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(utf8('data: done\n\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const seen: string[] = [];
  await readSse(
    body,
    (data) => {
      seen.push(data);
      return true;
    },
    { maxBytes: 1024 },
  );
  assert.deepEqual(seen, ['done']);
  assert.equal(cancelled, true);
});

test('dispatches an explicit empty data field as an empty event', async () => {
  const events = await collect(
    stream([utf8('event: ping\n\n'), utf8('data:\n\ndata: [DONE]\n\n')]),
  );
  assert.deepEqual(
    events.map((x) => x.data),
    [''],
  );
});
