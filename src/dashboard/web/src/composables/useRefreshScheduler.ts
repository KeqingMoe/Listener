import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { authenticated } from './useAuth';
import { activeRequests, refresh, refreshFailures } from './useDashboard';

export const autoRefresh = ref(true);
export const pageVisible = ref(true);
export const refreshBackoff = ref(false);

/**
 * 自动刷新调度：仅在已登录、开启自动刷新且页面可见时计时，有请求在途时暂停。
 * 一轮刷新中有失败则间隔从5s起指数退避，最多60s；页面重新可见或重新启用时立即刷新一次。
 */
export function useRefreshScheduler() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  const countdown = ref(0);
  let failures = 0,
    cycleFailed = false,
    resumePending = false;
  const enabled = computed(
    () =>
      authenticated.value === true && autoRefresh.value && pageVisible.value,
  );
  const cancel = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (ticker !== undefined) {
      clearInterval(ticker);
    }
    timer = undefined;
    ticker = undefined;
    countdown.value = 0;
  };
  function schedule() {
    cancel();
    if (!enabled.value || activeRequests.value) {
      return;
    }
    if (resumePending) {
      resumePending = false;
      refresh();
      return;
    }
    refreshBackoff.value = failures > 0;
    const delay = Math.min(60000, 5000 * 2 ** failures);
    const deadline = Date.now() + delay;
    countdown.value = Math.ceil(delay / 1000);
    ticker = setInterval(() => {
      countdown.value = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    }, 100);
    timer = setTimeout(() => {
      cancel();
      refresh();
    }, delay);
  }
  watch(refreshFailures, () => {
    cycleFailed = true;
  });
  watch(activeRequests, (count, previous) => {
    if (count) {
      cancel();
      return;
    }
    if (previous) {
      failures = cycleFailed ? Math.min(failures + 1, 4) : 0;
      cycleFailed = false;
    }
    schedule();
  });
  watch(enabled, (value, previous) => {
    cancel();
    if (value) {
      resumePending = previous === false;
      schedule();
    }
  });
  function visibility() {
    pageVisible.value = !document.hidden;
  }
  onMounted(() => {
    visibility();
    document.addEventListener('visibilitychange', visibility);
    schedule();
  });
  onUnmounted(() => {
    cancel();
    document.removeEventListener('visibilitychange', visibility);
  });
  return { autoRefresh, pageVisible, refreshBackoff, countdown };
}
