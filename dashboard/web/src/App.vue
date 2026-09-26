<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { MetaResponse } from "../../shared/contracts";
import {
  useResource,
  useFilters,
  refresh,
  activeRequests,
} from "./composables/useDashboard";
const route = useRoute(),
  router = useRouter(),
  { groupId, range } = useFilters();
const meta = useResource<MetaResponse>(computed(() => "meta"));
const auto = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;
watch(auto, (v) => {
  if (timer) clearInterval(timer);
  if (v)
    timer = setInterval(() => {
      if (!document.hidden && activeRequests.value === 0) refresh();
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
  <a href="#main" class="skip-link">跳至主要内容</a>
  <div class="shell">
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
