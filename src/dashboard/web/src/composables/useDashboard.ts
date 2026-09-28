import { computed, onUnmounted, ref, watch, type Ref } from "vue";
import { useRoute } from "vue-router";
import { get } from "../api/client";
export const refreshVersion = ref(0);
export const activeRequests = ref(0);
export const rangeEnd = ref(Date.now());
export function refresh() {
  rangeEnd.value = Date.now();
  refreshVersion.value++;
}
export function useFilters() {
  const route = useRoute();
  const groupId = computed(() =>
    typeof route.query.group === "string" ? route.query.group : "",
  );
  const range = computed(() => {
    const value = route.query.range;
    return value === "custom" || value === "5m" || value === "15m" || value === "1h" || value === "3h" || value === "6h" || value === "3d" || value === "30d" || value === "7d" || value === "24h"
      ? value
      : "24h";
  });
  const query = computed(() => {
    const p = new URLSearchParams(
      range.value === "custom"
        ? {
            since:
              typeof route.query.since === "string" ? route.query.since : "",
            until:
              typeof route.query.until === "string" ? route.query.until : "",
          }
        : {
            since: String(rangeEnd.value - ({"5m": 5 * 60000, "15m": 15 * 60000, "1h": 3600000, "3h": 3 * 3600000, "6h": 6 * 3600000, "24h": 86400000, "3d": 3 * 86400000, "7d": 7 * 86400000, "30d": 30 * 86400000}[range.value] ?? 86400000)),
            until: String(rangeEnd.value),
          },
    );
    if (groupId.value) p.set("groupId", groupId.value);
    return p.toString();
  });
  return { groupId, range, query };
}
export function useResource<T>(path: Ref<string>) {
  const data = ref<T | null>(null) as Ref<T | null>,
    loading = ref(false),
    error = ref("");
  let controller: AbortController | undefined;
  let sequence = 0;
  async function load() {
    const current = ++sequence;
    controller?.abort();
    controller = new AbortController();
    loading.value = true;
    error.value = "";
    data.value = null;
    activeRequests.value++;
    try {
      const result = await get<T>(path.value, controller.signal);
      if (current === sequence) data.value = result;
    } catch (e) {
      if (current === sequence && !controller.signal.aborted)
        error.value = e instanceof Error ? e.message : "网络请求失败，请重试。";
    } finally {
      activeRequests.value--;
      if (current === sequence) loading.value = false;
    }
  }
  watch([path, refreshVersion], load, { immediate: true });
  onUnmounted(() => {
    sequence++;
    controller?.abort();
  });
  return { data, loading, error, retry: load };
}
