import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { WakeEffectWaitStore } from '../../../src/observability/wake-effect-waits.ts';
import {
  observeVisibleEffect,
  type EventOrigin,
} from '../../../src/contracts/visible-effect.ts';

const origin: EventOrigin = {
  selfId: '1',
  groupId: '2',
  turnId: 'wake-a',
  receipt: { receivedAt: 1000, receivedMonotonic: 100 },
};

function fixture(
  options: ConstructorParameters<typeof WakeEffectWaitStore>[1] = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'wake-effect-waits-'));
  const path = join(dir, 'telemetry.sqlite');
  const store = new WakeEffectWaitStore(path, options);
  const db = new DatabaseSync(path);
  return {
    store,
    db,
    path,
    rows: () =>
      db.prepare('SELECT * FROM wake_effect_waits ORDER BY turn_id').all(),
    cleanup() {
      store.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('silent completion keeps an eligible row without manufacturing zero; no receipt means no sample', () => {
  const f = fixture();
  try {
    f.store.begin(origin, 1010);
    f.store.begin(
      {
        ...origin,
        turnId: 'invalid',
        receipt: undefined,
      } as unknown as EventOrigin,
      1010,
    );
    f.store.finish(origin, 'silent', 1040);
    assert.equal(f.rows().length, 1);
    const row = f.rows()[0]!;
    assert.equal(row.wake_outcome, 'silent');
    assert.equal(row.wake_finished_at, 1040);
    assert.equal(row.first_effect_at, null);
    assert.equal(row.first_effect_wait_ms, null);
    assert.equal(row.first_effect_kind, null);
  } finally {
    f.cleanup();
  }
});

test('first business confirmation wins by monotonic time, independent of wall adjustments and finish', () => {
  const f = fixture();
  try {
    f.store.begin(origin, 1010);
    f.store.finish(origin, 'finished', 1050);
    f.store.confirm(origin, {
      kind: 'message_sent',
      confirmedAt: 900,
      confirmedMonotonic: 160.5,
    });
    f.store.confirm(origin, {
      kind: 'message_recalled',
      confirmedAt: 1100,
      confirmedMonotonic: 170,
    });
    assert.equal(f.rows()[0]!.first_effect_at, 900);
    assert.equal(f.rows()[0]!.first_effect_wait_ms, 60.5);
    f.store.confirm(origin, {
      kind: 'message_recalled',
      confirmedAt: 1200,
      confirmedMonotonic: 150,
    });
    f.store.confirm(origin, {
      kind: 'group_file_changed',
      confirmedAt: 1201,
      confirmedMonotonic: 150,
    });
    assert.equal(f.rows()[0]!.first_effect_at, 1200);
    assert.equal(f.rows()[0]!.first_effect_wait_ms, 50);
    assert.equal(f.rows()[0]!.first_effect_kind, 'message_recalled');
    assert.equal(f.rows()[0]!.wake_outcome, 'finished');
  } finally {
    f.cleanup();
  }
});

test('late async confirmation updates only original wake and never fabricates a missing origin row', () => {
  const f = fixture();
  try {
    const second = {
      ...origin,
      turnId: 'wake-b',
      receipt: { receivedAt: 1100, receivedMonotonic: 200 },
    };
    f.store.begin(origin, 1010);
    f.store.finish(origin, 'silent', 1050);
    f.store.begin(second, 1110);
    f.store.confirm(origin, {
      kind: 'message_sent',
      confirmedAt: 1200,
      confirmedMonotonic: 300,
    });
    assert.equal(f.rows()[0]!.first_effect_wait_ms, 200);
    assert.equal(f.rows()[1]!.first_effect_wait_ms, null);
    for (const wrong of [
      { ...origin, selfId: '9' },
      { ...origin, groupId: '9' },
      { ...origin, turnId: 'missing' },
      { ...origin, receipt: { receivedAt: 999, receivedMonotonic: 100 } },
    ]) {
      f.store.confirm(wrong, {
        kind: 'message_recalled',
        confirmedAt: 1001,
        confirmedMonotonic: 101,
      });
    }
    assert.equal(f.rows().length, 2);
    assert.equal(f.rows()[0]!.first_effect_wait_ms, 200);
  } finally {
    f.cleanup();
  }
});

test('opening an existing database does not recover others or replace collection start; recovery has no guessed finish', () => {
  const f = fixture();
  let other: WakeEffectWaitStore | undefined;
  try {
    const before = f.db.prepare('SELECT * FROM wake_effect_wait_meta').get();
    f.store.begin(origin, 1010);
    other = new WakeEffectWaitStore(f.path);
    assert.deepEqual(
      f.db.prepare('SELECT * FROM wake_effect_wait_meta').get(),
      before,
    );
    assert.equal(f.rows()[0]!.wake_outcome, null);
    other.recoverInterrupted();
    assert.equal(f.rows()[0]!.wake_outcome, 'interrupted');
    assert.equal(f.rows()[0]!.wake_finished_at, null);
    assert.equal(f.rows()[0]!.first_effect_at, null);
    f.store.confirm(origin, {
      kind: 'message_sent',
      confirmedAt: 1150,
      confirmedMonotonic: 250,
    });
    assert.equal(f.rows()[0]!.first_effect_wait_ms, 150);
  } finally {
    other?.close();
    f.cleanup();
  }
});

test('repeated begin and finish preserve original receipt and first terminal observation', () => {
  const f = fixture();
  try {
    f.store.begin(origin, 1010);
    f.store.begin(
      { ...origin, receipt: { receivedAt: 1200, receivedMonotonic: 300 } },
      1210,
    );
    f.store.finish(origin, 'silent', 1050);
    f.store.finish(origin, 'failed', 2000);
    assert.equal(f.rows()[0]!.trigger_received_at, 1000);
    assert.equal(f.rows()[0]!.wake_started_at, 1010);
    assert.equal(f.rows()[0]!.wake_finished_at, 1050);
    assert.equal(f.rows()[0]!.wake_outcome, 'silent');
  } finally {
    f.cleanup();
  }
});

test('invalid clocks, unknown kinds, accessors and proxies cannot manufacture effects or execute getters', () => {
  const f = fixture();
  try {
    f.store.begin(origin, 1010);
    for (const confirmedMonotonic of [99, NaN, Infinity, -1]) {
      f.store.confirm(origin, {
        kind: 'message_sent',
        confirmedAt: 1100,
        confirmedMonotonic,
      });
    }
    f.store.confirm(origin, {
      kind: 'submitted' as never,
      confirmedAt: 1100,
      confirmedMonotonic: 200,
    });
    const trap = () => {
      throw new Error('must not run');
    };
    f.store.begin(
      new Proxy(origin, { get: trap, getOwnPropertyDescriptor: trap }),
      1010,
    );
    f.store.confirm(
      origin,
      Object.defineProperty({}, 'kind', { get: trap }) as never,
    );
    f.store.confirm(origin, {
      kind: 'message_sent',
      confirmedAt: NaN,
      confirmedMonotonic: 200,
    });
    assert.equal(f.rows()[0]!.first_effect_wait_ms, null);
    f.store.confirm(origin, {
      kind: 'message_sent',
      confirmedAt: 1000,
      confirmedMonotonic: 100,
    });
    assert.equal(f.rows()[0]!.first_effect_wait_ms, 0); // Actual simultaneous clocks, not silent/default zero.
  } finally {
    f.cleanup();
  }
});

test('legacy request and runtime rows never become historical wake samples', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wake-effects-legacy-'));
  const path = join(dir, 'telemetry.sqlite');
  const db = new DatabaseSync(path);
  let store: WakeEffectWaitStore | undefined;
  try {
    db.exec(`CREATE TABLE model_requests(request_id TEXT,started_at INTEGER);
      INSERT INTO model_requests VALUES('old-request',1000);
      CREATE TABLE runtime_events(event TEXT,fields TEXT);
      INSERT INTO runtime_events VALUES('send.complete','{"message_id":"42"}');`);
    const before = Date.now();
    store = new WakeEffectWaitStore(path);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM wake_effect_waits').get()!.n,
      0,
    );
    const meta = db.prepare('SELECT * FROM wake_effect_wait_meta').get()!;
    assert.equal(meta.schema_version, 1);
    assert.ok(Number(meta.collection_started_at) >= before);
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM model_requests').get()!.n,
      1,
    );
    store.recoverInterrupted();
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM wake_effect_waits').get()!.n,
      0,
    );
  } finally {
    store?.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('observer storage failure and shutdown remain fail-open without retrying an effect', () => {
  let errors = 0;
  const f = fixture({
    onError: () => {
      errors++;
      throw new Error('warning failed');
    },
  });
  try {
    f.db.exec('DROP TABLE wake_effect_waits');
    assert.doesNotThrow(() => f.store.begin(origin, 1010));
    assert.equal(errors, 1);
    assert.doesNotThrow(() =>
      observeVisibleEffect(
        {
          confirm: () => {
            throw new Error('observer failed');
          },
        },
        origin,
        'message_sent',
      ),
    );
    f.store.close();
    assert.doesNotThrow(() =>
      f.store.confirm(origin, {
        kind: 'message_sent',
        confirmedAt: 1100,
        confirmedMonotonic: 200,
      }),
    );
  } finally {
    f.cleanup();
  }
});
