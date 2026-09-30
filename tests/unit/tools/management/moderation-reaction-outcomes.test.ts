import test from 'node:test';
import assert from 'node:assert/strict';
import { Moderation } from '../../../../src/tools/management/moderation.ts';
import {
  ReactionTools,
  createReactionTool,
} from '../../../../src/tools/reactions/tools.ts';
import { OneBotError } from '../../../../src/onebot/client.ts';
import {
  submittedResult,
  writeFailure,
} from '../../../../src/onebot/operation-result.ts';
import {
  LISTENER_GROUP,
  OWNER_ID,
} from '../../../../src/contracts/identity.ts';
import { type Api } from '../../../../src/contracts/onebot.ts';
import { type JsonObject } from '../../../../src/contracts/json.ts';
import { type Memory } from '../../../../src/contracts/messages.ts';
import { type TurnContext } from '../../../../src/contracts/tools.ts';

const ctx: TurnContext = {
  groupId: LISTENER_GROUP,
  actorId: '123',
  selfId: '999',
  messageId: '11',
};
const owner = { ...ctx, actorId: OWNER_ID, messageId: '12' };
const actions = [
  { name: 'mute_member', args: { user_id: '456', seconds: 2 } },
  { name: 'unmute_member', args: { user_id: '456' } },
  { name: 'set_member_card', args: { user_id: '456', card: 'literal card' } },
  { name: 'recall_message', args: { message_id: '7' } },
] as const;

function moderationFixture(
  mode: 'direct' | 'confirm',
  write: () => unknown | Promise<unknown>,
) {
  let writes = 0;
  const api: Api = {
    async call(action, params = {}) {
      if (action === 'get_login_info') {
        return { user_id: ctx.selfId };
      }
      if (action === 'get_group_member_info') {
        return {
          group_id: ctx.groupId,
          user_id: params.user_id,
          role: params.user_id === ctx.selfId ? 'admin' : 'member',
        };
      }
      if (action === 'get_msg') {
        return {
          message_id: '7',
          message_type: 'group',
          group_id: ctx.groupId,
          sender: { user_id: '456' },
        };
      }
      assert.ok(
        ['set_group_ban', 'set_group_card', 'delete_msg'].includes(action),
      );
      writes++;
      return await write();
    },
  };
  const moderation = new Moderation(api, Date.now, {
    mute: mode,
    unmute: mode,
    recall: mode,
    memberCard: mode,
  });
  return {
    moderation,
    writes: () => writes,
    async run(action: (typeof actions)[number], signal?: AbortSignal) {
      const result = await moderation.request(
        action.name,
        action.args,
        ctx,
        signal,
      );
      return mode === 'confirm'
        ? moderation.confirm(String(result.code), owner, signal)
        : result;
    },
  };
}

const reactions = { message_id: '7', emoji_id: '76', action: 'add' };

function reactionFixture(write: () => unknown | Promise<unknown>) {
  let writes = 0;
  const row = {
    messageId: '7',
    userId: '456',
    nickname: 'fixture',
    text: 'private message',
    time: 1,
  };
  const memory: Memory = {
    find: (id) => (id === '7' ? { ...row } : undefined),
    recent: () => [{ ...row }],
    append: () => {
      throw Error('must not project unobserved effects');
    },
    context: () => '',
    async compact() {},
    clear() {},
    close() {},
  };
  const api: Api = {
    async call(action) {
      if (action === 'get_msg') {
        return {
          message_id: '7',
          message_type: 'group',
          group_id: ctx.groupId,
          sender: { user_id: '456' },
        };
      }
      assert.equal(action, 'set_msg_emoji_like');
      writes++;
      return await write();
    },
  };
  const tools = new ReactionTools(api, memory),
    turn = tools.createTurn();
  return { tools, turn, writes: () => writes };
}

const failures = [
  { error: new OneBotError('unavailable'), status: 'error', dispatched: false },
  { error: new OneBotError('busy'), status: 'error', dispatched: false },
  {
    error: new OneBotError('api_failed', 1400),
    status: 'error',
    dispatched: false,
  },
  { error: new OneBotError('api_failed', 1200), status: 'unknown' },
  { error: new OneBotError('api_failed', 0), status: 'unknown' },
  { error: new OneBotError('timeout'), status: 'unknown' },
  { error: new OneBotError('disconnected'), status: 'unknown' },
  { error: new OneBotError('send_failed'), status: 'unknown' },
  { error: new OneBotError('stopped'), status: 'unknown' },
  { error: new Error('SECRET native response'), status: 'unknown' },
] as const;

test('legacy management uses the same phase-aware failure classifier in both authorization modes', async () => {
  for (const mode of ['direct', 'confirm'] as const) {
    for (const action of actions) {
      for (const item of failures) {
        const f = moderationFixture(mode, () => {
          throw item.error;
        });
        const result = await f.run(action);
        assert.deepEqual(result, writeFailure(item.error, 'delivery_unknown'));
        assert.equal(result.status, item.status);
        assert.equal(f.writes(), 1);
        if (item.status === 'unknown') {
          assert.equal(result.effect_unknown, true);
          assert.equal(result.retry_allowed, false);
          assert.notEqual(result.dispatched, false);
        } else {
          assert.equal(result.dispatched, false);
        }
        if (
          item.error instanceof OneBotError &&
          item.error.code === 'api_failed' &&
          item.error.retcode === 1200
        ) {
          assert.equal(result.provider_reported_failure, true);
        }
        assert.doesNotMatch(JSON.stringify(result), /SECRET/);
      }
    }
  }
});

test('all three native legacy mutation contracts acknowledge only null, even after cancellation', async () => {
  for (const mode of ['direct', 'confirm'] as const) {
    for (const action of actions) {
      const controller = new AbortController();
      const f = moderationFixture(mode, () => {
        controller.abort();
        return null;
      });
      assert.equal((await f.run(action, controller.signal)).status, 'executed');
      assert.equal(f.writes(), 1);
      for (const shape of [
        undefined,
        true,
        0,
        false,
        1,
        {},
        [],
        { result: 0 },
        { result: true },
        { result: false },
        { result: 0, retCode: 1 },
      ]) {
        const malformed = moderationFixture(mode, () => shape),
          result = await malformed.run(action);
        assert.equal(result.status, 'unknown');
        assert.equal(result.effect_unknown, true);
        assert.equal(malformed.writes(), 1);
      }
    }
  }
});

test('reaction Any normal JSON is provider submission, never a fabricated observed effect', async () => {
  for (const value of [
    null,
    true,
    false,
    0,
    1,
    'native opaque string',
    {},
    [],
    { result: 0 },
    { result: true },
    { result: '0' },
    { result: null },
    { opaque: { body: 'SECRET', items: [null, true, 3] } },
  ]) {
    const f = reactionFixture(() => value),
      result = await f.tools.react(reactions, ctx, f.turn);
    assert.deepEqual(result, submittedResult(reactions));
    assert.equal(result.effect_confirmed, false);
    assert.equal(result.delivery_confirmed, false);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|opaque|native opaque/);
    assert.equal(f.writes(), 1);
    const repeat = await f.tools.react(reactions, ctx, f.turn);
    assert.equal(repeat.duplicate, true);
    assert.equal(repeat.submitted, true);
    assert.equal(f.writes(), 1);
    const reverse = await f.tools.react(
      { ...reactions, action: 'remove' },
      ctx,
      f.turn,
    );
    assert.equal(reverse.error, undefined);
    assert.equal(reverse.action, 'remove');
    assert.equal(reverse.submitted, true);
    assert.equal(reverse.effect_confirmed, false);
    assert.equal(f.writes(), 2);
    assert.equal((await f.tools.react(reactions, ctx, f.turn)).submitted, true);
    assert.equal(f.writes(), 3);
  }
  assert.match(
    createReactionTool().function.description,
    /submitted=true.*不代表已观察/,
  );
});

test('reaction failures use shared phase evidence and never retry uncertain writes or leak provider bodies', async () => {
  for (const item of failures) {
    const f = reactionFixture(() => {
        throw item.error;
      }),
      result = await f.tools.react(reactions, ctx, f.turn);
    assert.deepEqual(result, {
      ...writeFailure(item.error, 'reaction_result_unknown'),
      ...reactions,
    });
    assert.equal(f.writes(), 1);
    const repeat = await f.tools.react(reactions, ctx, f.turn);
    assert.equal(repeat.duplicate, true);
    assert.equal(repeat.status, item.status);
    assert.equal(f.writes(), 1);
    if (item.status === 'unknown') {
      const reverse = await f.tools.react(
        { ...reactions, action: 'remove' },
        ctx,
        f.turn,
      );
      assert.equal(reverse.status, 'unknown');
      assert.equal(reverse.action, 'add');
      assert.equal(reverse.requested_action, 'remove');
      assert.equal(f.writes(), 1);
    }
    assert.doesNotMatch(JSON.stringify(result), /SECRET/);
  }
});

test('reaction non-JSON results remain genuinely unknown without evaluating getters', async () => {
  let reads = 0;
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const accessor = {
    get result() {
      reads++;
      return true;
    },
  };
  const values = [
    undefined,
    NaN,
    Infinity,
    cyclic,
    accessor,
    new Date(),
    () => true,
    [undefined],
  ];
  for (const value of values) {
    const f = reactionFixture(() => value),
      result = await f.tools.react(reactions, ctx, f.turn);
    assert.equal(result.status, 'unknown');
    assert.equal(result.effect_unknown, true);
    assert.equal(f.writes(), 1);
  }
  assert.equal(reads, 0);
});

test('late reaction normal null retains submission and does not project a made-up QQ state', async () => {
  const controller = new AbortController(),
    f = reactionFixture(() => {
      controller.abort();
      return null;
    });
  const result = await f.tools.react(reactions, ctx, f.turn, controller.signal);
  assert.equal(result.status, 'ok');
  assert.equal(result.submitted, true);
  assert.equal(result.effect_confirmed, false);
  assert.equal(result.cancelled_after_dispatch, true);
  assert.equal(f.writes(), 1);
});
