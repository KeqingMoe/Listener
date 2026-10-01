import {
  onActivated,
  onDeactivated,
  onMounted,
  onUnmounted,
  ref,
  watch,
  type Ref,
} from 'vue';
import { serverClock } from './serverClock';

/** Estimated server epoch milliseconds, for display only; never sends requests. */
export function useEstimatedTime(active: Ref<boolean>): Ref<number> {
  const now = ref(serverClock.now());
  let mounted = false;
  let deactivated = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  function stop() {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }
  function update() {
    now.value = serverClock.now();
  }
  function resume() {
    stop();
    if (!mounted || deactivated || document.hidden) {
      return;
    }
    update();
    // Re-read active after updating: it may itself depend on now.
    if (active.value) {
      timer = setInterval(update, 250);
    }
  }
  // Explicit source avoids tracking now; stopping must not write now again.
  watch(active, (enabled) => (enabled ? resume() : stop()));
  onMounted(() => {
    mounted = true;
    document.addEventListener('visibilitychange', resume);
    resume();
  });
  onActivated(() => {
    deactivated = false;
    resume();
  });
  onDeactivated(() => {
    deactivated = true;
    stop();
  });
  onUnmounted(() => {
    mounted = false;
    stop();
    document.removeEventListener('visibilitychange', resume);
  });
  return now;
}
