import test from 'node:test';
import assert from 'node:assert/strict';
import { createTurnToolkit } from '../../../src/agent/turn-toolkit.ts';
import { GroupFileTools } from '../../../src/tools/files/tools.ts';
import { GroupRequestTools } from '../../../src/tools/requests/tools.ts';
import { applyToolPolicies } from '../../../src/config/runtime.ts';
import { DuplicateMessageAckError } from '../../../src/onebot/operation-result.ts';
import type { Api } from '../../../src/contracts/onebot.ts';
import type { Memory } from '../../../src/contracts/messages.ts';
import type { EventOrigin } from '../../../src/contracts/visible-effect.ts';
import { sessionRuntime } from '../../support/listener-fixture.ts';
import { toolPermissions } from '../../support/tool-permissions.ts';

const groupId = '123',
  selfId = '456',
  ownerId = '789';
const origin: EventOrigin = {
  selfId,
  groupId,
  turnId: 'original',
  receipt: { receivedAt: Date.now(), receivedMonotonic: performance.now() },
};
const context = {
  selfId,
  groupId,
  actorId: ownerId,
  messageId: '1',
  eventOrigin: origin,
};

test('toolkit message confirmation uses each invocation origin before failed projection, even after cancellation', async () => {
  const runtime = sessionRuntime(groupId);
  try {
    const effects: EventOrigin[] = [];
    let valid = true,
      claimed = false,
      duplicate = false;
    const memory: Memory = {
      recent: () => [
        { messageId: '1', userId: ownerId, nickname: '', text: '', time: 1 },
      ],
      find: (id) =>
        id === '1'
          ? { messageId: '1', userId: ownerId, nickname: '', text: '', time: 1 }
          : undefined,
      append: () => {
        throw new Error('must not project late ACK to memory');
      },
      context: () => '',
      async compact() {},
      clear() {},
      close() {},
    };
    const api: Api = {
      async call(action, params) {
        if (action === 'get_login_info') {
          return { user_id: selfId };
        }
        if (action === 'get_msg') {
          return {
            message_id: params!.message_id,
            message_type: 'group',
            group_id: groupId,
            sender: { user_id: ownerId },
            message: [],
          };
        }
        assert.equal(action, 'send_group_forward_msg');
        valid = false;
        return { message_id: '20' };
      },
    };
    runtime.world.append = () => {
      throw new Error('projection failed');
    };
    const kit = createTurnToolkit(
      {
        api,
        groupId,
        ownerId,
        config: applyToolPolicies({
          ownerId,
          groupId,
          enabled: true,
          debounceMs: 0,
          cooldownMs: 0,
          retentionDays: 1,
          toolPermissions: toolPermissions({ send_group_forward: 'direct' }),
        }),
        runtime: {
          ...runtime.runtime,
          effectObserver: {
            confirm(actual) {
              assert.ok(claimed);
              effects.push(actual);
              throw new Error('observer failure');
            },
          },
        },
        groupFiles: new GroupFileTools(api, groupId),
        groupRequests: new GroupRequestTools(api, groupId),
        memory: () => memory,
        proposeExtended: async () => ({ status: 'error' }),
        captureSendReceipt: () => ({ memoryIds: new Set() }),
        claimMessageAck: () => {
          if (duplicate) {
            throw new DuplicateMessageAckError();
          }
          claimed = true;
        },
      },
      { memory, valid: () => valid },
    );
    const result = await kit.extendedTools.execute(
      'send_group_forward',
      { message_ids: ['1'] },
      context,
    );
    assert.equal(result.status, 'executed');
    assert.equal(result.local_projection_failed, true);
    assert.deepEqual(effects, [origin]);
    duplicate = true;
    const repeated = await kit.extendedTools.execute(
      'send_group_forward',
      { message_ids: ['1'] },
      { ...context, eventOrigin: { ...origin, turnId: 'later' } },
    );
    assert.equal(repeated.error, 'duplicate_message_ack');
    assert.deepEqual(effects, [origin]);
  } finally {
    runtime.session.close();
    runtime.world.close();
  }
});
