import { computed, onUnmounted, ref, shallowRef, watch, type Ref } from 'vue';
import { useRoute } from 'vue-router';
import type { WakeEffectTrendsResponse } from '../../../contracts/wake-effect-trends';
import { ApiError, get } from '../api/client';
import { authenticated, authVersion, configured } from './useAuth';
import {
  activeRequests,
  refreshFailures,
  refreshVersion,
  useFilters,
} from './useDashboard';

/** Bounded, unsampled snapshots; scheduling belongs to the global refresh loop. */
export function useWakeEffectTrends(enabled: Ref<boolean>) {
  const { query, identity } = useFilters();
  const route = useRoute();
  const active = computed(() => enabled.value && route.path === '/');
  const data = shallowRef<WakeEffectTrendsResponse | null>(null);
  const loading = ref(false),
    error = ref(''),
    updatedAt = ref<number | null>(null);
  let boundIdentity = identity.value;
  let sequence = 0,
    disposed = false,
    forbidden = false;
  let controller: AbortController | undefined;
  function suspend() {
    sequence++;
    controller?.abort();
    controller = undefined;
    loading.value = false;
  }
  function clear() {
    suspend();
    boundIdentity = identity.value;
    data.value = null;
    updatedAt.value = null;
    error.value = '';
  }
  async function load() {
    if (disposed || !active.value || authenticated.value !== true) {
      return;
    }
    if (boundIdentity !== identity.value) {
      clear();
      forbidden = false;
    }
    if (forbidden || loading.value) {
      return;
    }
    const current = ++sequence;
    const request = new AbortController();
    controller = request;
    loading.value = true;
    error.value = '';
    activeRequests.value++;
    try {
      const response = await get<WakeEffectTrendsResponse>(
        `wake-effect-trends?${query.value}`,
        request.signal,
      );
      if (
        current !== sequence ||
        request.signal.aborted ||
        authenticated.value !== true
      ) {
        return;
      }
      if (!Array.isArray(response.points) || response.points.length > 10000) {
        throw new Error(
          '唤醒趋势超过10000条上限或响应无效，请缩小时间范围；不会采样。',
        );
      }
      data.value = response;
      updatedAt.value = Date.now();
    } catch (e) {
      if (current !== sequence || request.signal.aborted) {
        return;
      }
      refreshFailures.value++;
      if (
        (e instanceof ApiError && [400, 401, 403].includes(e.status)) ||
        configured.value === false
      ) {
        clear();
        forbidden = true;
        error.value = e instanceof Error ? e.message : '访问未获授权。';
        return;
      }
      error.value = e instanceof Error ? e.message : '网络请求失败，请重试。';
    } finally {
      activeRequests.value--;
      if (current === sequence) {
        loading.value = false;
        controller = undefined;
      }
    }
  }
  function reset() {
    clear();
    forbidden = false;
    void load();
  }
  watch(
    [identity, active],
    () => {
      if (!active.value) {
        suspend();
        return;
      }
      void load();
    },
    { immediate: true, flush: 'sync' },
  );
  watch(refreshVersion, () => {
    void load();
  });
  watch([authenticated, authVersion], reset, { flush: 'sync' });
  onUnmounted(() => {
    disposed = true;
    clear();
  });
  return {
    data,
    loading,
    error,
    updatedAt,
    retry: () => {
      forbidden = false;
      void load();
    },
  };
}
