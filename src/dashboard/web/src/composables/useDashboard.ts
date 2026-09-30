import { computed, onUnmounted, ref, shallowRef, watch, type Ref } from 'vue';
import { authenticated, authVersion } from './useAuth';
import { applyResourceSync } from './resourceSyncState';
import { useRoute } from 'vue-router';
import { ApiError, get } from '../api/client';
import type { ResourceSyncResponse } from '../../../contracts/resource-sync';

export const refreshFailures = ref(0);
export const refreshVersion = ref(0);
export const activeRequests = ref(0);
export const rangeEnd = ref(Date.now());

export function refresh() {
  if (activeRequests.value || authenticated.value !== true) {
    return;
  }
  rangeEnd.value = Date.now();
  refreshVersion.value++;
}

export function useFilters() {
  const route = useRoute();
  const groupId = computed(() =>
    typeof route.query.group === 'string' ? route.query.group : '',
  );
  const range = computed(() => {
    const value = route.query.range;
    return value === 'custom' ||
      value === '5m' ||
      value === '15m' ||
      value === '1h' ||
      value === '3h' ||
      value === '6h' ||
      value === '3d' ||
      value === '30d' ||
      value === '7d' ||
      value === '24h'
      ? value
      : '24h';
  });
  const query = computed(() => {
    const p = new URLSearchParams(
      range.value === 'custom'
        ? {
            since:
              typeof route.query.since === 'string' ? route.query.since : '',
            until:
              typeof route.query.until === 'string' ? route.query.until : '',
          }
        : {
            since: String(
              rangeEnd.value -
                ({
                  '5m': 5 * 60000,
                  '15m': 15 * 60000,
                  '1h': 3600000,
                  '3h': 3 * 3600000,
                  '6h': 6 * 3600000,
                  '24h': 86400000,
                  '3d': 3 * 86400000,
                  '7d': 7 * 86400000,
                  '30d': 30 * 86400000,
                }[range.value] ?? 86400000),
            ),
            until: String(rangeEnd.value),
          },
    );
    if (groupId.value) {
      p.set('groupId', groupId.value);
    }
    return p.toString();
  });
  const identity = computed(() =>
    JSON.stringify([
      groupId.value,
      range.value,
      range.value === 'custom' ? route.query.since : null,
      range.value === 'custom' ? route.query.until : null,
    ]),
  );
  return { groupId, range, query, identity };
}

export function useResource<T>(
  path: Ref<string>,
  identity: Ref<string> = path,
) {
  const data = shallowRef<T | null>(null),
    pending = ref(false),
    error = ref('');
  const loading = computed(() => pending.value && data.value === null);
  const refreshing = computed(() => pending.value && data.value !== null);
  let controller: AbortController | undefined,
    cursor = '',
    sequence = 0,
    disposed = false;
  function clear() {
    sequence++;
    controller?.abort();
    controller = undefined;
    data.value = null;
    cursor = '';
    pending.value = false;
    error.value = '';
  }
  async function load() {
    if (disposed || authenticated.value !== true || pending.value) {
      return;
    }
    const current = ++sequence;
    const request = new AbortController();
    controller = request;
    pending.value = true;
    error.value = '';
    activeRequests.value++;
    try {
      const params = new URLSearchParams({ resource: `/api/${path.value}` });
      if (cursor) {
        params.set('cursor', cursor);
      }
      const response = await get<ResourceSyncResponse<T>>(
        `resource-sync?${params}`,
        request.signal,
      );
      if (
        current === sequence &&
        !request.signal.aborted &&
        authenticated.value === true
      ) {
        data.value = applyResourceSync(data.value, response);
        cursor = response.cursor;
      }
    } catch (e) {
      if (current === sequence && !request.signal.aborted) {
        if (e instanceof ApiError && [400, 401, 403, 404].includes(e.status)) {
          data.value = null;
          cursor = '';
        }
        error.value = e instanceof Error ? e.message : '网络请求失败，请重试。';
        refreshFailures.value++;
      }
    } finally {
      activeRequests.value--;
      if (current === sequence) {
        pending.value = false;
        controller = undefined;
      }
    }
  }
  watch(
    [identity, authenticated, authVersion],
    () => {
      clear();
      void load();
    },
    { immediate: true, flush: 'sync' },
  );
  watch([path, refreshVersion], () => {
    void load();
  });
  onUnmounted(() => {
    disposed = true;
    clear();
  });
  return { data, loading, refreshing, error, retry: load };
}
