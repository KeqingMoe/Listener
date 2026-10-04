import assert from 'node:assert/strict';
import test from 'node:test';
import { SandboxService } from '../../../src/sandbox/service.ts';
import { SandboxJobStore } from '../../../src/sandbox/store.ts';
import type { EventOrigin } from '../../../src/contracts/visible-effect.ts';
import type {
  ExecutionOptions,
  ExecutionResult,
} from '../../../src/sandbox/protocol.ts';

const scope = { selfId: '99', groupId: '88' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const mode of ['async', 'auto'] as const) {
  test(`${mode} jobs retain immutable submitting wake across detach and late host receipts`, async () => {
    const store = new SandboxJobStore({ path: ':memory:' });
    const guest = deferred<ExecutionResult>();
    const rpc = deferred<Record<string, string>>();
    let execution!: ExecutionOptions;
    const origins: (EventOrigin | undefined)[] = [];
    const origin = {
      ...scope,
      turnId: 'wake-one',
      receipt: { receivedAt: 1000, receivedMonotonic: 100 },
    };
    const caller = { actorId: '7', messageId: '6', eventOrigin: origin };
    const service = new SandboxService({
      store,
      executor: (options) => {
        execution = options;
        return {
          result: guest.promise,
          cancel: () =>
            guest.resolve({
              status: 'cancelled',
              logs: [],
              error: 'cancelled',
            }),
        };
      },
    });
    service.setToolBridge({
      names: () => ['send_message'],
      async call(context) {
        origins.push(context.eventOrigin);
        return rpc.promise;
      },
    });
    try {
      const running = service.execute(
        {
          ...scope,
          code: 'return 1',
          description: 'origin',
          mode,
          ...(mode === 'auto' ? { waitMs: 1 } : {}),
        },
        undefined,
        caller,
      );
      // Mutating the submitter context must not change the queued/live job origin.
      origin.turnId = 'wake-two';
      origin.receipt.receivedAt = 2000;
      const response = await running;
      assert.equal(response.status, 'pending');
      const call = execution.callTool!(
        'send_message',
        { eventOrigin: { turnId: 'guest-forgery' } },
        new AbortController().signal,
      );
      assert.equal(origins[0]?.turnId, 'wake-one');
      assert.equal(origins[0]?.receipt.receivedAt, 1000);
      assert.ok(Object.isFrozen(origins[0]));
      assert.ok(Object.isFrozen(origins[0]?.receipt));
      // The guest may settle before a dispatched host RPC does.
      service.cancel(scope, response.job_id!);
      rpc.resolve({ status: 'executed' });
      assert.deepEqual(await call, { status: 'executed' });
      assert.equal(origins[0]?.turnId, 'wake-one');
    } finally {
      rpc.resolve({ status: 'executed' });
      guest.resolve({ status: 'completed', value: '', logs: [] });
      await service.stop();
      store.close();
    }
  });
}
