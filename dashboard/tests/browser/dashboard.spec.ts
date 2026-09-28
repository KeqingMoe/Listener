import { test, expect, type Page } from "@playwright/test";
import type { UsageSummary, WakeItem } from "../../shared/contracts.js";
import { performanceMetrics } from '../../shared/metrics.js';
import { buildApp } from '../../server/app.js';
import { AuthStore } from '../../server/auth.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const now = Date.now();
const availability = {
  telemetry: true,
  sessions: [{ groupId: "10001", available: true }],
};
const usage: UsageSummary = {
  requests: 7,
  successes: 2,
  errors: 1,
  timeouts: 1,
  cancelled: 1,
  unknown: 2,
  inputTokens: 3000,
  outputTokens: 400,
  cachedInputTokens: 1500,
  uncachedInputTokens: 500,
  cacheHitRate: 0.75,
  running: 0,
  interrupted: 0,
  tps: null,
  performance: performanceMetrics([]),
  durationP50Ms: 120,
  durationP95Ms: 900,
};
const wake: WakeItem = {
  cacheHitRate: 0.75,
  tps: null,
  performance: performanceMetrics([], { attribution: 'wake' }),
  wakeId: "synthetic-wake",
  groupId: "10001",
  sessionId: "synthetic-session",
  startedAt: now - 10000,
  finishedAt: now - 9000,
  durationMs: 1000,
  outcome: "message_submitted",
  reasonCode: "message_submitted",
  diagnostics: { sent_submissions: 1, tool_calls: 9 },
  trigger: null,
  modelRequests: 5,
  toolCalls: 9,
  inputTokens: 3000,
  outputTokens: 400,
};
async function mock(
  page: Page,
  options: { fail?: boolean; empty?: boolean } = {},
) {
  const requests: string[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === '/api/auth/session')
      return route.fulfill({ json: { authenticated: true, configured: true } });
    requests.push(url.toString());
    if (options.fail && url.pathname === "/api/overview")
      return route.fulfill({
        status: 503,
        json: { error: "unavailable", message: "合成测试故障" },
      });
    let body: unknown;
    if (url.pathname === "/api/meta")
      body = {
        groups: [{ groupId: "10001" }],
        readOnly: true,
        maxRangeDays: 31,
        now,
        availability,
      };
    else if (url.pathname === "/api/overview")
      body = {
        range: { since: now - 86400000, until: now },
        availability,
        summary: usage,
        series: [{ ...usage, bucketStart: now - 3600000 }],
        groups: [{ ...usage, groupId: "10001" }],
      };
    else if (url.pathname === "/api/wakes")
      body = {
        range: { since: 0, until: now },
        availability,
        items: options.empty ? [] : [wake],
        nextCursor:
          options.empty || url.searchParams.has("cursor")
            ? null
            : "synthetic-next",
      };
    else if (url.pathname === "/api/tools")
      body = {
        range: { since: 0, until: now },
        availability,
        items: [
          {
            name: "read_events",
            calls: 9,
            finished: 6,
            pending: 1,
            started: 1,
            handled: 1,
            unknown: 1,
            skipped: 1,
            errors: 1,
            rejected: 1,
            deferred: 1,
            cancelled: 1,
            durationP50Ms: 20,
            durationP95Ms: 40,
          },
        ],
      };
    else
      body = {
        wake: {
          ...wake,
          diagnostics: { ...wake.diagnostics, error: "PRIVATE_WAKE_ERROR", prompt: "PRIVATE_WAKE_PROMPT" },
          messages: "PRIVATE_CHAT_BODY",
        },
        requests: ["success", "failed", "timeout", "cancelled", "unknown"].map((outcome, index) => ({
          requestId: index === 0 ? "synthetic-request" : `synthetic-${outcome}`,
          startedAt: now - 10000 + index,
          endedAt: now - 9500 + index,
          durationMs: 500,
          status: outcome === "failed" ? "error" : outcome,
          outcome,
          errorCode: outcome === "failed" ? "rate_limit_exceeded" : null,
          httpStatus: outcome === "failed" ? 429 : null,
          diagnostics: outcome === "failed" ? {
            abortSource: { message: "PRIVATE_MALFORMED_FIELD" },
            providerCategory: "rate_limit_error",
            providerParameter: "max_output_tokens",
            requestMode: "stream",
            requestTimeoutMs: 12000,
            error: "PRIVATE_PROVIDER_ERROR",
            prompt: "PRIVATE_REQUEST_PROMPT",
            nested: { message: "PRIVATE_NESTED_DIAGNOSTIC" },
          } : null,
          error: "PRIVATE_RAW_ERROR",
          transport: "responses",
          inputTokens: 3000,
          outputTokens: 400,
          cachedInputTokens: 1500,
        })),
        tools: ["handled", "failed", "rejected", "deferred", "cancelled", "unknown", "skipped", "pending", "started"].map((outcome, index) => ({
          ordinal: index + 1,
          name: index === 0 ? "read_events" : `synthetic_tool_${outcome}`,
          state: ["pending", "started", "skipped"].includes(outcome) ? outcome : "finished",
          outcome,
          reasonCode: outcome === "rejected" ? "policy_rejected" : null,
          proposedAt: now - 9400 + index,
          startedAt: now - 9399 + index,
          finishedAt: now - 9300 + index,
          durationMs: 99,
          status: outcome === "handled" ? "message_submitted" : outcome,
          arguments: "PRIVATE_TOOL_ARGUMENTS",
          result: "PRIVATE_TOOL_RESULT",
        })),
        truncated: false,
        availability,
      };
    return route.fulfill({ json: body });
  });
  return requests;
}
// Exercise real Fastify authentication with synthetic private storage, without a network API server.
async function withAuthBackend(page: Page, password: string | undefined, run: (business: string[]) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'dashboard-browser-auth-'));
  const authStore = new AuthStore({ path: join(dir, 'auth.sqlite'), password });
  const app = buildApp({ auth: authStore, telemetryPath: join(dir, 'missing.sqlite'), groups: [] });
  const business: string[] = [];
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (!url.pathname.startsWith('/api/auth/')) business.push(url.pathname);
    const headers = await request.allHeaders();
    headers.host = url.host;
    const result = await app.inject({
      method: request.method() as 'GET' | 'POST', url: url.pathname + url.search,
      headers, ...(request.postData() !== null ? { payload: request.postData()! } : {}),
    });
    const responseHeaders: Record<string, string> = { 'content-type': 'application/json' };
    const cookie = result.headers['set-cookie'];
    if (typeof cookie === 'string') responseHeaders['set-cookie'] = cookie;
    await route.fulfill({ status: result.statusCode, headers: responseHeaders, body: result.body });
  });
  try { await run(business); }
  finally {
    await page.unrouteAll({ behavior: 'wait' });
    await app.close();
    authStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('真实密码登录、刷新恢复、退出与过期门禁', async ({ page }) => {
  await withAuthBackend(page, 'synthetic-browser-password', async business => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    expect(business).toEqual([]);
    await expect(page.locator('main')).toHaveCount(0);
    await page.getByLabel('密码', { exact: true }).fill('wrong-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('密码不正确');
    await page.getByLabel('密码', { exact: true }).fill('synthetic-browser-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '总览', exact: true })).toBeVisible();
    await expect.poll(() => business.includes('/api/meta')).toBe(true);
    const cookies = await page.context().cookies();
    expect(cookies.some(cookie => cookie.httpOnly && cookie.sameSite === 'Strict')).toBe(true);
    await page.reload();
    await expect(page.getByRole('heading', { name: '总览', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '退出', exact: true }).click();
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    await expect(page.locator('main')).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    await page.getByLabel('密码', { exact: true }).fill('synthetic-browser-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '总览', exact: true })).toBeVisible();
    await page.context().clearCookies();
    await page.getByRole('button', { name: '刷新数据' }).click();
    await expect(page.getByRole('heading', { name: '登录', exact: true })).toBeVisible();
    await expect(page.locator('main')).toHaveCount(0);
  });
});
for (const password of [undefined, 'short']) {
  test(`密码${password === undefined ? '未配置' : '配置无效'}时拒绝访问`, async ({ page }) => {
    await withAuthBackend(page, password, async business => {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: '拒绝访问' })).toBeVisible();
      await expect(page.getByRole('alert')).toContainText('DASHBOARD_PASSWORD');
      await expect(page.getByLabel('密码', { exact: true })).toHaveCount(0);
      await expect(page.locator('main')).toHaveCount(0);
      expect(business).toEqual([]);
    });
  });
}

test("总览、筛选和刷新可用，不产生浏览器错误", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const requests = await mock(page);
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "总览", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("strong").filter({ hasText: "75.0%" }),
  ).toBeVisible();
  await page.getByLabel("群组", { exact: true }).selectOption("10001");
  await expect(page).toHaveURL(/group=10001/);
  await page.getByLabel("时间范围").selectOption("7d");
  await expect(page).toHaveURL(/range=7d/);
  await expect
    .poll(() => requests.some((url) => url.includes("groupId=10001")))
    .toBe(true);
  const count = requests.length;
  await page.getByRole("button", { name: "刷新数据" }).click();
  await expect.poll(() => requests.length).toBeGreaterThan(count);
  expect(errors).toEqual([]);
  await expect(page.locator('main [aria-busy="true"]')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('overview-synthetic.png'), fullPage: true });
});
test("唤醒分页与安全元数据详情", async ({ page }) => {
  const requests = await mock(page);
  await page.goto("/wakes");
  await page.getByRole("button", { name: "下一页" }).click();
  await expect
    .poll(() => requests.some((url) => url.includes("cursor=synthetic-next")))
    .toBe(true);
  await page.getByRole("link", { name: "查看唤醒 synthetic-wake" }).click();
  await expect(page).toHaveURL(/wakes\/10001\/synthetic-wake/);
  await expect(page.getByText("read_events", { exact: true })).toBeVisible();
  await expect(
    page.getByText("synthetic-request", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "工具统计" }).click();
  await expect(
    page.getByRole("heading", { name: "工具统计", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("read_events", { exact: true })).toBeVisible();
});
test("模型结果分类分开统计且不将超时取消视为失败", async ({ page }) => {
  await mock(page);
  await page.goto("/");
  await expect(page.getByText("成功 2 · 失败 1 · 超时 1 · 已取消 1 · 结果不明 2", { exact: true })).toBeVisible();
});
test("诊断仅展示安全字段并保留原始状态和提交语义", async ({ page }) => {
  await mock(page);
  await page.goto("/wakes/10001/synthetic-wake");
  const events = page.locator(".timeline > li");
  await expect(events).toHaveCount(14);
  for (const [id, label] of [["request", "成功"], ["failed", "失败"], ["timeout", "超时"], ["cancelled", "已取消"], ["unknown", "结果不明"]]) {
    await expect(events.filter({ has: page.getByText(`synthetic-${id}`, { exact: true }) })).toContainText(label);
  }
  const failed = events.filter({ has: page.getByText("synthetic-failed", { exact: true }) });
  for (const value of ["error", "rate_limit_exceeded", "429", "rate_limit_error", "max_output_tokens", "stream", "12,000"]) {
    await expect(failed.getByText(value, { exact: true })).toBeVisible();
  }
  for (const [outcome, label] of [["failed", "失败"], ["rejected", "已拒绝"], ["deferred", "已延后"], ["cancelled", "已取消"], ["unknown", "结果不明"], ["skipped", "已跳过"], ["pending", "待执行"], ["started", "执行中"]]) {
    await expect(events.filter({ has: page.getByText(`synthetic_tool_${outcome}`, { exact: true }) })).toContainText(label);
  }
  const handled = events.filter({ has: page.getByText("read_events", { exact: true }) });
  await expect(handled).toContainText("已处理");
  await expect(handled).toContainText("message_submitted");
  await expect(page.getByText("policy_rejected", { exact: true })).toBeVisible();
  await expect(page.getByText("sent_submissions", { exact: true })).toBeVisible();
  await expect(page.locator("main")).toContainText("已提交不等于 QQ 已送达");
  await expect(page.locator("main")).toContainText("不等于操作成功");
  await expect(page.locator("body")).not.toContainText("PRIVATE_");
});
test("工具结果分列且完成数不代表成功数", async ({ page }) => {
  await mock(page);
  await page.goto("/tools");
  const headers = ["工具", "调用", "已完成", "已处理", "失败", "已拒绝", "已延后", "已取消", "结果不明", "已跳过", "待执行", "执行中", "耗时 P50", "耗时 P95"];
  await expect(page.locator("thead th")).toHaveText(headers);
  await expect(page.locator("tbody tr").first().locator("td")).toHaveText(["read_events", "9", "6", "1", "1", "1", "1", "1", "1", "1", "1", "1", "20 ms", "40 ms"]);
  await expect(page.locator("main")).toContainText("不等于操作成功");
  await expect(page.locator("main")).toContainText("失败仅统计 failed");
  await expect(page.locator("main")).toContainText("已提交不等于 QQ 已送达");
});
test("失败可重试且空数据不伪造记录", async ({ page }) => {
  const state = { fail: true, empty: true };
  await mock(page, state);
  await page.goto("/");
  await expect(page.getByRole("alert")).toBeVisible();
  state.fail = false;
  await page.getByRole("button", { name: "重新加载", exact: true }).click();
  await expect(
    page.getByRole("strong").filter({ hasText: "75.0%" }),
  ).toBeVisible();
  await page.goto("/wakes");
  await expect(page.getByRole("button", { name: "下一页" })).toBeDisabled();
  await expect(
    page.getByRole("link", { name: "查看唤醒 synthetic-wake" }),
  ).toHaveCount(0);
});
test("自定义时间保持URL与刷新范围并拒绝超长区间", async ({ page }) => {
  const requests = await mock(page);
  await page.goto('/');
  await page.getByLabel('时间范围', { exact: true }).selectOption('custom');
  await page.getByLabel('开始时间', { exact: true }).fill('2026-09-20T10:00');
  await page.getByLabel('结束时间', { exact: true }).fill('2026-09-21T10:00');
  await page.getByRole('button', { name: '应用时间范围' }).click();
  await expect(page).toHaveURL(/range=custom/);
  const url = new URL(page.url());
  expect(url.searchParams.get('since')).toBeTruthy();
  const until = url.searchParams.get('until');
  await page.getByRole('button', { name: '刷新数据' }).click();
  await expect.poll(() => requests.some(value => new URL(value).searchParams.get('until') === until)).toBe(true);
  await page.getByRole('link', { name: '工具统计' }).click();
  await expect(page).toHaveURL(/\/tools\?/);
  await expect(page.getByRole('heading', { name: '工具统计', exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('until')).toBe(until);
  await page.getByLabel('结束时间', { exact: true }).fill('2026-11-21T10:00');
  await expect(page.getByLabel('结束时间', { exact: true })).toHaveValue('2026-11-21T10:00');
  await page.getByRole('button', { name: '应用时间范围' }).click();
  await expect(page.getByRole('alert')).toContainText('31天');
  expect(new URL(page.url()).searchParams.get('until')).toBe(until);
});
test("手机宽度可使用导航与筛选", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mock(page);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "唤醒记录" })).toBeVisible();
  await expect(page.getByLabel("群组", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "唤醒记录" }).click();
  await expect(
    page.getByRole("heading", { name: "唤醒记录", exact: true }),
  ).toBeVisible();
});
