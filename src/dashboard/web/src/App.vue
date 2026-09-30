<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRefreshScheduler } from './composables/useRefreshScheduler';
import { useRoute, useRouter } from 'vue-router';
import {
  authenticated,
  configured,
  configurationError,
  auth,
} from './composables/useAuth';
import {
  activeRequests,
  useResource,
  useFilters,
} from './composables/useDashboard';

const { autoRefresh, pageVisible, refreshBackoff, countdown } =
  useRefreshScheduler();
import type { MetaResponse } from '../../contracts/contracts';

const route = useRoute(),
  router = useRouter();
const password = ref(''),
  authError = ref(''),
  busy = ref(false);

async function submit(action: 'login' | 'logout') {
  busy.value = true;
  authError.value = '';
  try {
    await auth(
      action,
      action === 'login' ? { password: password.value } : undefined,
    );
    password.value = '';
  } catch (e) {
    authError.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

function unauthorized() {
  authenticated.value = false;
  password.value = '';
}

onMounted(() => {
  window.addEventListener('dashboard:unauthorized', unauthorized);
  auth().catch((e) => {
    authError.value = e.message;
    authenticated.value = false;
  });
});
onUnmounted(() =>
  window.removeEventListener('dashboard:unauthorized', unauthorized),
);
const nav = [
  ['/', '总览'],
  ['/wakes', '唤醒'],
  ['/requests', '模型请求'],
  ['/tools', '工具'],
  ['/events', '事件'],
];
const { groupId, range } = useFilters();
const {
  data: meta,
  error: metaError,
  retry: retryMeta,
} = useResource<MetaResponse>(computed(() => 'meta'));
const search = ref('');
watch(
  () => route.query.q,
  (v) => (search.value = typeof v === 'string' ? v : ''),
  { immediate: true },
);

function filter(key: string, value: string) {
  const extra =
    key === 'range' && value === 'custom'
      ? {
          since: String(Math.floor(Date.now() / 60000) * 60000 - 86400000),
          until: String(Math.floor(Date.now() / 60000) * 60000),
        }
      : {};
  router.push({
    path: route.path,
    query: {
      ...route.query,
      ...extra,
      [key]: value || undefined,
      selected: undefined,
      detailGroup: undefined,
      cursor: undefined,
    },
  });
}

const since = ref(''),
  until = ref(''),
  rangeError = ref('');
watch(
  () => [route.query.since, route.query.until],
  () => {
    const local = (v: unknown) => {
      if (!v) {
        return '';
      }
      const d = new Date(Number(v));
      return Number.isFinite(d.getTime())
        ? new Date(d.getTime() - d.getTimezoneOffset() * 60000)
            .toISOString()
            .slice(0, 16)
        : '';
    };
    since.value = local(route.query.since);
    until.value = local(route.query.until);
  },
  { immediate: true },
);

function applyRange() {
  const s = new Date(since.value).getTime(),
    u = new Date(until.value).getTime();
  if (
    !Number.isFinite(s) ||
    !Number.isFinite(u) ||
    u <= s ||
    u - s > 31 * 86400000
  ) {
    rangeError.value = '请选择有效时间范围（最多31天）。';
    return;
  }
  rangeError.value = '';
  router.push({
    query: {
      ...route.query,
      since: String(s),
      until: String(u),
      selected: undefined,
      cursor: undefined,
    },
  });
}
</script>
<template>
  <div v-if="authenticated === null" class="auth-shell">
    <p>正在检查会话…</p>
  </div>
  <div v-else-if="configured === false" class="auth-shell">
    <section class="login-panel">
      <h1>拒绝访问</h1>
      <p role="alert">{{ configurationError }}</p>
    </section>
  </div>
  <div v-else-if="!authenticated" class="auth-shell">
    <form class="login-panel" @submit.prevent="submit('login')">
      <div class="brand">LISTENER <span>运维审阅台</span></div>
      <h1>登录</h1>
      <label
        >密码<input
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
          autofocus
      /></label>
      <p class="muted">在此浏览器保持登录7天</p>
      <p v-if="authError" class="error" role="alert">{{ authError }}</p>
      <button type="submit" :disabled="busy">
        {{ busy ? '正在登录…' : '登录' }}
      </button>
    </form>
  </div>
  <div v-else class="shell">
    <a class="skip-link" href="#main">跳至内容</a>
    <header class="topbar">
      <div class="brand">LISTENER <span>运维审阅台</span></div>
      <nav aria-label="主要导航">
        <RouterLink
          v-for="[path, label] in nav"
          :key="path"
          :to="{
            path,
            query: {
              ...route.query,
              outcome: path === route.path ? route.query.outcome : undefined,
              model: path === '/requests' ? route.query.model : undefined,
              selected: undefined,
              detailGroup: undefined,
              cursor: undefined,
            },
          }"
          :class="{ active: route.path === path }"
          >{{ label }}</RouterLink
        >
      </nav>
      <div class="account" title="只读业务界面 · Cookie 会话已记住">
        <button :disabled="busy" @click="submit('logout')">退出</button>
      </div>
    </header>
    <div v-if="authError" class="notice error" role="alert">
      {{ authError }}
    </div>
    <section class="filterbar" aria-label="筛选">
      <label
        >群组<select
          aria-label="群组"
          :value="groupId"
          @change="filter('group', ($event.target as HTMLSelectElement).value)"
        >
          <option value="">全部群组</option>
          <option v-for="g in meta?.groups" :key="g.groupId" :value="g.groupId">
            {{ g.groupId }}
          </option>
        </select></label
      ><label
        >时间<select
          aria-label="时间范围"
          :value="range"
          @change="filter('range', ($event.target as HTMLSelectElement).value)"
        >
          <option value="5m">最近5分钟</option>
          <option value="15m">最近15分钟</option>
          <option value="1h">最近1小时</option>
          <option value="3h">最近3小时</option>
          <option value="6h">最近6小时</option>
          <option value="24h">最近24小时</option>
          <option value="3d">最近3天</option>
          <option value="7d">最近7天</option>
          <option value="30d">最近30天</option>
          <option value="custom">自定义</option>
        </select></label
      ><label v-if="route.path === '/requests' || route.path === '/wakes'"
        >状态<select
          aria-label="状态"
          :value="route.query.outcome || ''"
          @change="
            filter('outcome', ($event.target as HTMLSelectElement).value)
          "
        >
          <option value="">全部状态</option>
          <template v-if="route.path === '/wakes'"
            ><option value="running">执行中</option>
            <option value="message_submitted">消息已提交</option>
            <option value="replied">已回复</option>
            <option value="silent">主动结束</option>
            <option value="failed">失败</option>
            <option value="cancelled">已取消</option>
            <option value="delivery_unknown">发送结果不明</option></template
          ><template v-else
            ><option value="running">执行中</option>
            <option value="interrupted">已中断</option>
            <option value="success">成功</option>
            <option value="failed">失败</option>
            <option value="timeout">超时</option>
            <option value="cancelled">已取消</option>
            <option value="unknown">结果不明</option></template
          >
        </select></label
      ><label v-if="route.path === '/requests' && meta?.models.length"
        >模型<select
          aria-label="模型"
          :value="route.query.model || ''"
          @change="filter('model', ($event.target as HTMLSelectElement).value)"
        >
          <option value="">全部模型</option>
          <option v-for="m in meta.models" :key="m" :value="m">
            {{ m }}
          </option>
        </select></label
      >
      <form class="search-form" @submit.prevent="filter('q', search)">
        <input
          v-model="search"
          aria-label="搜索记录"
          :title="
            route.path === '/events'
              ? '匹配事件、群组、轮次与消息标识'
              : undefined
          "
          placeholder="搜索记录…"
          type="search"
        /><button>搜索</button>
      </form>
      <div class="refresh-control">
        <label class="auto-refresh"
          ><input
            v-model="autoRefresh"
            type="checkbox"
            aria-label="自动刷新"
          />自动刷新</label
        ><span
          class="muted refresh-countdown"
          data-testid="dashboard-refresh-status"
          >{{
            !autoRefresh
              ? '已暂停'
              : !pageVisible
                ? '页面隐藏，已暂停'
                : activeRequests
                  ? '刷新中…'
                  : refreshBackoff
                    ? `${countdown}秒后重试`
                    : `${countdown}秒`
          }}</span
        >
      </div>
    </section>
    <form
      v-if="range === 'custom'"
      class="custom-range"
      @submit.prevent="applyRange"
    >
      <label
        >开始<input
          v-model="since"
          type="datetime-local"
          aria-label="开始时间"
          required /></label
      ><label
        >结束<input
          v-model="until"
          type="datetime-local"
          aria-label="结束时间"
          required /></label
      ><button>应用时间范围</button
      ><span v-if="rangeError" class="error">{{ rangeError }}</span>
    </form>
    <div v-if="metaError" class="notice error" role="alert">
      {{ meta ? '群组信息已过期，更新失败：' : '' }}{{ metaError }}
      <button @click="retryMeta">重试</button>
    </div>
    <main id="main"><RouterView /></main>
  </div>
</template>
<style scoped>
.refresh-control {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
  white-space: nowrap;
}
.filterbar .auto-refresh {
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}
.auto-refresh input {
  width: 14px;
  height: 14px;
  min-height: 0;
  margin: 0;
  padding: 0;
  accent-color: var(--accent);
}
.refresh-countdown {
  min-width: 3ch;
  font-variant-numeric: tabular-nums;
}
</style>
