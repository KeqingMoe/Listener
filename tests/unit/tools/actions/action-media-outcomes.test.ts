import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GroupActionTools,
  GROUP_ACTION_TOOL_NAMES,
} from '../../../../src/tools/actions/tools.ts';
import { GroupMediaTools } from '../../../../src/tools/media/tools.ts';
import { GroupVoiceTools } from '../../../../src/tools/voice/tools.ts';
import { OneBotError } from '../../../../src/onebot/client.ts';
import { DuplicateMessageAckError } from '../../../../src/onebot/operation-result.ts';
import type { Api } from '../../../../src/contracts/onebot.ts';
import type { JsonObject } from '../../../../src/contracts/json.ts';
import type {
  Memory,
  TimelineEntry,
} from '../../../../src/contracts/messages.ts';
import type { TurnContext } from '../../../../src/contracts/tools.ts';
import type { VisibleEffectObserver } from '../../../../src/contracts/visible-effect.ts';

const groupId = '123',
  selfId = '456',
  target = '789';
const ctx: TurnContext = { groupId, selfId, actorId: '234', messageId: '1' };

class Mem implements Memory {
  rows: TimelineEntry[] = [
    {
      messageId: '1',
      userId: target,
      nickname: 'fixture',
      text: 'fixture',
      time: 1,
    },
  ];

  recent() {
    return this.rows;
  }

  find(id: string) {
    return this.rows.find((row) => row.messageId === id);
  }

  append(row: TimelineEntry) {
    this.rows.push(row);
    return true;
  }

  context() {
    return 'fixture';
  }

  async compact() {}
  clear() {
    this.rows = [];
  }

  close() {}
}

function fixture(
  output: () => unknown | Promise<unknown>,
  onSent?: () => void,
  effectObserver?: VisibleEffectObserver,
) {
  const calls: { action: string; params: JsonObject }[] = [],
    writes: string[] = [],
    memory = new Mem();
  const api: Api = {
    async call(action, params = {}) {
      calls.push({ action, params });
      if (action === 'get_login_info') {
        return { user_id: selfId };
      }
      if (action === 'get_group_member_info') {
        return {
          group_id: groupId,
          user_id: params.user_id,
          role: params.user_id === selfId ? 'owner' : 'member',
        };
      }
      if (action === 'get_msg') {
        return {
          message_type: 'group',
          group_id: groupId,
          message_id: params.message_id,
          sender: { user_id: target },
          user_id: target,
          message: [],
        };
      }
      if (action === '_get_group_notice') {
        return [{ notice_id: 'n' }];
      }
      if (action === 'get_ai_characters') {
        return [
          {
            type: 'fixture',
            characters: [
              {
                character_id: 'voice',
                character_name: 'voice',
                preview_url: '',
              },
            ],
          },
        ];
      }
      writes.push(action);
      return await output();
    },
  };
  return {
    calls,
    writes,
    memory,
    api,
    actions: new GroupActionTools(
      api,
      groupId,
      GROUP_ACTION_TOOL_NAMES,
      memory,
      effectObserver,
    ),
    media: new GroupMediaTools(
      api,
      groupId,
      ['forward_message', 'send_group_forward'],
      memory,
      { onSent, effectObserver },
    ),
    voice: new GroupVoiceTools(api, groupId, ['send_group_ai_voice']),
  };
}

test('visible effects require fresh business ACKs and observers cannot affect results', async () => {
  const origin = {
    selfId,
    groupId,
    turnId: 'original-wake',
    receipt: { receivedAt: Date.now(), receivedMonotonic: performance.now() },
  };
  const context = { ...ctx, eventOrigin: origin };
  const kinds: string[] = [];
  const observer: VisibleEffectObserver = {
    confirm(actual, event) {
      assert.equal(actual, origin);
      assert.ok(event.confirmedAt >= origin.receipt.receivedAt);
      assert.ok(event.confirmedMonotonic >= origin.receipt.receivedMonotonic);
      kinds.push(event.kind);
      throw new Error('observer unavailable');
    },
  };
  const f = fixture(() => null, undefined, observer);
  assert.equal(
    (await f.actions.execute('set_group_name', { name: 'new name' }, context))
      .status,
    'executed',
  );
  assert.equal(
    (await f.actions.execute('set_group_name', { name: 'new name' }, context))
      .cached,
    true,
  );
  submitted(
    await f.actions.execute('poke_member', { user_id: target }, context),
  );
  assert.equal(
    (await f.media.execute('forward_message', { message_id: '1' }, context))
      .status,
    'executed',
  );
  assert.deepEqual(kinds, ['group_state_changed', 'message_sent']);
  const unknown = fixture(() => ({ result: 0 }), undefined, observer);
  assert.equal(
    (
      await unknown.media.execute(
        'forward_message',
        { message_id: '1' },
        context,
      )
    ).status,
    'unknown',
  );
  assert.equal(
    (
      await unknown.actions.execute(
        'set_group_name',
        { name: 'unknown' },
        context,
      )
    ).status,
    'unknown',
  );
  assert.deepEqual(kinds, ['group_state_changed', 'message_sent']);
});

function submitted(r: JsonObject) {
  assert.equal(r.status, 'ok');
  assert.equal(r.submitted, true);
  assert.equal(r.effect_confirmed, false);
  assert.equal(r.delivery_confirmed, false);
  assert.equal(r.error, undefined);
  assert.equal(r.retry_allowed, false);
}

const profiles: [string, JsonObject, string][] = [
  ['group_sign', {}, 'set_group_sign'],
  [
    'set_group_title',
    { user_id: target, title: 'title' },
    'set_group_special_title',
  ],
  [
    'kick_member',
    { user_id: target, reject_add_request: false },
    'set_group_kick',
  ],
  ['set_group_admin', { user_id: target, enable: true }, 'set_group_admin'],
  ['set_group_essence', { message_id: '1' }, 'set_essence_msg'],
  ['remove_group_essence', { message_id: '1' }, 'delete_essence_msg'],
  ['delete_group_notice', { notice_id: 'n' }, '_del_group_notice'],
  ['leave_group', {}, 'set_group_leave'],
];

test('all eight native normal profiles submit once without false business acknowledgement or replay', async () => {
  for (const [name, args, native] of profiles) {
    const f = fixture(() => null);
    submitted(await f.actions.execute(name, args, ctx));
    const duplicate = await f.actions.execute(name, args, ctx);
    submitted(duplicate);
    assert.equal(duplicate.cached, true);
    assert.deepEqual(f.writes, [native]);
  }
});

test('different member families remain independent while pending reverse and changed intent are explicit unsent errors', async () => {
  const f = fixture(() => null);
  submitted(
    await f.actions.execute(
      'set_group_title',
      { user_id: target, title: 'old' },
      ctx,
    ),
  );
  const changed = await f.actions.execute(
    'set_group_title',
    { user_id: target, title: 'new' },
    ctx,
  );
  assert.equal(changed.error, 'previous_submission_pending');
  assert.equal(changed.previous_submitted, true);
  assert.equal(changed.dispatched, false);
  assert.equal(changed.submitted, undefined);
  submitted(
    await f.actions.execute(
      'set_group_admin',
      { user_id: target, enable: true },
      ctx,
    ),
  );
  assert.equal(
    (
      await f.actions.execute(
        'set_group_admin',
        { user_id: target, enable: false },
        ctx,
      )
    ).error,
    'previous_submission_pending',
  );
  submitted(await f.actions.execute('group_sign', {}, ctx));
  assert.equal(
    (await f.actions.execute('set_group_name', { name: 'independent' }, ctx))
      .status,
    'executed',
  );
  assert.equal(f.writes.length, 4);
});

test('pending leave protects membership without claiming another operation was dispatched', async () => {
  const f = fixture(() => null);
  submitted(await f.actions.execute('leave_group', {}, ctx));
  const blocked = await f.actions.execute(
    'poke_member',
    { user_id: target },
    ctx,
  );
  assert.equal(blocked.error, 'previous_submission_pending');
  assert.equal(blocked.dispatched, false);
  assert.equal(blocked.previous_submitted, true);
  assert.equal(blocked.submitted, undefined);
  assert.equal(f.writes.length, 1);
});

test('essence Any profiles are normal JSON submissions, not invented result-zero business ACKs', async () => {
  for (const value of [
    null,
    0,
    false,
    'native response',
    [],
    { result: 0 },
    { result: 7, errMsg: 'PRIVATE' },
    { nested: [false, 3, 'x'] },
  ]) {
    const f = fixture(() => value),
      r = await f.actions.execute(
        'set_group_essence',
        { message_id: '1' },
        ctx,
      );
    submitted(r);
    assert.doesNotMatch(JSON.stringify(r), /PRIVATE|native response/);
    assert.equal(
      (
        await f.actions.execute(
          'remove_group_essence',
          { message_id: '1' },
          ctx,
        )
      ).error,
      'previous_submission_pending',
    );
    assert.equal(f.writes.length, 1);
  }
});

test('non-JSON Any results and wrong void results stay unknown without invoking native getters', async () => {
  let touched = 0;
  const getter = Object.defineProperty({}, 'result', {
    enumerable: true,
    get() {
      touched++;
      throw new Error('PRIVATE');
    },
  });
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        touched++;
        throw new Error('PRIVATE');
      },
    },
  );
  const array: unknown[] = [];
  Object.defineProperty(array, '0', {
    enumerable: true,
    get() {
      touched++;
      throw new Error('PRIVATE');
    },
  });
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const value of [
    undefined,
    NaN,
    Infinity,
    () => 0,
    1n,
    getter,
    proxy,
    array,
    cycle,
    new Date(),
  ]) {
    const f = fixture(() => value);
    assert.equal(
      (await f.actions.execute('set_group_essence', { message_id: '1' }, ctx))
        .status,
      'unknown',
    );
    assert.equal(
      (
        await f.actions.execute(
          'remove_group_essence',
          { message_id: '1' },
          ctx,
        )
      ).error,
      'previous_result_unknown',
    );
    assert.equal(f.writes.length, 1);
  }
  assert.equal(touched, 0);
  for (const value of [{ result: 0 }, false, 0, '', []]) {
    const f = fixture(() => value);
    assert.equal(
      (
        await f.actions.execute(
          'set_group_title',
          { user_id: target, title: '' },
          ctx,
        )
      ).status,
      'unknown',
    );
  }
});

const runners = [
  {
    name: 'action',
    run: (f: ReturnType<typeof fixture>) =>
      f.actions.execute(
        'set_group_title',
        { user_id: target, title: 'title' },
        ctx,
      ),
    normal: null,
  },
  {
    name: 'media',
    run: (f: ReturnType<typeof fixture>) =>
      f.media.execute('forward_message', { message_id: '1' }, ctx),
    normal: null,
  },
  {
    name: 'voice',
    run: (f: ReturnType<typeof fixture>) =>
      f.voice.execute(
        'send_group_ai_voice',
        { character_id: 'voice', text: 'hello' },
        ctx,
      ),
    normal: { message_id: 0 },
  },
];
for (const runner of runners) {
  test(`${runner.name}: proven local/prehandler rejection is error and does not create a false uncertainty lock`, async () => {
    for (const err of [
      new OneBotError('unavailable'),
      new OneBotError('busy'),
      new OneBotError('api_failed', 1400),
    ]) {
      let reject = true;
      const f = fixture(() => {
        if (reject) {
          throw err;
        }
        return runner.normal;
      });
      const first = await runner.run(f);
      assert.equal(first.status, 'error');
      assert.equal(first.dispatched, false);
      assert.equal(first.effect_unknown, undefined);
      reject = false;
      const next = await runner.run(f);
      assert.notEqual(next.status, 'unknown');
      assert.equal(f.writes.length, 2);
    }
  });
  test(`${runner.name}: 1200, timeout, send failure and opaque exception remain unknown and cannot replay`, async () => {
    for (const err of [
      new OneBotError('api_failed', 1200),
      new OneBotError('timeout'),
      new OneBotError('send_failed'),
      new Error('PRIVATE'),
    ]) {
      const f = fixture(() => {
        throw err;
      });
      const first = await runner.run(f);
      assert.equal(first.status, 'unknown');
      assert.equal(first.effect_unknown, true);
      assert.equal(first.retry_allowed, false);
      if (err instanceof OneBotError && err.code === 'api_failed') {
        assert.equal(first.provider_reported_failure, true);
        assert.equal(first.provider_code, 1200);
      }
      assert.doesNotMatch(JSON.stringify(first), /PRIVATE/);
      await runner.run(f);
      assert.equal(f.writes.length, 1);
    }
  });
}

test('late strong ACKs and normal voice completion remain facts; projections do not fabricate node completeness', async () => {
  for (const kind of ['single', 'merged', 'voice']) {
    const controller = new AbortController();
    let sent = 0;
    const f = fixture(
      () => {
        controller.abort();
        return kind === 'single'
          ? null
          : { message_id: kind === 'voice' ? 0 : 900 };
      },
      () => {
        sent++;
        throw new Error('PRIVATE projection');
      },
    );
    const result =
      kind === 'voice'
        ? await f.voice.execute(
            'send_group_ai_voice',
            { character_id: 'voice', text: 'hello' },
            ctx,
            controller.signal,
          )
        : await f.media.execute(
            kind === 'single' ? 'forward_message' : 'send_group_forward',
            kind === 'single'
              ? { message_id: '1' }
              : { message_ids: ['1', '1'] },
            ctx,
            controller.signal,
          );
    if (kind === 'voice') {
      submitted(result);
      assert.equal(result.message_id, null);
    } else {
      assert.equal(result.status, 'executed');
    }
    assert.equal(result.cancelled_after_dispatch, true);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
    if (kind === 'merged') {
      assert.equal(result.local_projection_failed, true);
      assert.equal(result.requested_source_count, 2);
      assert.equal(result.source_count, undefined);
      assert.equal(result.source_completeness, 'not_verified');
      assert.equal(sent, 1);
    }
  }
});

test('concurrent explicit interactions stop behind a truly uncertain predecessor', async () => {
  for (const runner of runners) {
    const f = fixture(async () => {
      await Promise.resolve();
      throw new OneBotError('timeout');
    });
    const results = await Promise.all([
      runner.run(f),
      runner.run(f),
      runner.run(f),
    ]);
    assert.equal(f.writes.length, 1);
    assert.equal(results[0]!.status, 'unknown');
    for (const r of results.slice(1)) {
      assert.equal(r.status, 'unknown');
      assert.equal(r.cached, true);
      assert.equal(r.dispatched, false);
    }
  }
});

test('a duplicate message ID acknowledgement is not a new execution and cannot be retried', async () => {
  const f = fixture(
    () => ({ message_id: 900 }),
    () => {
      throw new DuplicateMessageAckError();
    },
  );
  const first = await f.media.execute(
    'send_group_forward',
    { message_ids: ['1'] },
    ctx,
  );
  assert.equal(first.status, 'unknown');
  assert.equal(first.error, 'duplicate_message_ack');
  const second = await f.media.execute(
    'send_group_forward',
    { message_ids: ['1'] },
    ctx,
  );
  assert.equal(second.cached, true);
  assert.equal(second.status, 'unknown');
  assert.equal(f.writes.length, 1);
});
