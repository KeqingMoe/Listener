import { test, expect, type Page } from "@playwright/test";
import type { UsageSummary, WakeItem } from "../../shared/contracts.js";
const now = Date.now();
const availability = {
  telemetry: true,
  sessions: [{ groupId: "10001", available: true }],
};
const usage: UsageSummary = {
  requests: 3,
  successes: 2,
  errors: 1,
  inputTokens: 3000,
  outputTokens: 400,
  cachedInputTokens: 1500,
  uncachedInputTokens: 500,
  cacheHitRate: 0.75,
  cacheCoverage: 2 / 3,
  knownInputRequests: 3,
  knownCacheRequests: 2,
  durationP50Ms: 120,
  durationP95Ms: 900,
};
const wake: WakeItem = {
  wakeId: "synthetic-wake",
  groupId: "10001",
  sessionId: "synthetic-session",
  startedAt: now - 10000,
  finishedAt: now - 9000,
  durationMs: 1000,
  outcome: "completed",
  trigger: null,
  modelRequests: 1,
  toolCalls: 1,
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
            calls: 2,
            finished: 1,
            pending: 0,
            started: 0,
            unknown: 1,
            skipped: 0,
            errors: 0,
            durationP50Ms: 20,
            durationP95Ms: 40,
          },
        ],
      };
    else
      body = {
        wake,
        requests: [
          {
            requestId: "synthetic-request",
            startedAt: now - 10000,
            endedAt: now - 9500,
            durationMs: 500,
            status: "success",
            transport: "responses",
            inputTokens: 3000,
            outputTokens: 400,
            cachedInputTokens: 1500,
          },
        ],
        tools: [
          {
            ordinal: 1,
            name: "read_events",
            state: "finished",
            proposedAt: now - 9400,
            startedAt: now - 9399,
            finishedAt: now - 9300,
            durationMs: 99,
            status: "ok",
          },
        ],
        truncated: false,
        availability,
      };
    return route.fulfill({ json: body });
  });
  return requests;
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
  expect(new URL(page.url()).searchParams.get('until')).toBe(until);
  await page.getByLabel('结束时间', { exact: true }).fill('2026-11-21T10:00');
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
