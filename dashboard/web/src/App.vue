<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { auth, authenticated, configured, configurationError } from './composables/useAuth';
import { get } from './api/client';
import { useRoute, useRouter } from "vue-router";
import type { MetaResponse } from "../../shared/contracts";
import {
  refreshVersion,
  useFilters,
  refresh,
  activeRequests,
} from "./composables/useDashboard";
const route = useRoute(),
  router = useRouter(),
  { groupId, range } = useFilters();
const password = ref(''), authError = ref(''), busy = ref(false);
async function submit(action: 'login' | 'logout') {
  busy.value = true;
  authError.value = '';
  try {
    await auth(action, action === 'login' ? { password: password.value } : undefined);
    password.value = '';
  } catch (error) {
    authError.value = error instanceof Error ? error.message : '操作失败，请重试。';
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
  auth().catch(error => {
    authError.value = error.message;
    authenticated.value = false;
  });
});
const meta = { data: ref<MetaResponse | null>(null), error: ref(''), retry: loadMeta };
let metaSequence = 0;
let metaController: AbortController | undefined;
async function loadMeta() {
  const sequence = ++metaSequence;
  metaController?.abort();
  meta.data.value = null;
  meta.error.value = '';
  if (!authenticated.value) return;
  const controller = new AbortController();
  metaController = controller;
  try {
    const result = await get<MetaResponse>('meta', controller.signal);
    if (sequence === metaSequence && authenticated.value) meta.data.value = result;
  } catch (error) {
    if (sequence === metaSequence && !controller.signal.aborted && authenticated.value)
      meta.error.value = error instanceof Error ? error.message : '加载失败，请重试。';
  }
}
watch([authenticated, refreshVersion], loadMeta, { immediate: true });
onUnmounted(() => {
  window.removeEventListener('dashboard:unauthorized', unauthorized);
  metaSequence++;
  metaController?.abort();
});
const auto = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;
watch(auto, (v) => {
  if (timer) clearInterval(timer);
  if (v)
    timer = setInterval(() => {
      if (authenticated.value && !document.hidden && activeRequests.value === 0) refresh();
    }, 30000);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
const customStart = ref("");
const customEnd = ref("");
const customError = ref("");
function localDate(value: unknown) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return "";
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
watch(
  () => [route.query.since, route.query.until, range.value],
  () => {
    customStart.value = localDate(route.query.since);
    customEnd.value = localDate(route.query.until);
    customError.value = "";
  },
  { immediate: true },
);
function applyCustom() {
  const since = new Date(customStart.value).getTime();
  const until = new Date(customEnd.value).getTime();
  if (
    !customStart.value ||
    !customEnd.value ||
    !Number.isSafeInteger(since) ||
    !Number.isSafeInteger(until) ||
    since < 0 ||
    until <= since
  ) {
    customError.value =
      "请选择有效的开始与结束时间，结束时间必须晚于开始时间。";
    return;
  }
  if (until - since > 31 * 86400000) {
    customError.value = "自定义时间范围不能超过31天。";
    return;
  }
  customError.value = "";
  router.push({
    path: route.path,
    query: {
      ...route.query,
      range: "custom",
      since: String(since),
      until: String(until),
    },
  });
}
function filter(key: string, event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  const query = { ...route.query, [key]: value || undefined };
  if (key === "range") {
    if (value === "custom") {
      const until = Math.floor(Date.now() / 60000) * 60000;
      query.since = String(until - 86400000);
      query.until = String(until);
    } else {
      delete query.since;
      delete query.until;
    }
  }
  router.push({ path: route.path, query });
}
const nav = [
  { path: "/", label: "总览", icon: "◫" },
  { path: "/wakes", label: "唤醒记录", icon: "≋" },
  { path: "/tools", label: "工具统计", icon: "⌘" },
];
</script>
<template>
  <div v-if="authenticated === null" class="auth-shell"><p>正在检查会话…</p></div>
  <div v-else-if="configured === false" class="auth-shell">
    <section class="card login-panel"><h1>拒绝访问</h1><p role="alert">{{ configurationError }}</p></section>
  </div>
  <div v-else-if="!authenticated" class="auth-shell">
    <form class="card login-panel" @submit.prevent="submit('login')">
      <h1>登录</h1>
      <label>密码<input v-model="password" type="password" autocomplete="current-password" required autofocus /></label>
      <p class="muted">在此浏览器保持登录7天</p>
      <p v-if="authError" class="notice" role="alert">{{ authError }}</p>
      <button class="button" type="submit" :disabled="busy">{{ busy ? '正在登录…' : '登录' }}</button>
    </form>
  </div>
  <div v-else class="shell">
    <a href="#main" class="skip-link">跳至主要内容</a>
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">L</span>
        <div>Listener<small>运行观察台</small></div>
      </div>
      <nav aria-label="主要导航">
        <RouterLink
          v-for="item in nav"
          :key="item.path"
          :to="{
            path: item.path,
            query: {
              group: groupId || undefined,
              range,
              ...(range === 'custom'
                ? { since: route.query.since, until: route.query.until }
                : {}),
            },
          }"
          :class="{
            active:
              item.path === '/'
                ? route.path === '/'
                : route.path.startsWith(item.path),
          }"
          ><span aria-hidden="true">{{ item.icon }}</span
          >{{ item.label }}</RouterLink
        >
      </nav>
      <div class="sidebar-foot">
        <span class="dot"></span>只读面板
        <p>观察运行，不干预群聊</p>
      </div>
    </aside>
    <div class="workspace">
      <header class="toolbar">
        <div class="filters">
          <label
            >群组<select
              aria-label="群组"
              :value="groupId"
              @change="filter('group', $event)"
            >
              <option value="">全部群组</option>
              <option
                v-if="
                  groupId &&
                  !meta.data.value?.groups.some((g) => g.groupId === groupId)
                "
                :value="groupId"
              >
                {{ groupId }}
              </option>
              <option
                v-for="g in meta.data.value?.groups"
                :key="g.groupId"
                :value="g.groupId"
              >
                {{ g.groupId }}
              </option>
            </select></label
          ><label
            >时间范围<select
              aria-label="时间范围"
              :value="range"
              @change="filter('range', $event)"
            >
              <option value="24h">最近24小时</option>
              <option value="7d">最近7天</option>
              <option value="custom">自定义时间</option>
            </select></label
          >
        </div>
        <div class="refresh-controls">
          <label class="check"
            ><input v-model="auto" type="checkbox" />每30秒刷新</label
          ><button class="button" @click="refresh">刷新数据</button>
          <button class="button" :disabled="busy" @click="submit('logout')">退出</button>
        </div>
      </header>
      <form
        v-if="range === 'custom'"
        class="custom-range"
        @submit.prevent="applyCustom"
        novalidate
      >
        <label
          >开始时间<input
            v-model="customStart"
            aria-label="开始时间"
            type="datetime-local"
            :aria-invalid="Boolean(customError)"
        /></label>
        <label
          >结束时间<input
            v-model="customEnd"
            aria-label="结束时间"
            type="datetime-local"
            :aria-invalid="Boolean(customError)"
        /></label>
        <button class="button" type="submit">应用时间范围</button>
        <span class="muted">本地时间 · 最多31天 · 刷新保留所选时间</span>
        <p v-if="customError" class="custom-error" role="alert">
          {{ customError }}
        </p>
      </form>
      <p v-if="authError" class="notice" role="alert">{{ authError }}</p>
      <div v-if="meta.error.value" class="notice" role="alert">
        群组信息加载失败。<button class="text-button" @click="meta.retry">
          重试
        </button>
      </div>
      <main id="main" tabindex="-1"><RouterView /></main>
      <footer>本地持久记录 · 未知字段不按零计入 · 不展示原始群消息正文</footer>
    </div>
  </div>
</template>
<style scoped>
.auth-shell { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
.login-panel { width: min(100%, 400px); display: grid; gap: 16px; }
.login-panel label { display: grid; gap: 8px; }
.login-panel input { width: 100%; padding: 10px; }
</style>
