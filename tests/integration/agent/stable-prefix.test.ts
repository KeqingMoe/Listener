import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Listener } from '../../../src/agent/listener.ts';
import type { ListenerConfig } from '../../../src/config/listener.ts';
import { LISTENER_GROUP } from '../../../src/contracts/identity.ts';
import { type Api } from '../../../src/contracts/onebot.ts';
import {
  type ChatMessage,
  type Completion,
  type Model,
} from '../../../src/contracts/model.ts';
import {
  type Memory,
  type TimelineEntry,
} from '../../../src/contracts/messages.ts';

const self = '900000001';
const config: ListenerConfig = {
  enabled: true,
  baseUrl: 'https://example.invalid',
  apiKey: 'x',
  model: 'x',
  timeoutMs: 3000,
  maxTokens: 64,
  debounceMs: 1,
  delayMaxMs: 1,
  cooldownMs: 0,
  memoryPath: ':memory:',
  maxContextChars: 8000,
  retentionDays: 7,
  randomReplyProbability: 1,
  randomCooldownMs: 0,
  randomMaxPerMinute: 10,
  maxToolCallsPerWake: 4,
  wakeTimeoutMs: 90000,
};

class Mem implements Memory {
  rows: TimelineEntry[] = [];
  append(e: TimelineEntry) {
    this.rows.push(e);
    return true;
  }

  recent() {
    return this.rows;
  }

  find(id: string) {
    return this.rows.find((x) => x.messageId === id);
  }

  context() {
    return JSON.stringify(this.rows);
  }

  async compact() {}
  clear() {
    this.rows = [];
  }

  close() {}
}

const call = (id: string, name: string): Completion => ({
  content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }],
});
const event = {
  post_type: 'message',
  message_type: 'group',
  group_id: LISTENER_GROUP,
  self_id: self,
  user_id: '123',
  message_id: '1',
  time: Math.floor(Date.now() / 1000),
  sender: { nickname: 'x' },
  message: [{ type: 'text', data: { text: 'hello' } }],
};

async function wait(bot: Listener, requests: ChatMessage[][]) {
  for (let i = 0; i < 300; i++) {
    if (requests.length > 1 && !(bot as any).running) {
      return;
    }
    await delay(2);
  }
  assert.fail('timeout');
}

test('system prompt stays byte-stable and budget metadata moves to the initial payload/tool results', async () => {
  const requests: ChatMessage[][] = [];
  let apiCalls = 0;
  const api: Api = {
    async call(action) {
      apiCalls++;
      return action === 'send_group_msg'
        ? { message_id: String(apiCalls) }
        : {};
    },
  };
  const toolSchemas: string[] = [];
  const model: Model = {
    async complete(messages, tools) {
      toolSchemas.push(JSON.stringify(tools));
      requests.push(structuredClone(messages));
      return requests.length === 1
        ? call('a', 'get_group_members')
        : call('b', 'finish');
    },
  };
  const bot = new Listener(api, model, new Mem(), config, () => 0);
  try {
    await bot.receive(event, self);
    await wait(bot, requests);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1]!.slice(0, requests[0]!.length), requests[0]);
    assert.equal(toolSchemas[0], toolSchemas[1]);
    assert.equal(requests[1]!.filter((m) => m.role === 'user').length, 1);
    assert.equal(requests[0]![0]!.content, requests[1]![0]!.content);
    const firstUser = JSON.parse(
      String(requests[0]!.find((m) => m.role === 'user')!.content),
    );
    const tool = JSON.parse(
      String(requests[1]!.find((m) => m.role === 'tool')!.content),
    );
    assert.equal(firstUser.wake_budget.used_tool_calls, 0);
    assert.equal(tool.wake_budget.used_tool_calls, 1);
    assert.equal(tool.wake_budget.remaining_tool_calls, 3);
  } finally {
    await bot.stop();
  }
});
