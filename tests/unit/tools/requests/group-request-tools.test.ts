import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GroupRequestTools,
  GROUP_REQUEST_TOOL_NAMES,
} from '../../../../src/tools/requests/tools.ts';
import type { Api } from '../../../../src/contracts/onebot.ts';
import type { JsonObject } from '../../../../src/contracts/json.ts';
import type { TurnContext } from '../../../../src/contracts/tools.ts';

const group = '12345',
  self = '333',
  applicant = '444';
const ctx: TurnContext = {
  groupId: group,
  selfId: self,
  actorId: '555',
  messageId: '1',
};
const req = (overrides: JsonObject = {}): JsonObject => ({
  request_id: 1780000000000001,
  group_id: Number(group),
  invitor_uin: Number(applicant),
  requester_nick: 'applicant',
  message: 'hello',
  checked: false,
  actor: 0,
  ...overrides,
});

function setup(
  options: {
    enabled?: readonly string[];
    rows?: unknown[];
    invites?: unknown[];
    hook?: (action: string, params: JsonObject) => unknown | Promise<unknown>;
    write?: unknown;
  } = {},
) {
  const calls: Array<{ action: string; params: JsonObject }> = [],
    writes: Array<{ action: string; params: JsonObject }> = [];
  let rows = options.rows ?? [req()],
    role = 'admin',
    login: unknown = { user_id: Number(self) };
  const api: Api = {
    async call(action, params = {}) {
      calls.push({ action, params });
      const value = await options.hook?.(action, params);
      if (value !== undefined) {
        return value;
      }
      if (action === 'get_login_info') {
        return login;
      }
      if (action === 'get_group_member_info') {
        return { group_id: Number(group), user_id: Number(self), role };
      }
      if (action === 'get_group_system_msg') {
        return { join_requests: rows, invited_requests: options.invites ?? [] };
      }
      writes.push({ action, params });
      return options.write ?? null;
    },
  };
  const tools = new GroupRequestTools(
    api,
    group,
    options.enabled ?? GROUP_REQUEST_TOOL_NAMES,
  );
  return {
    tools,
    calls,
    writes,
    setRows: (r: unknown[]) => {
      rows = r;
    },
    setRole: (r: string) => {
      role = r;
    },
    setLogin: (r: unknown) => {
      login = r;
    },
  };
}

async function listing(
  f: ReturnType<typeof setup>,
  args: JsonObject = { limit: 100 },
) {
  return f.tools.execute('list_group_requests', args, ctx);
}

async function handle(f: ReturnType<typeof setup>) {
  const response = await listing(f);
  assert.equal(response.status, 'ok');
  const token = (response.items as JsonObject[])[0]?.request_handle;
  assert.equal(typeof token, 'string');
  return token as string;
}

const respond = (
  f: ReturnType<typeof setup>,
  token: string,
  approve = true,
  reason = '',
  signal?: AbortSignal,
) =>
  f.tools.execute(
    'respond_group_request',
    { request_handle: token, approve, reason },
    ctx,
    signal,
  );

test('capabilities default off; strict names and immutable configuration', async () => {
  const off = setup({ enabled: [] });
  assert.deepEqual(off.tools.definitions(), []);
  assert.equal((await listing(off)).error, 'tool_disabled');
  assert.equal(off.calls.length, 0);
  const enabled = ['list_group_requests'];
  const f = setup({ enabled });
  enabled.push('respond_group_request');
  assert.equal(f.tools.definitions().length, 1);
  assert.equal(
    (await respond(f, 'grq_' + 'a'.repeat(48))).error,
    'tool_disabled',
  );
  assert.throws(() => setup({ enabled: ['set_group_add_request'] }));
  for (const d of setup().tools.definitions()) {
    assert.equal(d.function.parameters.additionalProperties, false);
  }
});

test('list only outputs verified current-group direct pending joins with opaque handles', async () => {
  const f = setup({
    rows: [
      req({ token: 'SECRET' }),
      req({
        group_id: 999,
        request_id: 2,
        message: 'FOREIGN',
        requester_nick: 'FOREIGN',
      }),
      req({ group_id: undefined, request_id: 3, message: 'MISSING_GROUP' }),
      req({ checked: true, request_id: 4, message: 'HANDLED' }),
      req({ request_id: Number.MAX_SAFE_INTEGER + 1, message: 'IMPRECISE' }),
      req({ request_id: '1780000000000002', message: 'WRONG_SCHEMA' }),
      req({ request_id: 5, invitor_uin: 0, message: 'NO_APPLICANT' }),
    ],
    invites: [req({ request_id: 6, message: 'INVITATION', group_id: 999 })],
  });
  const r = await listing(f);
  assert.equal(r.status, 'ok');
  assert.equal(r.returned, 1);
  assert.equal(r.total, 1);
  assert.equal(r.untrusted, true);
  assert.match(String(r.completeness), /unknown/);
  const item = (r.items as JsonObject[])[0]!;
  assert.match(String(item.request_handle), /^grq_[0-9a-f]{48}$/);
  assert.equal(item.applicant_id, applicant);
  assert.equal(item.pending_observed, true);
  assert.doesNotMatch(
    JSON.stringify(r),
    /1780000000000001|FOREIGN|MISSING_GROUP|HANDLED|IMPRECISE|WRONG_SCHEMA|NO_APPLICANT|INVITATION|SECRET|request_id|invitor_uin/,
  );
  assert.deepEqual(
    f.calls.map((x) => x.action),
    ['get_login_info', 'get_group_member_info', 'get_group_system_msg'],
  );
});

test('colliding account-wide flags including invited requests never become capabilities', async () => {
  for (const extra of [
    { rows: [req(), req({ group_id: 999 })] },
    { rows: [req()], invites: [req({ group_id: 999 })] },
  ]) {
    const f = setup(extra);
    assert.equal((await listing(f)).returned, 0);
  }
});

test('unknown fields invalid primitives zero unsafe limits and raw flags have no API effect', async () => {
  const f = setup();
  const getter = Object.defineProperty({}, 'limit', {
    get() {
      throw Error('must not run');
    },
    enumerable: true,
  });
  for (const args of [
    {},
    { limit: 0 },
    { limit: 1.5 },
    { limit: Infinity },
    { limit: Number.MAX_SAFE_INTEGER + 1 },
    { limit: '1' },
    { limit: 1, offset: -1 },
    { limit: 1, offset: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 1, group_id: group },
    getter,
    null,
    [],
    Object.assign(Object.create({}), { limit: 1 }),
  ]) {
    assert.equal(
      (await f.tools.execute('list_group_requests', args, ctx)).error,
      'invalid_arguments',
    );
  }
  for (const args of [
    { flag: '1780000000000001', approve: true, reason: '' },
    { request_handle: '1780000000000001', approve: true, reason: '' },
    { request_handle: 'grq_' + 'f'.repeat(48), approve: 'true', reason: '' },
    {
      request_handle: 'grq_' + 'f'.repeat(48),
      approve: true,
      reason: 'not empty',
    },
    {
      request_handle: 'grq_' + 'f'.repeat(48),
      approve: false,
      reason: '字'.repeat(171),
    },
    {
      request_handle: 'grq_' + 'f'.repeat(48),
      approve: false,
      reason: '\u0000',
    },
  ]) {
    assert.equal(
      (await f.tools.execute('respond_group_request', args, ctx)).error,
      'invalid_arguments',
    );
  }
  assert.equal(
    (await respond(f, 'grq_' + 'f'.repeat(48))).error,
    'invalid_request_handle',
  );
  assert.equal(f.calls.length, 0);
  assert.equal(f.writes.length, 0);
});

test('scope login membership and real administrator role gate all discovery', async () => {
  const f = setup();
  assert.equal(
    (
      await f.tools.execute(
        'list_group_requests',
        { limit: 1 },
        { ...ctx, groupId: '999' },
      )
    ).error,
    'forbidden_group',
  );
  assert.equal(f.calls.length, 0);
  f.setLogin({ user_id: 999 });
  assert.equal((await listing(f)).error, 'identity_mismatch');
  f.setLogin({ user_id: Number.MAX_SAFE_INTEGER + 1 });
  assert.equal((await listing(f)).error, 'identity_mismatch');
  f.setLogin({ user_id: self });
  f.setRole('member');
  assert.equal((await listing(f)).error, 'permission_denied');
  const invited = setup({
    invites: [req()],
    hook(action) {
      if (action === 'get_group_member_info') {
        throw Error('Not member PRIVATE');
      }
    },
  });
  assert.equal((await listing(invited)).error, 'verification_unavailable');
  assert.equal(
    invited.calls.some((c) => c.action === 'get_group_system_msg'),
    false,
  );
});

test('response rechecks pending identity and current role, passing exact non-model flag params', async () => {
  const f = setup();
  const token = await handle(f);
  const r = await respond(
    f,
    token,
    false,
    'literal https://site/path [CQ:at,qq=1]',
  );
  assert.equal(r.status, 'ok');
  assert.equal(r.submitted, true);
  assert.equal(r.effect_confirmed, false);
  assert.equal(r.retry_allowed, false);
  assert.deepEqual(f.writes, [
    {
      action: 'set_group_add_request',
      params: {
        flag: '1780000000000001',
        approve: false,
        reason: 'literal https://site/path [CQ:at,qq=1]',
        count: 1000,
      },
    },
  ]);
  assert.equal(
    f.calls.filter((c) => c.action === 'get_group_member_info').length,
    3,
  );
  assert.doesNotMatch(JSON.stringify(r), /1780000000000001|site|CQ/);
});

test('fresh pending proof rejects handled missing moved or replaced applicants', async () => {
  for (const changed of [
    [],
    [req({ checked: true })],
    [req({ invitor_uin: 777 })],
    [req({ group_id: 999 })],
    [req({ request_id: 123 })],
    [req({ checked: undefined })],
  ]) {
    const f = setup();
    const token = await handle(f);
    f.setRows(changed);
    assert.equal(
      (await respond(f, token)).error,
      'request_not_pending_or_changed',
    );
    assert.equal(f.writes.length, 0);
  }
  const f = setup();
  const token = await handle(f);
  f.setRole('member');
  assert.equal((await respond(f, token)).error, 'permission_denied');
  assert.equal(f.writes.length, 0);
});

test('role and identity are refreshed after the potentially slow pending query', async () => {
  for (const changed of ['role', 'identity']) {
    let f: ReturnType<typeof setup>,
      queries = 0;
    f = setup({
      hook(action) {
        if (action === 'get_group_system_msg' && ++queries === 2) {
          if (changed === 'role') {
            f.setRole('member');
          } else {
            f.setLogin({ user_id: '999' });
          }
        }
      },
    });
    const token = await handle(f);
    assert.equal(
      (await respond(f, token)).error,
      changed === 'role' ? 'permission_denied' : 'identity_mismatch',
    );
    assert.equal(f.writes.length, 0);
  }
});

test('native null is submitted including late cancel, while invalid shape and errors remain unknown without retries', async () => {
  for (const mode of ['null', 'zero', 'error', 'cancel']) {
    const controller = new AbortController();
    let dispatched = 0;
    const f = setup({
      write: mode === 'zero' ? { result: 0 } : null,
      hook(action) {
        if (action === 'set_group_add_request') {
          dispatched++;
          if (mode === 'error') {
            throw Error('SECRET URL');
          }
          if (mode === 'cancel') {
            controller.abort();
          }
        }
      },
    });
    const token = await handle(f);
    const result = await respond(f, token, true, '', controller.signal);
    const accepted = mode === 'null' || mode === 'cancel';
    assert.equal(result.status, accepted ? 'ok' : 'unknown');
    if (accepted) {
      assert.equal(result.submitted, true);
      assert.equal(result.effect_confirmed, false);
    }
    if (mode === 'cancel') {
      assert.equal(result.cancelled_after_dispatch, true);
    }
    assert.equal(result.retry_allowed, false);
    assert.doesNotMatch(JSON.stringify(result), /SECRET|URL/);
    assert.equal(
      (await respond(f, token, false, 'deny')).error,
      accepted ? 'request_already_submitted' : 'previous_result_unknown',
    );
    f.tools.resetWake();
    const again = await respond(f, token);
    if (accepted) {
      assert.equal(again.submitted, true);
      assert.equal(again.cached, true);
      assert.equal(again.dispatched, false);
    } else {
      assert.equal(again.error, 'previous_result_unknown');
    }
    assert.equal(dispatched, 1);
  }
});

test('unknown locks survive handle expiry reset and replacement handle across wakes', async () => {
  const f = setup({ write: { malformed: true } });
  const old = await handle(f);
  await respond(f, old);
  f.tools.reset();
  assert.equal((await respond(f, old)).error, 'invalid_request_handle');
  const fresh = await handle(f);
  assert.notEqual(fresh, old);
  assert.equal((await respond(f, fresh)).error, 'previous_result_unknown');
  assert.equal(f.writes.length, 1);
  assert.equal(
    ((await listing(f)).items as JsonObject[])[0]!.previous_outcome,
    'unknown',
  );
});

test('submitted outcomes survive replacement handles and reset without blocking independent requests', async () => {
  const f = setup();
  const old = await handle(f);
  const sent = await respond(f, old);
  assert.equal(sent.submitted, true);
  f.tools.reset();
  const fresh = await handle(f);
  assert.notEqual(fresh, old);
  assert.equal((await respond(f, fresh)).cached, true);
  assert.equal(
    (await respond(f, fresh, false, 'deny')).error,
    'request_already_submitted',
  );
  assert.equal(
    ((await listing(f)).items as JsonObject[])[0]!.previous_outcome,
    'submitted',
  );
  f.setRole('member');
  assert.equal((await respond(f, fresh)).error, 'permission_denied');
  f.setRole('admin');
  f.setRows([req({ request_id: 6789 })]);
  const independent = await handle(f);
  assert.equal((await respond(f, independent)).submitted, true);
  assert.equal(f.writes.length, 2);
  assert.doesNotMatch(JSON.stringify(sent), /1780000000000001/);
  f.setRows([req({ invitor_uin: 999 })]);
  const changed = await handle(f);
  assert.equal((await respond(f, changed)).error, 'request_identity_changed');
  assert.equal(
    ((await listing(f)).items as JsonObject[])[0]!.previous_outcome,
    'identity_conflict',
  );
  assert.equal(f.writes.length, 2);
});

test('TTL expiry and cross-instance/cross-bot handles are rejected', async () => {
  const f = setup();
  const token = await handle(f);
  assert.equal((await respond(setup(), token)).error, 'invalid_request_handle');
  assert.equal(
    (
      await f.tools.execute(
        'respond_group_request',
        { request_handle: token, approve: true, reason: '' },
        { ...ctx, selfId: '999' },
      )
    ).error,
    'invalid_request_handle',
  );
  const now = Date.now;
  try {
    const start = now();
    Date.now = () => start + 15 * 60 * 1000 + 1;
    assert.equal((await respond(f, token)).error, 'invalid_request_handle');
  } finally {
    Date.now = now;
  }
  assert.equal(f.writes.length, 0);
});

test('cancel or reset during any preflight await discards result without write', async () => {
  for (const action of [
    'get_login_info',
    'get_group_member_info',
    'get_group_system_msg',
  ]) {
    const controller = new AbortController();
    let armed = false;
    const f = setup({
      hook(name) {
        if (armed && name === action) {
          controller.abort();
        }
      },
    });
    const token = await handle(f);
    armed = true;
    assert.equal(
      (await respond(f, token, true, '', controller.signal)).error,
      'cancelled',
    );
    assert.equal(f.writes.length, 0);
  }
  let f: ReturnType<typeof setup>,
    armed = false;
  f = setup({
    hook(action) {
      if (armed && action === 'get_group_system_msg') {
        f.tools.reset();
      }
    },
  });
  const token = await handle(f);
  armed = true;
  assert.equal((await respond(f, token)).error, 'capabilities_revoked');
  assert.equal(f.writes.length, 0);
});

test('list pagination and byte/source limits are honest without arbitrary 20-row cap', async () => {
  const f = setup({
    rows: Array.from({ length: 150 }, (_, i) =>
      req({ request_id: 1000 + i, message: 'm', requester_nick: 'n' }),
    ),
  });
  const a = await listing(f, { limit: 50 });
  assert.equal(a.returned, 50);
  assert.equal(a.next_offset, 50);
  const last = await listing(f, {
    limit: Number.MAX_SAFE_INTEGER,
    offset: 149,
  });
  assert.equal(last.returned, 1);
  assert.equal(last.next_offset, null);
  const distant = await listing(f, {
    limit: Number.MAX_SAFE_INTEGER,
    offset: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(distant.returned, 0);
  assert.equal(distant.next_offset, null);
  const huge = setup({
    rows: Array.from({ length: 50 }, (_, i) =>
      req({
        request_id: 1000 + i,
        message: '字'.repeat(5000),
        requester_nick: '字'.repeat(5000),
      }),
    ),
  });
  const r = await listing(huge, { limit: 50 });
  assert.ok(Buffer.byteLength(JSON.stringify(r)) <= 24 * 1024);
  assert.equal(r.reason, 'output_limit');
  assert.equal(r.next_offset, r.returned);
  assert.ok(Number(r.returned) > 0);
  assert.equal(r.truncated, true);
  assert.equal(
    (await listing(setup({ rows: Array(1001).fill(req()) }))).error,
    'resource_limit',
  );
});

test('concurrent decisions serialize and dispatch once even with opposite approve values', async () => {
  const f = setup();
  const token = await handle(f);
  const results = await Promise.all([
    respond(f, token, true, ''),
    respond(f, token, false, 'deny'),
  ]);
  assert.equal(results[0]!.submitted, true);
  assert.equal(results[1]!.error, 'request_already_submitted');
  assert.equal(f.writes.length, 1);
});

test('handle capacity stops issuance explicitly rather than evicting live capabilities', async () => {
  const f = setup();
  let issued = 0,
    lastOffset = 0;
  for (let batch = 0; batch < 4200; batch += 100) {
    f.setRows(
      Array.from({ length: 100 }, (_, i) =>
        req({ request_id: 1000 + batch + i, message: '', requester_nick: '' }),
      ),
    );
    let offset = 0,
      full = false;
    for (let page = 0; page < 10; page++) {
      const r = await listing(f, { limit: 100, offset });
      assert.equal(r.status, 'ok');
      issued += Number(r.returned);
      if (r.reason === 'handle_capacity') {
        lastOffset = Number(r.next_offset);
        full = true;
        break;
      }
      if (r.next_offset === null) {
        break;
      }
      offset = Number(r.next_offset);
    }
    if (full) {
      break;
    }
  }
  assert.equal(issued, 4096);
  assert.equal(
    (await listing(f, { limit: 1, offset: lastOffset })).reason,
    'handle_capacity',
  );
});

test('bounded account prefix never claims global completeness or silently increases native count', async () => {
  const f = setup({ rows: [req({ group_id: 999 })] });
  const r = await listing(f, {
    limit: Number.MAX_SAFE_INTEGER,
    offset: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(r.returned, 0);
  assert.equal(r.upstream_has_more, null);
  assert.match(String(r.upstream_coverage), /missing_is_not_absence/);
  assert.deepEqual(
    f.calls.find((c) => c.action === 'get_group_system_msg')!.params,
    { count: 1000 },
  );
});

test('submitted and unknown records share capacity across reset without unsafe eviction', async () => {
  let dispatch = 0;
  const f = setup({
    hook: (a) =>
      a === 'set_group_add_request'
        ? dispatch++ % 2
          ? { malformed: true }
          : null
        : undefined,
  });
  for (let i = 0; i < 4096; i++) {
    f.tools.reset();
    f.setRows([req({ request_id: 1000 + i })]);
    const token = await handle(f);
    assert.equal((await respond(f, token)).status, i % 2 ? 'unknown' : 'ok');
  }
  f.tools.reset();
  f.setRows([req({ request_id: 99999 })]);
  const extra = await handle(f);
  assert.equal((await respond(f, extra)).error, 'outcome_lock_capacity');
  assert.equal(dispatch, 4096);
  f.tools.reset();
  f.setRows([req({ request_id: 1001 })]);
  const first = await handle(f);
  assert.equal((await respond(f, first)).error, 'previous_result_unknown');
  f.tools.reset();
  f.setRows([req({ request_id: 1000 })]);
  const accepted = await handle(f);
  assert.equal((await respond(f, accepted)).cached, true);
  assert.equal(dispatch, 4096);
});
