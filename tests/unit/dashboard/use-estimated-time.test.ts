import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  computed,
  createRenderer,
  defineComponent,
  h,
  KeepAlive,
  nextTick,
  ref,
  type Ref,
} from 'vue';
import { useEstimatedTime } from '../../../src/dashboard/web/src/composables/useEstimatedTime.ts';
import { serverClock } from '../../../src/dashboard/web/src/composables/serverClock.ts';

// Minimal Vue host: exercise actual lifecycle hooks without a browser or DOM package.
interface HostNode {
  parent: HostNode | null;
}

const node = (): HostNode => ({ parent: null });
const renderer = createRenderer<HostNode, HostNode>({
  patchProp() {},
  insert(child, parent) {
    child.parent = parent;
  },
  remove(child) {
    child.parent = null;
  },
  createElement: node,
  createText: node,
  createComment: node,
  setText() {},
  setElementText() {},
  parentNode: (child) => child.parent,
  nextSibling: () => null,
});

function mockEnvironment(t: TestContext) {
  const document = Object.assign(new EventTarget(), { hidden: false });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: document,
  });
  t.after(() => {
    Reflect.deleteProperty(globalThis, 'document');
  });
  t.mock.timers.enable({ apis: ['setInterval'] });
  const intervals = t.mock.method(globalThis, 'setInterval');
  const clears = t.mock.method(globalThis, 'clearInterval');
  const removes = t.mock.method(document, 'removeEventListener');
  let epoch = 1000;
  t.mock.method(serverClock, 'now', () => epoch);
  return {
    document,
    intervals,
    clears,
    removes,
    advance: (value: number) => {
      epoch = value;
    },
  };
}

test('estimated time stops inactive, hidden, deactivated and unmounted; resumes immediately', async (t) => {
  const env = mockEnvironment(t);
  const active = ref(false);
  const shown = ref(true);
  let now!: Ref<number>;
  const Child = defineComponent({
    setup() {
      now = useEstimatedTime(active);
      return () => h('div');
    },
  });
  const app = renderer.createApp({
    render: () =>
      h(KeepAlive, null, { default: () => (shown.value ? h(Child) : null) }),
  });
  app.mount(node());
  try {
    assert.equal(env.intervals.mock.callCount(), 0);
    env.advance(2000);
    active.value = true;
    await nextTick();
    assert.equal(now.value, 2000);
    env.advance(2250);
    t.mock.timers.tick(250);
    assert.equal(now.value, 2250);
    active.value = false;
    await nextTick();
    env.advance(3000);
    t.mock.timers.tick(1000);
    assert.equal(now.value, 2250);
    active.value = true;
    await nextTick();
    env.document.hidden = true;
    env.document.dispatchEvent(new Event('visibilitychange'));
    env.advance(60_000);
    t.mock.timers.tick(1000);
    assert.equal(now.value, 3000);
    env.document.hidden = false;
    env.document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(now.value, 60_000);
    shown.value = false;
    await nextTick();
    env.advance(90_000);
    t.mock.timers.tick(1000);
    env.document.dispatchEvent(new Event('visibilitychange'));
    assert.equal(now.value, 60_000);
    shown.value = true;
    await nextTick();
    assert.equal(now.value, 90_000);
  } finally {
    app.unmount();
  }
  assert.equal(env.intervals.mock.callCount(), env.clears.mock.callCount());
  assert.equal(env.removes.mock.callCount(), 1);
  env.advance(100_000);
  env.document.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(1000);
  assert.equal(now.value, 90_000);
});

test('active depending on now stops at zero without dependency loops or timer restart', async (t) => {
  const env = mockEnvironment(t);
  let now!: Ref<number>;
  const deadline = ref(Infinity);
  const active = computed(
    () => deadline.value === Infinity || now.value < deadline.value,
  );
  const app = renderer.createApp({
    setup() {
      now = useEstimatedTime(active);
      return () => h('div');
    },
  });
  app.mount(node());
  deadline.value = 1500;
  await nextTick();
  try {
    env.advance(1500);
    t.mock.timers.tick(250);
    await nextTick();
    assert.equal(active.value, false);
    assert.equal(env.intervals.mock.callCount(), 1);
    assert.equal(env.clears.mock.callCount(), 1);
    env.advance(2000);
    t.mock.timers.tick(1000);
    await nextTick();
    assert.equal(now.value, 1500);
    assert.equal(env.intervals.mock.callCount(), 1);
  } finally {
    app.unmount();
  }
});
