import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Moderation,
  buildModerationTools,
  MODERATION_TOOLS,
} from '../../../../src/tools/management/moderation.ts';
import { MAX_MUTE_SECONDS } from '../../../../src/contracts/tool-limits.ts';
import type {
  ModerationPolicy,
  ModerationMode,
} from '../../../../src/config/listener.ts';
import {
  LISTENER_GROUP,
  OWNER_ID,
} from '../../../../src/contracts/identity.ts';
import { type Api } from '../../../../src/contracts/onebot.ts';
import { type JsonObject } from '../../../../src/contracts/json.ts';
import { type TurnContext } from '../../../../src/contracts/tools.ts';

const self = '303',
  target = '202';
const ctx: TurnContext = {
  groupId: LISTENER_GROUP,
  selfId: self,
  actorId: '101',
  messageId: '5',
};
const owner = { ...ctx, actorId: OWNER_ID, messageId: '6' };
const all = (mode: ModerationMode): Partial<ModerationPolicy> => ({
  mute: mode,
  unmute: mode,
  recall: mode,
  memberCard: mode,
});
const cases = [
  {
    key: 'mute',
    name: 'mute_member',
    args: { user_id: target, seconds: 2 },
    native: 'set_group_ban',
    params: { group_id: LISTENER_GROUP, user_id: target, duration: 2 },
  },
  {
    key: 'unmute',
    name: 'unmute_member',
    args: { user_id: target },
    native: 'set_group_ban',
    params: { group_id: LISTENER_GROUP, user_id: target, duration: 0 },
  },
  {
    key: 'recall',
    name: 'recall_message',
    args: { message_id: '-9' },
    native: 'delete_msg',
    params: { message_id: '-9' },
  },
  {
    key: 'memberCard',
    name: 'set_member_card',
    args: { user_id: target, card: 'card' },
    native: 'set_group_card',
    params: { group_id: LISTENER_GROUP, user_id: target, card: 'card' },
  },
] as const;
const writes = new Set(['set_group_ban', 'delete_msg', 'set_group_card']);

class ApiMock implements Api {
  calls: { name: string; params: JsonObject }[] = [];
  botRole = 'admin';
  targetRole = 'member';
  sender = target;
  result: unknown = null;
  message?: JsonObject;
  hook?: (name: string, params: JsonObject) => void | Promise<void>;
  async call(name: string, params: JsonObject = {}) {
    this.calls.push({ name, params });
    await this.hook?.(name, params);
    if (name === 'get_login_info') {
      return { user_id: self };
    }
    if (name === 'get_group_member_info') {
      return {
        group_id: LISTENER_GROUP,
        user_id: params.user_id,
        role: params.user_id === self ? this.botRole : this.targetRole,
      };
    }
    if (name === 'get_msg') {
      return (
        this.message ?? {
          group_id: LISTENER_GROUP,
          message_type: 'group',
          message_id: '-9',
          user_id: this.sender,
          sender: { user_id: this.sender, nickname: 'claimed owner' },
        }
      );
    }
    assert.ok(writes.has(name));
    return this.result;
  }

  mutations() {
    return this.calls.filter((row) => writes.has(row.name));
  }
}

test('all four capabilities default off in executor and model schema', async () => {
  const api = new ApiMock(),
    m = new Moderation(api);
  assert.deepEqual(buildModerationTools(), []);
  for (const item of cases) {
    assert.equal(
      (await m.request(item.name, item.args, ctx)).error,
      'tool_disabled',
    );
  }
  assert.equal(api.calls.length, 0);
});

for (const item of cases) {
  for (const mode of ['off', 'confirm', 'direct'] as const) {
    test(`${item.name}: ${mode} is independent and supports nonowner autonomous decisions`, async () => {
      const api = new ApiMock(),
        m = new Moderation(api, Date.now, { [item.key]: mode });
      for (const other of cases.filter((c) => c.key !== item.key)) {
        assert.equal(
          (await m.request(other.name, other.args, ctx)).error,
          'tool_disabled',
        );
      }
      assert.equal(api.calls.length, 0);
      const result = await m.request(item.name, item.args, ctx);
      if (mode === 'off') {
        assert.equal(result.error, 'tool_disabled');
        assert.equal(api.calls.length, 0);
      } else if (mode === 'confirm') {
        assert.equal(result.status, 'confirmation_required');
        assert.equal(api.mutations().length, 0);
        assert.ok(
          String(result.description).includes(
            item.key === 'recall' ? '-9' : target,
          ),
        );
        assert.deepEqual(result.action, { name: item.name, ...item.args });
        assert.equal(
          (await m.confirm(String(result.code), ctx)).error,
          'confirmation_denied',
        );
        assert.equal(
          (await m.confirm(String(result.code), owner)).status,
          'executed',
        );
        assert.deepEqual(api.mutations(), [
          { name: item.native, params: item.params },
        ]);
      } else {
        assert.equal(result.code, undefined);
        assert.equal(result.description, undefined);
        assert.deepEqual(result, { status: 'executed' });
        assert.equal((m as any).pending.size, 0);
        assert.deepEqual(api.mutations(), [
          { name: item.native, params: item.params },
        ]);
      }
    });
  }
}

test('schema filters off capabilities, reflects modes and reduced bounds, and cannot mutate templates', () => {
  const settings: Partial<ModerationPolicy> = {
    mute: 'confirm',
    unmute: 'direct',
    recall: 'off',
    memberCard: 'direct',
    maxMuteSeconds: 12,
    confirmationTtlSeconds: 3,
  };
  const tools = buildModerationTools(settings);
  assert.deepEqual(
    tools.map((tool) => tool.function.name),
    ['mute_member', 'unmute_member', 'set_member_card'],
  );
  assert.match(
    tools[0]!.function.description,
    /autonomously.*owner.*3 seconds/,
  );
  assert.match(
    tools[1]!.function.description,
    /autonomously.*immediately without approval/,
  );
  const seconds = (tools[0]!.function.parameters.properties as JsonObject)
    .seconds as JsonObject;
  assert.equal(seconds.minimum, 1);
  assert.equal(seconds.maximum, 12);
  seconds.maximum = 10000;
  tools[1]!.function.description = 'unsafe overwrite';
  settings.unmute = 'off';
  assert.equal(
    (
      (MODERATION_TOOLS[0]!.function.parameters.properties as JsonObject)
        .seconds as JsonObject
    ).maximum,
    MAX_MUTE_SECONDS,
  );
  assert.equal(
    (
      (
        buildModerationTools({ mute: 'direct' })[0]!.function.parameters
          .properties as JsonObject
      ).seconds as JsonObject
    ).maximum,
    MAX_MUTE_SECONDS,
  );
  assert.ok(
    buildModerationTools({
      unmute: 'confirm',
    })[0]!.function.description.includes('owner /confirm'),
  );
});

test('direct capability policy is not a global deduplication lock across future decisions', async () => {
  const api = new ApiMock(),
    m = new Moderation(api, Date.now, { mute: 'direct', unmute: 'direct' });
  for (const name of ['mute_member', 'unmute_member', 'mute_member']) {
    assert.equal(
      (
        await m.request(
          name,
          name === 'mute_member'
            ? { user_id: target, seconds: 4 }
            : { user_id: target },
          ctx,
        )
      ).status,
      'executed',
    );
  }
  assert.deepEqual(
    api.mutations().map((row) => row.params.duration),
    [4, 0, 4],
  );
});

test('real bot role is mandatory and target roles are checked for every capability', async () => {
  for (const item of cases) {
    for (const role of ['member', 'unknown', '', undefined]) {
      const api = new ApiMock();
      api.botRole = role as any;
      const result = await new Moderation(api, Date.now, all('direct')).request(
        item.name,
        item.args,
        ctx,
      );
      assert.equal(result.status, 'error');
      assert.equal(api.mutations().length, 0);
      assert.deepEqual(
        api.calls.map((row) => row.name),
        [
          'get_login_info',
          'get_group_member_info',
          ...(item.name === 'recall_message' && role === 'member'
            ? ['get_msg']
            : []),
        ],
      );
    }
  }
  for (const item of cases) {
    for (const botRole of ['admin', 'owner']) {
      for (const targetRole of ['member', 'admin', 'owner', 'unknown']) {
        const api = new ApiMock();
        api.botRole = botRole;
        api.targetRole = targetRole;
        const allowed =
          targetRole === 'member' ||
          (targetRole === 'admin' && botRole === 'owner');
        const result = await new Moderation(
          api,
          Date.now,
          all('direct'),
        ).request(item.name, item.args, ctx);
        assert.equal(
          result.status,
          allowed ? 'executed' : 'error',
          `${item.name}/${botRole}/${targetRole}`,
        );
        assert.equal(api.mutations().length, allowed ? 1 : 0);
      }
    }
  }
});

test('group-owner bot can request mute and unmute for administrator targets in each configured mode', async () => {
  for (const item of cases.slice(0, 2)) {
    for (const mode of ['off', 'confirm', 'direct'] as const) {
      for (const user_id of [target, OWNER_ID]) {
        const api = new ApiMock();
        api.botRole = 'owner';
        api.targetRole = 'admin';
        const m = new Moderation(api, Date.now, all(mode));
        let result = await m.request(item.name, { ...item.args, user_id }, ctx);
        if (mode === 'off') {
          assert.equal(result.error, 'tool_disabled');
          assert.equal(api.calls.length, 0);
          continue;
        }
        if (mode === 'confirm') {
          assert.equal(result.status, 'confirmation_required');
          assert.equal(api.mutations().length, 0);
          result = await m.confirm(String(result.code), owner);
        }
        assert.equal(result.status, 'executed');
        assert.deepEqual(
          api.mutations().map((c) => c.params),
          [{ ...item.params, user_id }],
        );
      }
    }
  }
});

test('administrator target permission is rechecked if the bot loses group ownership before confirmation', async () => {
  for (const item of cases.slice(0, 2)) {
    const api = new ApiMock();
    api.botRole = 'owner';
    api.targetRole = 'admin';
    const m = new Moderation(api, Date.now, all('confirm'));
    const proposed = await m.request(item.name, item.args, ctx);
    assert.equal(proposed.status, 'confirmation_required');
    api.botRole = 'admin';
    assert.equal(
      (await m.confirm(String(proposed.code), owner)).error,
      'permission_denied',
    );
    assert.equal(api.mutations().length, 0);
  }
});

test('non-contract result field of an administrator mute is never mistaken for a business ACK', async () => {
  const api = new ApiMock();
  api.botRole = 'owner';
  api.targetRole = 'admin';
  api.result = { result: 1 };
  const r = await new Moderation(api, Date.now, all('direct')).request(
    'mute_member',
    { user_id: target, seconds: 2 },
    ctx,
  );
  assert.equal(api.mutations().length, 1);
  assert.equal(r.status, 'unknown');
});

test('bot group/id metadata cannot be replaced with claimed administrator names', async () => {
  for (const patch of [
    { group_id: '77' },
    { user_id: target },
    { role: undefined, nickname: '群主' },
  ]) {
    const api = new ApiMock(),
      original = api.call.bind(api);
    api.call = async (name, params = {}) => {
      const result = await original(name, params);
      return name === 'get_group_member_info' && params.user_id === self
        ? { ...(result as JsonObject), ...patch }
        : result;
    };
    assert.equal(
      (
        await new Moderation(api, Date.now, all('direct')).request(
          'unmute_member',
          { user_id: target },
          ctx,
        )
      ).status,
      'error',
    );
    assert.equal(api.mutations().length, 0);
  }
});

test('already cancelled requests do no reads or writes in either mode', async () => {
  for (const mode of ['confirm', 'direct'] as const) {
    const controller = new AbortController();
    controller.abort();
    const api = new ApiMock();
    assert.equal(
      (
        await new Moderation(api, Date.now, all(mode)).request(
          'recall_message',
          { message_id: '-9' },
          ctx,
          controller.signal,
        )
      ).error,
      'cancelled',
    );
    assert.equal(api.calls.length, 0);
  }
});

test('cancellation and disposal after every verification await stop further reads, pending insertion and mutation', async () => {
  for (const mode of ['confirm', 'direct'] as const) {
    for (const stop of ['abort', 'dispose']) {
      for (const step of [1, 2, 3, 4]) {
        const api = new ApiMock(),
          controller = new AbortController(),
          m = new Moderation(api, Date.now, all(mode));
        api.hook = () => {
          if (api.calls.length === step) {
            if (stop === 'abort') {
              controller.abort();
            } else {
              m.dispose();
            }
          }
        };
        assert.equal(
          (
            await m.request(
              'recall_message',
              { message_id: '-9' },
              ctx,
              controller.signal,
            )
          ).error,
          'cancelled',
          `${mode}/${stop}/${step}`,
        );
        assert.equal(api.calls.length, step);
        assert.equal(api.mutations().length, 0);
        assert.equal((m as any).pending.size, 0);
      }
    }
  }
});

test('owner confirmation rechecks cancellation and expiry after every verification await without restoring consumed codes', async () => {
  for (const stop of ['abort', 'dispose', 'expire']) {
    for (const step of [1, 2, 3, 4]) {
      let now = 0;
      const api = new ApiMock(),
        controller = new AbortController(),
        m = new Moderation(api, () => now, all('confirm'));
      const result = await m.request(
          'recall_message',
          { message_id: '-9' },
          ctx,
        ),
        code = String(result.code),
        before = api.calls.length;
      assert.equal(result.status, 'confirmation_required');
      api.hook = () => {
        if (api.calls.length === before + step) {
          if (stop === 'abort') {
            controller.abort();
          } else if (stop === 'dispose') {
            m.dispose();
          } else {
            now = 60_000;
          }
        }
      };
      assert.equal(
        (await m.confirm(code, owner, controller.signal)).error,
        stop === 'expire' ? 'confirmation_expired' : 'cancelled',
      );
      assert.equal(api.calls.length, before + step);
      assert.equal(api.mutations().length, 0);
      assert.equal((m as any).pending.size, 0);
      api.hook = undefined;
      assert.equal((await m.confirm(code, owner)).status, 'error');
      assert.equal(api.mutations().length, 0);
    }
  }
});

test('pending capacity is enforced after concurrent verification returns', async () => {
  const api = new ApiMock(),
    m = new Moderation(api, Date.now, all('confirm'));
  const results = await Promise.all(
    Array.from({ length: 25 }, () =>
      m.request('unmute_member', { user_id: target }, ctx),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === 'confirmation_required')
      .length,
    10,
  );
  assert.equal(
    results.filter((result) => result.error === 'confirmation_limit').length,
    15,
  );
  assert.equal((m as any).pending.size, 10);
  assert.equal(api.mutations().length, 0);
});

test('successful dispatch acknowledgement stays executed after abort/dispose instead of pretending rollback', async () => {
  for (const mode of ['direct', 'confirm'] as const) {
    for (const stop of ['abort', 'dispose']) {
      const api = new ApiMock(),
        controller = new AbortController(),
        m = new Moderation(api, Date.now, all(mode));
      api.hook = (name) => {
        if (writes.has(name)) {
          if (stop === 'abort') {
            controller.abort();
          } else {
            m.dispose();
          }
        }
      };
      const result = await m.request(
        'unmute_member',
        { user_id: target },
        ctx,
        controller.signal,
      );
      const final =
        mode === 'confirm'
          ? await m.confirm(String(result.code), owner, controller.signal)
          : result;
      assert.deepEqual(final, { status: 'executed' });
      assert.equal(api.mutations().length, 1);
      assert.equal((m as any).pending.size, 0);
    }
  }
});

test('only the contracted null acknowledgement executes; arbitrary shapes remain uncertain', async () => {
  const responses: [unknown, string][] = [
    [null, 'executed'],
    [undefined, 'unknown'],
    [{}, 'unknown'],
    [Object.create(null), 'unknown'],
    [true, 'unknown'],
    [0, 'unknown'],
    [{ result: 0 }, 'unknown'],
    [{ result: true }, 'unknown'],
    [false, 'unknown'],
    [-1, 'unknown'],
    [{ result: 1, errMsg: 'SECRET BUSINESS ERROR' }, 'unknown'],
    [{ result: false }, 'unknown'],
    [{ result: 0, success: false }, 'unknown'],
    [{ retcode: 1 }, 'unknown'],
    [{ code: -1 }, 'unknown'],
    [{ status: 'failed' }, 'unknown'],
    ['success?', 'unknown'],
    [[], 'unknown'],
    [{ info: 'SECRET UNKNOWN DETAIL' }, 'unknown'],
    [{ result: '0' }, 'unknown'],
    [NaN, 'unknown'],
    [{ result: Infinity }, 'unknown'],
    [{ result: 0, retcode: '1' }, 'unknown'],
    [{ result: true, success: undefined }, 'unknown'],
    [{ result: 0, status: 'unknown' }, 'unknown'],
    [{ result: 0, code: NaN }, 'unknown'],
  ];
  for (const [response, status] of responses) {
    const api = new ApiMock();
    api.result = response;
    const result = await new Moderation(api, Date.now, {
      unmute: 'direct',
    }).request('unmute_member', { user_id: target }, ctx);
    assert.equal(result.status, status);
    assert.ok(!JSON.stringify(result).includes('SECRET'));
    assert.equal(api.mutations().length, 1);
    if (status === 'unknown') {
      assert.equal(result.error, 'delivery_unknown');
    }
    if (status === 'unknown') {
      assert.equal(result.effect_unknown, true);
      assert.equal(result.retry_allowed, false);
    }
  }
});

test('transport failure after dispatch is unknown in direct and confirm modes and never auto-retried', async () => {
  for (const mode of ['direct', 'confirm'] as const) {
    const api = new ApiMock(),
      m = new Moderation(api, Date.now, all(mode));
    api.hook = (name) => {
      if (writes.has(name)) {
        throw new Error('SECRET TRANSPORT BODY');
      }
    };
    const result = await m.request('unmute_member', { user_id: target }, ctx);
    const final =
      mode === 'confirm' ? await m.confirm(String(result.code), owner) : result;
    assert.deepEqual(final, {
      status: 'unknown',
      error: 'delivery_unknown',
      effect_unknown: true,
      retry_allowed: false,
    });
    assert.equal(api.mutations().length, 1);
    if (mode === 'confirm') {
      assert.equal(
        (await m.confirm(String(result.code), owner)).status,
        'error',
      );
      assert.equal(api.mutations().length, 1);
    }
  }
});

test('recall binds fresh sender to optional frozen sender proof before proposing or executing', async () => {
  for (const mode of ['direct', 'confirm'] as const) {
    const wrongApi = new ApiMock(),
      wrong = new Moderation(wrongApi, Date.now, { recall: mode });
    assert.deepEqual(
      await wrong.request(
        'recall_message',
        { message_id: '-9' },
        ctx,
        undefined,
        '999',
      ),
      { status: 'error', error: 'verification_failed' },
    );
    assert.equal(wrongApi.mutations().length, 0);
    assert.equal((wrong as any).pending.size, 0);
    assert.deepEqual(
      wrongApi.calls.map((row) => row.name),
      ['get_login_info', 'get_group_member_info', 'get_msg'],
    );
    for (const expected of [target, undefined]) {
      const api = new ApiMock(),
        m = new Moderation(api, Date.now, { recall: mode });
      const result = await m.request(
        'recall_message',
        { message_id: '-9' },
        ctx,
        undefined,
        expected,
      );
      assert.equal(
        result.status,
        mode === 'direct' ? 'executed' : 'confirmation_required',
      );
      if (mode === 'confirm') {
        assert.equal(
          (await m.confirm(String(result.code), owner)).status,
          'executed',
        );
      }
      assert.equal(api.mutations().length, 1);
    }
  }
});

test('known owner or bot sender still requires a matching fresh sender, and malformed proofs remain rejected', async () => {
  for (const mode of ['direct', 'confirm'] as const) {
    for (const expected of [
      OWNER_ID,
      self,
      '',
      '0202',
      '202\n',
      '0',
      '1'.repeat(33),
      202,
      null,
    ]) {
      const api = new ApiMock(),
        m = new Moderation(api, Date.now, { recall: mode });
      const result = await m.request(
        'recall_message',
        { message_id: '-9' },
        ctx,
        undefined,
        expected as any,
      );
      assert.equal(result.error, 'verification_failed');
      if (expected === OWNER_ID || expected === self) {
        assert.deepEqual(
          api.calls.map((row) => row.name),
          ['get_login_info', 'get_group_member_info', 'get_msg'],
        );
      } else {
        assert.equal(api.calls.length, 0);
      }
      assert.equal(api.mutations().length, 0);
      assert.equal((m as any).pending.size, 0);
    }
  }
  const api = new ApiMock(),
    m = new Moderation(api, Date.now, { recall: 'direct' });
  assert.equal(
    (
      await m.request(
        'recall_message',
        { message_id: '-9', expectedSender: target },
        ctx,
      )
    ).error,
    'invalid_arguments',
  );
  assert.equal(api.calls.length, 0);
});

test('configured owner is an ordinary target when QQ membership permits, across all capabilities and modes', async () => {
  for (const item of cases) {
    for (const mode of ['off', 'confirm', 'direct'] as const) {
      const api = new ApiMock();
      api.sender = OWNER_ID;
      const m = new Moderation(api, Date.now, { [item.key]: mode });
      const args: JsonObject =
        item.key === 'recall'
          ? { ...item.args }
          : { ...item.args, user_id: OWNER_ID };
      const r = await m.request(
        item.name,
        args,
        ctx,
        undefined,
        item.key === 'recall' ? OWNER_ID : undefined,
      );
      if (mode === 'off') {
        assert.equal(r.error, 'tool_disabled');
        assert.equal(api.calls.length, 0);
        continue;
      }
      assert.equal(
        r.status,
        mode === 'direct' ? 'executed' : 'confirmation_required',
      );
      if (mode === 'confirm') {
        assert.equal(api.mutations().length, 0);
        assert.ok(
          String(r.description).includes(
            item.key === 'recall' ? '-9' : OWNER_ID,
          ),
        );
        assert.equal(
          (await m.confirm(String(r.code), ctx)).error,
          'confirmation_denied',
        );
        assert.equal(
          (await m.confirm(String(r.code), owner)).status,
          'executed',
        );
      }
      assert.equal(api.mutations().length, 1);
      assert.equal(api.mutations()[0]!.name, item.native);
      assert.deepEqual(
        api.mutations()[0]!.params,
        item.key === 'recall'
          ? item.params
          : { ...item.params, user_id: OWNER_ID },
      );
    }
  }
});

test('bot recalls its own verified messages as member, admin or owner under each capability mode', async () => {
  for (const botRole of ['member', 'admin', 'owner']) {
    for (const mode of ['off', 'confirm', 'direct'] as const) {
      const api = new ApiMock();
      api.botRole = botRole;
      api.sender = self;
      const m = new Moderation(api, Date.now, { recall: mode });
      const r = await m.request(
        'recall_message',
        { message_id: '-9' },
        ctx,
        undefined,
        self,
      );
      if (mode === 'off') {
        assert.equal(r.error, 'tool_disabled');
        assert.equal(api.calls.length, 0);
        continue;
      }
      assert.equal(
        r.status,
        mode === 'direct' ? 'executed' : 'confirmation_required',
      );
      assert.ok(api.calls.some((call) => call.name === 'get_msg'));
      if (mode === 'confirm') {
        assert.equal(api.mutations().length, 0);
        assert.equal(
          (await m.confirm(String(r.code), owner)).status,
          'executed',
        );
        assert.equal(
          api.calls.filter((call) => call.name === 'get_msg').length,
          2,
        );
      }
      assert.deepEqual(
        api
          .mutations()
          .map((call) => ({ name: call.name, params: call.params })),
        [{ name: 'delete_msg', params: { message_id: '-9' } }],
      );
    }
  }
});

test('bot may edit its own card as a regular member while mode and approval still apply', async () => {
  for (const botRole of ['member', 'admin', 'owner']) {
    for (const mode of ['off', 'confirm', 'direct'] as const) {
      const api = new ApiMock();
      api.botRole = botRole;
      const m = new Moderation(api, Date.now, { memberCard: mode });
      const r = await m.request(
        'set_member_card',
        { user_id: self, card: 'new self card' },
        ctx,
      );
      if (mode === 'off') {
        assert.equal(r.error, 'tool_disabled');
        assert.equal(api.calls.length, 0);
        continue;
      }
      assert.equal(
        r.status,
        mode === 'direct' ? 'executed' : 'confirmation_required',
      );
      if (mode === 'confirm') {
        assert.equal(api.mutations().length, 0);
        assert.equal(
          (await m.confirm(String(r.code), owner)).status,
          'executed',
        );
      }
      assert.deepEqual(
        api
          .mutations()
          .map((call) => ({ name: call.name, params: call.params })),
        [
          {
            name: 'set_group_card',
            params: {
              group_id: LISTENER_GROUP,
              user_id: self,
              card: 'new self card',
            },
          },
        ],
      );
    }
  }
});

test('a frozen self-sender hint never bypasses fresh group, message or sender proof', async () => {
  const good: JsonObject = {
    group_id: LISTENER_GROUP,
    message_type: 'group',
    message_id: '-9',
    user_id: self,
    sender: { user_id: self },
  };
  for (const change of [
    { group_id: '999' },
    { message_type: 'private' },
    { message_id: '-8' },
    { user_id: target, sender: { user_id: target } },
    { user_id: target },
    { sender: { user_id: OWNER_ID } },
  ]) {
    for (const mode of ['direct', 'confirm'] as const) {
      const api = new ApiMock();
      api.botRole = 'member';
      api.sender = self;
      api.message = { ...good, ...change };
      const m = new Moderation(api, Date.now, { recall: mode });
      const r = await m.request(
        'recall_message',
        { message_id: '-9' },
        ctx,
        undefined,
        self,
      );
      assert.equal(r.status, 'error');
      assert.notEqual(r.error, 'protected_target');
      assert.equal(api.mutations().length, 0);
      assert.equal((m as any).pending.size, 0);
      assert.deepEqual(
        api.calls.map((row) => row.name),
        ['get_login_info', 'get_group_member_info', 'get_msg'],
      );
    }
  }
});

test('removing target immunity does not let an ordinary bot manage other people or self-mute privileged roles', async () => {
  for (const item of cases) {
    const api = new ApiMock();
    api.botRole = 'member';
    const m = new Moderation(api, Date.now, all('direct'));
    const r = await m.request(item.name, item.args, ctx);
    assert.equal(r.error, 'permission_denied');
    assert.equal(api.mutations().length, 0);
  }
  for (const botRole of ['member', 'admin', 'owner']) {
    for (const name of ['mute_member', 'unmute_member']) {
      const api = new ApiMock();
      api.botRole = botRole;
      const m = new Moderation(api, Date.now, all('direct'));
      const r = await m.request(
        name,
        name === 'mute_member'
          ? { user_id: self, seconds: 2 }
          : { user_id: self },
        ctx,
      );
      assert.equal(r.error, 'permission_denied');
      assert.equal(api.mutations().length, 0);
    }
  }
});

test('verification read failure cannot be reported as an uncertain mutation', async () => {
  for (const step of [1, 2, 3, 4]) {
    const api = new ApiMock();
    api.hook = () => {
      if (api.calls.length === step) {
        throw new Error('SECRET READ FAILURE');
      }
    };
    const result = await new Moderation(api, Date.now, all('direct')).request(
      'recall_message',
      { message_id: '-9' },
      ctx,
    );
    assert.deepEqual(result, {
      status: 'error',
      error: 'verification_unavailable',
    });
    assert.equal(api.mutations().length, 0);
    assert.equal(api.calls.length, step);
  }
});
