import { onUnmounted, ref, shallowRef, watch } from 'vue';
import type { RequestTrendSyncPoint, RequestTrendsResponse, RequestTrendsSyncResponse } from '../../../contracts/request-trends';
import { ApiError, get } from '../api/client';
import { authenticated, authVersion, configured } from './useAuth';
import { activeRequests, refreshFailures, refreshVersion, useFilters } from './useDashboard';
import { applyTrendSync } from './requestTrendsState';

/** Cursors are private to the mounted resource; scheduling belongs to App. */
export function useRequestTrends() {
  const { query, identity } = useFilters();
  const data = shallowRef<RequestTrendsResponse | null>(null);
  const loading = ref(false), error = ref(''), updatedAt = ref<number | null>(null);
  let points = new Map<string, RequestTrendSyncPoint>();
  let cursor = '', sequence = 0, disposed = false, forbidden = false;
  let controller: AbortController | undefined;
  function clear() {
    sequence++; controller?.abort(); controller = undefined;
    points.clear(); cursor = ''; data.value = null; updatedAt.value = null;
    error.value = ''; loading.value = false;
  }
  async function sync() {
    if (disposed || forbidden || authenticated.value !== true || loading.value) return;
    const current = ++sequence;
    const request = new AbortController(); controller = request;
    loading.value = true; error.value = ''; activeRequests.value++;
    const params = new URLSearchParams(query.value);
    if (cursor) params.set('cursor', cursor);
    try {
      const response = await get<RequestTrendsSyncResponse>(`request-trends/sync?${params}`, request.signal);
      if (current !== sequence || request.signal.aborted || authenticated.value !== true) return;
      const next = applyTrendSync(points, response);
      points = next.points; cursor = next.cursor; data.value = next.data;
      updatedAt.value = Date.now();
    } catch (e) {
      if (current !== sequence || request.signal.aborted) return;
      refreshFailures.value++;
      if ((e instanceof ApiError && [400, 401, 403].includes(e.status)) || configured.value === false) {
        clear(); forbidden = true;
        error.value = e instanceof Error ? e.message : '访问未获授权。';
        return;
      }
      error.value = e instanceof Error ? e.message : '网络请求失败，请重试。';
    } finally {
      activeRequests.value--;
      if (current === sequence) { loading.value = false; controller = undefined; }
    }
  }
  function reset() { clear(); forbidden = false; void sync(); }
  watch(identity, reset, { immediate: true });
  watch(refreshVersion, () => { void sync(); });
  watch([authenticated, authVersion], reset, { flush: 'sync' });
  onUnmounted(() => { disposed = true; clear(); });
  return { data, loading, error, updatedAt, retry: () => { forbidden = false; void sync(); } };
}
