import { ref } from 'vue';
export const authenticated = ref<boolean | null>(null);
// Invalidate private caches even when a successful login replaces a live session.
export const authVersion = ref(0);
export const configured = ref<boolean | null>(null);
export const configurationError = ref('');
export function rejectConfiguration(error: string) {
  configured.value = false;
  authenticated.value = false;
  configurationError.value = error === 'password_invalid_configuration'
    ? '拒绝访问：请在 .env 设置有效的 DASHBOARD_PASSWORD（至少12字符、不超过256字节、不能包含控制字符）并重启面板。'
    : '拒绝访问：请在.env设置DASHBOARD_PASSWORD并重启面板';
}
export async function auth(action: 'session' | 'login' | 'logout' = 'session', body?: unknown) {
  const response = await fetch(`/api/auth/${action}`, { method: action === 'session' ? 'GET' : 'POST', credentials: 'same-origin', headers: action === 'session' ? { Accept: 'application/json' } : { 'Content-Type': 'application/json' }, ...(action === 'session' ? {} : { body: JSON.stringify(body ?? {}) }) });
  const result = await response.json();
  if (typeof result.configured === 'boolean') configured.value = result.configured;
  if (result.error === 'password_not_configured' || result.error === 'password_invalid_configuration' || configured.value === false) {
    rejectConfiguration(result.error);
    return result;
  }
  if (!response.ok) {
    if (response.status === 401 && action !== 'login') authenticated.value = false;
    throw new Error(response.status === 429 ? '尝试太频繁，请一分钟后再试。' : response.status === 401 ? '密码不正确或会话已过期。' : '操作失败，请重试。');
  }
  configurationError.value = '';
  authenticated.value = result.authenticated === true;
  if (action === 'login' || action === 'logout') authVersion.value++;
  return result;
}
