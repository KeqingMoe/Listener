import { createApp, nextTick } from 'vue';
import { createRouter, createMemoryHistory } from 'vue-router';
import ToolDetails from '../../../src/dashboard/web/src/components/review/ToolDetails.vue';
import OriginalChatLines from './OriginalChatLines.vue';
import { toolView } from '../../../src/dashboard/web/src/components/review/tool-summary';
import '../../../src/dashboard/web/src/styles/main.css';

const result = await fetch('/api/proof/read_events').then((r) => r.json());
const lookup = {
  names: new Map([['10001', '机器人']]),
  quotes: new Map([
    [
      'quoted',
      {
        userId: '10009',
        nickname: '被引用者',
        segments: [{ type: 'text', text: '原有引用内容' }],
      },
    ],
  ]),
};
const tool = {
  ordinal: 1,
  name: 'read_events',
  requestId: null,
  callId: 'proof',
  state: 'finished',
  status: 'ok',
  outcome: 'handled',
  reasonCode: null,
  durationMs: 200,
  proposedAt: null,
  startedAt: null,
  finishedAt: null,
  arguments: {},
  result,
};
const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/', component: { render: () => null } }],
});
await router.push('/');
createApp(ToolDetails, { tool, groupId: '10001', lookup })
  .use(router)
  .mount('#app');
Object.assign(globalThis, {
  showOracle: async () => {
    const holder = globalThis.document.createElement('div');
    const view = toolView('read_events', {}, result, lookup);
    if (view?.kind !== 'messages') {
      throw new Error('Expected messages view');
    }
    createApp(OriginalChatLines, { view }).mount(holder);
    await nextTick();
    // 在真实 ToolDetails 外壳内原位替换，仅列表取自历史 oracle。
    globalThis.document
      .querySelector('.chat-lines')
      .replaceWith(holder.firstElementChild);
  },
});
