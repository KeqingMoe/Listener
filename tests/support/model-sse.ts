import type { ServerResponse } from 'node:http';

/** Emit an OpenAI Chat Completions SSE response from an existing fixture completion. */
export function sendChatStream(
  res: ServerResponse,
  completion: any,
  usage: any = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    connection: 'close',
    'cache-control': 'no-cache',
  });
  const choice = completion?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const chunks: any[] = [];
  if (typeof message.content === 'string' && message.content.length) {
    chunks.push({
      choices: [
        { index: 0, delta: { content: message.content }, finish_reason: null },
      ],
    });
  }
  for (const [index, call] of toolCalls.entries()) {
    chunks.push({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: call.id,
                type: call.type,
                function: {
                  name: call.function?.name ?? '',
                  arguments: call.function?.arguments ?? '',
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
  }
  chunks.push({
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason:
          choice.finish_reason ?? (toolCalls.length ? 'tool_calls' : 'stop'),
      },
    ],
    usage,
  });
  for (const chunk of chunks) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}
