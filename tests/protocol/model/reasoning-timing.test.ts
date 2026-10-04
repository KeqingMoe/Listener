import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIModel } from '../../../src/model/chat.ts';
import { ResponsesModel } from '../../../src/model/responses.ts';
import type { ModelRequestRecord } from '../../../src/observability/model-usage.ts';

const frame = (v: unknown) =>
  `data: ${typeof v === 'string' ? v : JSON.stringify(v)}\n\n`;
const chat = (
  delta: Record<string, unknown>,
  finish_reason: string | null = null,
) => ({ choices: [{ index: 0, delta, finish_reason }] });
const delta = (type: string, text: string, output_index = 0) => ({
  type: `response.${type}.delta`,
  delta: text,
  output_index,
  content_index: 0,
  summary_index: 0,
});
const message = (text: string, refusal = false) => ({
  type: 'message',
  role: 'assistant',
  content: [
    refusal
      ? { type: 'refusal', refusal: text }
      : { type: 'output_text', text },
  ],
});
const done = (output: unknown[], status = 'completed') => ({
  type: `response.${status}`,
  response: {
    id: 'r',
    status,
    output,
    usage: {
      input_tokens: 2,
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 4 },
    },
  },
});

for (const transport of ['chat', 'responses'] as const) {
  for (const scenario of [
    'complete',
    'pure',
    'summary',
    'summary-output',
    'none',
    'empty',
    'tool',
    'refusal',
    'late',
    'failure',
    'closed-failure',
    'truncated',
    'cancelled',
  ] as const) {
    test(`${transport} reasoning timing: ${scenario} (mock SSE, no provider)`, async (t) => {
      const records: ModelRequestRecord[] = [];
      const controller = new AbortController();
      const noReasoning = scenario === 'none' || scenario === 'empty';
      const text =
        scenario === 'none' ? '<think>ordinary text</think>' : 'answer';
      const error = [
        'failure',
        'closed-failure',
        'truncated',
        'cancelled',
      ].includes(scenario);
      const output = !['pure', 'failure', 'cancelled', 'summary'].includes(
        scenario,
      );
      let events: unknown[];
      if (transport === 'chat') {
        const reasoning = chat({
          [scenario.startsWith('summary') ? 'reasoning' : 'reasoning_content']:
            noReasoning ? '' : 'thinking',
        });
        const body =
          scenario === 'tool'
            ? chat({
                tool_calls: [
                  {
                    index: 0,
                    id: 'c',
                    type: 'function',
                    function: { name: 'finish', arguments: '{}' },
                  },
                ],
              })
            : chat(
                scenario === 'refusal' ? { refusal: text } : { content: text },
              );
        events =
          scenario === 'late'
            ? [body, reasoning]
            : [reasoning, ...(output ? [body] : [])];
        if (scenario === 'failure' || scenario === 'closed-failure') {
          events.push({ error: { message: 'failed' } });
        } else if (scenario !== 'cancelled') {
          events.push(
            chat(
              {},
              scenario === 'truncated'
                ? 'length'
                : scenario === 'tool'
                  ? 'tool_calls'
                  : 'stop',
            ),
            '[DONE]',
          );
        }
      } else {
        const reasoning = delta(
          scenario.startsWith('summary')
            ? 'reasoning_summary_text'
            : 'reasoning_text',
          noReasoning ? '' : 'thinking',
        );
        const item = {
          type: 'function_call',
          id: 'fc',
          call_id: 'c',
          name: 'finish',
          arguments: '{}',
        };
        const body =
          scenario === 'tool'
            ? { type: 'response.output_item.added', output_index: 1, item }
            : delta(
                scenario === 'refusal' ? 'refusal' : 'output_text',
                text,
                1,
              );
        events =
          scenario === 'late'
            ? [body, reasoning]
            : [reasoning, ...(output ? [body] : [])];
        if (scenario === 'failure' || scenario === 'closed-failure') {
          events.push({ type: 'error' });
        } else if (scenario !== 'cancelled') {
          events.push(
            done(
              [
                { type: 'reasoning' },
                ...(output
                  ? [
                      scenario === 'tool'
                        ? item
                        : message(text, scenario === 'refusal'),
                    ]
                  : []),
              ],
              scenario === 'truncated' ? 'incomplete' : 'completed',
            ),
          );
        }
      }
      t.mock.method(
        globalThis,
        'fetch',
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(stream) {
                stream.enqueue(
                  new TextEncoder().encode(events.map(frame).join('')),
                );
                if (scenario === 'cancelled') {
                  setImmediate(() => controller.abort());
                } else {
                  stream.close();
                }
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      );
      const options = {
        baseUrl: 'https://unused.invalid/v1',
        apiKey: 'test',
        model: 'test',
        timeoutMs: 1000,
        maxTokens: 100,
        sessionId: 'test',
        onRequest: (r: ModelRequestRecord) => {
          records.push(r);
          throw new Error('observer cannot affect outcome');
        },
      };
      const model =
        transport === 'chat'
          ? new OpenAIModel(options)
          : new ResponsesModel(options);
      const request = model.complete(
        [{ role: 'user', content: 'test' }],
        [],
        controller.signal,
      );
      if (error) {
        await assert.rejects(request);
      } else {
        await request;
      }
      assert.equal(records.length, 1);
      const record = records[0]!;
      const expectedStatus = noReasoning
        ? 'not_observed'
        : error || scenario === 'late'
          ? 'partial'
          : 'complete';
      assert.equal(record.reasoningTimingStatus, expectedStatus);
      assert.equal(
        record.reasoningDurationMs,
        noReasoning ||
          scenario === 'late' ||
          scenario === 'failure' ||
          scenario === 'cancelled'
          ? null
          : 0,
      );
      if (scenario === 'cancelled') {
        assert.equal(record.errorCode, 'cancelled');
      }
    });
  }
  for (const pure of [false, true]) {
    test(`${transport} exact reasoning interval across reads (pure=${pure})`, async (t) => {
      let now = 0;
      const records: ModelRequestRecord[] = [];
      t.mock.method(performance, 'now', () => now);
      const chunks: Array<[number, string]> = [
        [
          100.25,
          frame(
            transport === 'chat'
              ? chat({ reasoning_content: 'think' })
              : delta('reasoning_summary_text', 'think'),
          ),
        ],
        [
          103.5,
          frame(
            transport === 'chat'
              ? chat({ reasoning_content: 'more' })
              : delta('reasoning_summary_text', 'more'),
          ),
        ],
      ];
      if (!pure) {
        chunks.push([
          111.75,
          frame(
            transport === 'chat'
              ? chat({ content: 'answer' })
              : delta('output_text', 'answer', 1),
          ),
        ]);
      }
      chunks.push([
        150.5,
        transport === 'chat'
          ? frame(chat({}, 'stop')) + frame('[DONE]')
          : frame(
              done([
                { type: 'reasoning' },
                ...(pure ? [] : [message('answer')]),
              ]),
            ),
      ]);
      t.mock.method(
        globalThis,
        'fetch',
        async () =>
          new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(stream) {
                  const chunk = chunks.shift();
                  if (!chunk) {
                    stream.close();
                    return;
                  }
                  now = chunk[0];
                  stream.enqueue(new TextEncoder().encode(chunk[1]));
                },
              },
              { highWaterMark: 0 },
            ),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      );
      const options = {
        baseUrl: 'https://unused.invalid/v1',
        apiKey: 'test',
        model: 'test',
        timeoutMs: 1000,
        maxTokens: 100,
        sessionId: 'test',
        onRequest: (r: ModelRequestRecord) => records.push(r),
      };
      const model =
        transport === 'chat'
          ? new OpenAIModel(options)
          : new ResponsesModel(options);
      await model.complete([]);
      assert.equal(records[0]!.reasoningTimingStatus, 'complete');
      assert.equal(records[0]!.reasoningDurationMs, pure ? 50.25 : 11.5);
    });
  }
}
