import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
  OverviewResponse,
  ToolsResponse,
  UsageSummary,
  WakeItem,
  WakesResponse,
} from '../../src/dashboard/contracts/contracts.ts';
import type {
  HealthResponse,
  ReviewEventsResponse,
  ReviewRequest,
  ReviewRequestsResponse,
  ReviewTool,
  RequestReviewDetail,
  WakeReviewDetail,
} from '../../src/dashboard/contracts/review.ts';

import type { PerformanceMetrics } from '../../src/dashboard/contracts/metrics.ts';
import { buildRequestTrends } from '../../src/dashboard/server/request-trends.ts';

// 全部为合成数据：截图和剪贴板测试从不使用生产日志。
function performance(
  attribution: PerformanceMetrics['attribution'],
): PerformanceMetrics {
  const single = attribution === 'request';
  return {
    wallDurationMs: single ? 2000 : attribution === 'wake' ? 9000 : null,
    modelDurationMs: single ? 2000 : 6000,
    modelWallDurationMs: single ? 2000 : attribution === 'wake' ? 6000 : null,
    toolDurationMs: single ? null : 200,
    toolWallDurationMs: attribution === 'wake' ? 200 : null,
    otherDurationMs: attribution === 'wake' ? 3000 : null,
    tps: 40,
    ttftMs: 500,
    decodeDurationMs: single ? 2000 : 4000,
    decodeOutputTokens: single ? 80 : 160,
    whyIncomplete: attribution === 'wake' ? null : 'not_wake',
    coverage: {
      requests: single ? 1 : 3,
      endedRequests: single ? 1 : 3,
      modelDurationRequests: single ? 1 : 3,
      modelIntervalRequests: single ? 1 : 3,
      tpsRequests: single ? 1 : 2,
      ttftRequests: single ? 1 : 2,
      tools: single ? 0 : 1,
      toolDurationTools: single ? 0 : 1,
    },
    attribution,
    complete: attribution === 'wake',
  };
}

const now = Date.UTC(2026, 8, 21, 10);
const range = { since: now - 86400000, until: now };
const availability = {
  telemetry: true,
  sessions: [{ groupId: '10001', available: true }],
};
const usage: UsageSummary = {
  performance: performance('aggregate'),
  tps: 40,
  ttftMs: 500,
  requests: 3,
  successes: 2,
  errors: 1,
  timeouts: 0,
  cancelled: 0,
  running: 0,
  interrupted: 0,
  unknown: 0,
  inputTokens: 1200,
  uncachedInputTokens: 400,
  cachedInputTokens: 800,
  outputTokens: 160,
  cacheHitRate: 0.6667,
  durationP50Ms: 2000,
  durationP95Ms: 2000,
};
const overview: OverviewResponse = {
  range,
  availability,
  summary: usage,
  series: [],
  groups: [{ ...usage, groupId: '10001' }],
  models: [{ ...usage, modelName: 'synthetic' }],
};
const request: ReviewRequest = {
  performance: performance('request'),
  cacheHitRate: 0.6667,
  requestId: 'req-synthetic-2',
  groupId: '10001',
  wakeId: 'wake-synthetic',
  turnId: 'turn-synthetic',
  model: 'synthetic-model',
  modelName: 'synthetic',
  transport: 'responses',
  startedAt: now - 6000,
  endedAt: now - 4000,
  durationMs: 2000,
  status: 'success',
  outcome: 'success',
  errorCode: null,
  httpStatus: null,
  inputTokens: 200,
  totalInputTokens: 600,
  cachedInputTokens: 400,
  outputTokens: 80,
  reasoningTokens: 30,
  tps: 40,
  ttftMs: 500,
  decodeDurationMs: 2000,
  responseId: 'resp-synthetic-2',
  previousResponseId: 'resp-synthetic-1',
  providerRequestId: 'provider-synthetic-2',
  requestMode: 'fresh',
  hasInspection: true,
};
const previous: ReviewRequest = {
  ...request,
  transport: 'chat',
  requestId: 'req-synthetic-1',
  responseId: 'resp-synthetic-1',
  previousResponseId: null,
  startedAt: now - 9000,
  endedAt: now - 7000,
};
const failed: ReviewRequest = {
  ...request,
  performance: {
    ...performance('request'),
    tps: null,
    ttftMs: null,
    decodeDurationMs: null,
    decodeOutputTokens: null,
    coverage: {
      ...performance('request').coverage,
      tpsRequests: 0,
      ttftRequests: 0,
    },
  },
  cacheHitRate: null,
  requestId: 'req-synthetic-3',
  status: 'error',
  outcome: 'failed',
  errorCode: 'http_error',
  httpStatus: 429,
  responseId: null,
  previousResponseId: 'resp-synthetic-2',
  startedAt: now - 3000,
  endedAt: now - 1000,
  inputTokens: null,
  totalInputTokens: null,
  cachedInputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  tps: null,
  ttftMs: null,
};
const tool: ReviewTool = {
  ordinal: 1,
  name: 'read_events',
  requestId: request.requestId,
  callId: 'call-synthetic',
  state: 'finished',
  status: 'ok',
  outcome: 'handled',
  reasonCode: null,
  proposedAt: now - 4500,
  startedAt: now - 4400,
  finishedAt: now - 4200,
  durationMs: 200,
  arguments: { query: 'synthetic needle', limit: 3 },
  result: { events: ['synthetic result body'], count: 1 },
};
const wake: WakeItem = {
  performance: performance('wake'),
  tps: 40,
  ttftMs: 500,
  cacheHitRate: 0.6667,
  wakeId: 'wake-synthetic',
  groupId: '10001',
  sessionId: 'session-synthetic',
  startedAt: now - 10000,
  finishedAt: now - 1000,
  durationMs: 9000,
  outcome: 'message_submitted',
  reasonCode: 'message_submitted',
  diagnostics: { sent_submissions: 1 },
  reply: 'Synthetic bot reply',
  modelRequests: 3,
  toolCalls: 1,
  inputTokens: 1200,
  uncachedInputTokens: 400,
  cachedInputTokens: 800,
  outputTokens: 160,
};
const wakeDetail: WakeReviewDetail = {
  wake,
  requests: [previous, request, failed],
  tools: [tool],
  memberNames: {},
  quotedMessages: {},
  contentTruncated: false,
  trigger: {
    type: 'message',
    messageIds: ['msg-synthetic'],
    actorId: 'actor-synthetic',
  },
  messages: [
    {
      role: 'user',
      content: 'Synthetic user question',
      createdAt: now - 10000,
    },
    {
      role: 'assistant',
      content: 'Synthetic assistant response',
      requestId: request.requestId,
      toolCallId: tool.callId!,
      createdAt: now - 4000,
    },
  ],
  events: [
    {
      time: now - 1000,
      kind: 'completion',
      title: 'Synthetic operation submitted',
      detail: { confirmedDelivery: false },
    },
  ],
};
const health: HealthResponse = {
  now,
  availability,
  connectivity: 'unknown',
  lastHeartbeatAt: null,
  lastConnectionEventAt: null,
  groups: [
    {
      groupId: '10001',
      sessionAvailable: true,
      lastObservedMessageAt: now - 10000,
      observationSource: 'runtime_received',
      lastRequestAt: null,
    },
  ],
  note: 'No live connectivity probe is available.',
};
const tools: ToolsResponse = {
  range,
  availability,
  items: [
    {
      name: tool.name,
      calls: 3,
      finished: 2,
      pending: 1,
      started: 0,
      unknown: 0,
      skipped: 0,
      handled: 1,
      rejected: 0,
      deferred: 0,
      cancelled: 0,
      errors: 1,
      durationP50Ms: 200,
      durationP95Ms: null,
    },
  ],
};
const toolDefinition = {
  name: 'read_events',
  description: 'Synthetic tool definition',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
};
const responsesBody = {
  id: 'resp-synthetic-2',
  object: 'response',
  model: 'synthetic-model',
  modelName: 'synthetic',
  status: 'completed',
  output: [
    {
      id: 'msg-output-synthetic',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: 'Synthetic Responses readable answer',
          annotations: [],
        },
      ],
    },
    {
      id: 'fc-synthetic',
      type: 'function_call',
      call_id: 'call-synthetic',
      name: 'read_events',
      arguments: JSON.stringify(tool.arguments),
      status: 'completed',
    },
  ],
  usage: {
    input_tokens: 600,
    input_tokens_details: { cached_tokens: 400 },
    output_tokens: 80,
    output_tokens_details: { reasoning_tokens: 30 },
  },
};
const chatBody = {
  id: 'chatcmpl-synthetic-1',
  object: 'chat.completion',
  model: 'synthetic-model',
  modelName: 'synthetic',
  choices: [
    {
      index: 0,
      finish_reason: 'tool_calls',
      message: {
        role: 'assistant',
        content: 'Synthetic Chat readable answer',
        tool_calls: [
          {
            id: 'chat-call-synthetic',
            type: 'function',
            function: {
              name: 'read_events',
              arguments: JSON.stringify({ query: 'synthetic chat query' }),
            },
          },
        ],
      },
    },
  ],
  usage: {
    prompt_tokens: 600,
    completion_tokens: 80,
    prompt_tokens_details: { cached_tokens: 400 },
    completion_tokens_details: { reasoning_tokens: 30 },
  },
};

function detail(id: string): RequestReviewDetail {
  const current = [previous, request, failed].find((r) => r.requestId === id)!;
  const requestBody =
    current.transport === 'chat'
      ? {
          model: current.model,
          messages: [
            { role: 'system', content: 'Synthetic system instructions' },
            { role: 'user', content: 'Synthetic request prompt' },
          ],
          tools: [{ type: 'function', function: toolDefinition }],
        }
      : {
          model: current.model,
          instructions: 'Synthetic system instructions',
          input: [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: 'Synthetic request prompt' },
              ],
            },
          ],
          tools: [{ type: 'function', ...toolDefinition }],
        };
  return {
    request: current,
    requestBody,
    responseBody:
      current.outcome === 'success'
        ? current.transport === 'chat'
          ? chatBody
          : responsesBody
        : null,
    reasoningText:
      current.outcome === 'success'
        ? 'Synthetic reasoning first line\nneedle reasoning second line\nfinal reasoning line'
        : null,
    errorText:
      current.outcome === 'failed'
        ? 'Synthetic rate limit provider detail'
        : null,
    contentTruncated: false,
    tools: id === request.requestId ? [tool] : [],
    memberNames: {},
    quotedMessages: {},
    previousRequest:
      id === previous.requestId
        ? null
        : {
            requestId:
              id === request.requestId ? previous.requestId : request.requestId,
            groupId: '10001',
            wakeId: wake.wakeId,
          },
    nextRequests:
      id === failed.requestId
        ? []
        : [
            {
              requestId:
                id === previous.requestId
                  ? request.requestId
                  : failed.requestId,
              groupId: '10001',
              wakeId: wake.wakeId,
            },
          ],
  };
}

const events: ReviewEventsResponse = {
  range,
  nextCursor: null,
  items: [
    {
      sequence: 1,
      time: now - 12000,
      event: 'app.started',
      level: 'info',
      groupId: null,
      turnId: null,
      messageId: null,
      title: 'Synthetic application started',
      detail: { source: 'synthetic fixture' },
    },
    {
      sequence: 2,
      time: now - 5000,
      event: 'model.response',
      level: 'info',
      groupId: '10001',
      turnId: 'turn-synthetic',
      messageId: 'msg-synthetic',
      title: 'Synthetic model response observed',
      detail: { source: 'synthetic fixture', outputTokens: 80 },
    },
  ],
};
const denseRequests: ReviewRequest[] = Array.from(
  { length: 13 },
  (_, index) => ({
    ...request,
    requestId: `req-synthetic-${index + 4}`,
    responseId: `resp-synthetic-${index + 4}`,
    providerRequestId: `provider-synthetic-${index + 4}`,
    startedAt: now - (index + 4) * 12000,
    endedAt: now - (index + 4) * 12000 + 2000,
  }),
);

interface MockState {
  /** 替换唤醒详情中的工具调用。 */
  tools?: ReviewTool[];
  authenticated?: boolean;
  configured?: boolean;
  invalidConfig?: boolean;
  businessConfigError?:
    'password_not_configured' | 'password_invalid_configuration';
  expired?: boolean;
  fail?: boolean;
  empty?: boolean;
  password?: string;
  dense?: boolean;
  continuation?: boolean;
  wakeVariant?: 'running' | 'missing';
}

function effectiveApiUrl(input: string | URL): URL {
  const url = new URL(input);
  return url.pathname === '/api/resource-sync'
    ? new URL(url.searchParams.get('resource')!, url.origin)
    : url;
}

function snapshot(data: unknown) {
  return { mode: 'snapshot', cursor: 'opaque-fixture-cursor', data };
}

async function refreshImmediately(page: Page) {
  const automatic = page.getByRole('checkbox', {
    name: '自动刷新',
    exact: true,
  });
  await automatic.uncheck();
  await automatic.check();
}

async function mock(page: Page, state: MockState = {}) {
  state.configured ??= true;
  state.authenticated ??= state.configured;
  state.password ??= 'synthetic-password';
  const requests: URL[] = [];
  const posts: { path: string; body: unknown }[] = [];
  await page.route('**/api/**', async (route) => {
    const transportUrl = new URL(route.request().url());
    const url = effectiveApiUrl(transportUrl);
    // Vite也会提供/src/api/client.ts，需交给先注册的资源代理处理。
    if (!url.pathname.startsWith('/api/')) {
      return route.fallback();
    }
    requests.push(url);
    const path = url.pathname;
    if (path.startsWith('/api/auth/')) {
      const action = path.split('/').at(-1);
      const body =
        route.request().method() === 'POST'
          ? route.request().postDataJSON()
          : null;
      if (route.request().method() === 'POST') {
        expect(body, `${action} must send a JSON object body`).not.toBeNull();
        expect(typeof body).toBe('object');
        expect(Array.isArray(body)).toBe(false);
        if (action === 'logout') {
          expect(body).toEqual({});
        }
        posts.push({ path, body });
      }
      if (action === 'login') {
        if (body.password !== state.password) {
          return route.fulfill({
            status: 401,
            json: { error: 'unauthorized' },
          });
        }
        state.authenticated = true;
        state.expired = false;
      } else if (action === 'logout') {
        state.authenticated = false;
      }
      return route.fulfill({
        json: {
          authenticated: state.authenticated,
          configured: state.configured,
          ...(!state.configured
            ? {
                error: state.invalidConfig
                  ? 'password_invalid_configuration'
                  : 'password_not_configured',
              }
            : {}),
        },
      });
    }
    expect(route.request().method()).toBe('GET');
    if (path !== '/api/request-trends/sync') {
      expect(transportUrl.pathname).toBe('/api/resource-sync');
    }
    if (state.businessConfigError) {
      return route.fulfill({
        status: 503,
        json: { error: state.businessConfigError },
      });
    }
    if (state.expired || !state.authenticated) {
      return route.fulfill({ status: 401, json: { error: 'unauthorized' } });
    }
    if (state.fail && path === '/api/requests') {
      return route.fulfill({ status: 503, json: { error: 'unavailable' } });
    }
    let body: unknown;
    if (path === '/api/meta') {
      body = {
        groups: [{ groupId: '10001' }],
        models: ['synthetic'],
        readOnly: true,
        maxRangeDays: 31,
        now,
        availability,
      };
    } else if (path === '/api/overview') {
      const summary: UsageSummary = state.dense
        ? {
            ...usage,
            requests: 16,
            successes: 15,
            inputTokens: 9000,
            uncachedInputTokens: 3000,
            cachedInputTokens: 6000,
            outputTokens: 1200,
            performance: {
              ...performance('aggregate'),
              modelDurationMs: 32000,
              decodeDurationMs: 30000,
              decodeOutputTokens: 1200,
              coverage: {
                ...performance('aggregate').coverage,
                requests: 16,
                endedRequests: 16,
                modelDurationRequests: 16,
                modelIntervalRequests: 16,
                tpsRequests: 15,
              },
            },
          }
        : usage;
      body = {
        ...overview,
        summary,
        groups: [{ ...summary, groupId: '10001' }],
        models: [{ ...summary, modelName: 'synthetic' }],
      } satisfies OverviewResponse;
    } else if (path === '/api/request-trends/sync') {
      const selectedRange = {
        since: Number(url.searchParams.get('since')),
        until: Number(url.searchParams.get('until')),
      };
      const items = state.empty
        ? []
        : [request, failed, previous].map((item, i) => ({
            ...item,
            startedAt:
              selectedRange.since +
              ((selectedRange.until - selectedRange.since) * (i + 1)) / 4,
          }));
      const snapshot = buildRequestTrends(selectedRange, availability, items);
      body = {
        ...snapshot,
        mode: 'snapshot',
        cursor: 'fixture-cursor',
        removals: [],
        upserts: snapshot.points.map((point, index) => ({
          ...point,
          key: JSON.stringify([items[index]!.groupId, items[index]!.requestId]),
        })),
      };
    } else if (path === '/api/health') {
      body = health;
    } else if (path === '/api/tools') {
      body = tools;
    } else if (path === '/api/requests') {
      const items = state.empty
        ? []
        : [request, failed, previous, ...(state.dense ? denseRequests : [])];
      body = {
        range,
        items: items.filter(
          (r) =>
            (!url.searchParams.get('q') ||
              [r.requestId, r.turnId, r.groupId].some((value) =>
                value?.includes(url.searchParams.get('q')!),
              )) &&
            (!url.searchParams.get('outcome') ||
              r.outcome === url.searchParams.get('outcome')) &&
            (!url.searchParams.get('modelName') ||
              r.modelName === url.searchParams.get('modelName')),
        ),
        nextCursor:
          state.empty || url.searchParams.has('cursor')
            ? null
            : 'synthetic-next',
      } satisfies ReviewRequestsResponse;
    } else if (path === '/api/events') {
      const category = url.searchParams.get('category'),
        q = url.searchParams.get('q');
      body = {
        ...events,
        items: events.items.filter(
          (item) =>
            (!category || item.event.startsWith(`${category}.`)) &&
            (!q ||
              [item.event, item.groupId, item.turnId, item.messageId].some(
                (value) => value?.includes(q),
              )),
        ),
      } satisfies ReviewEventsResponse;
    } else if (
      path === '/api/wakes' ||
      path === `/api/wakes/${wake.wakeId}/review`
    ) {
      const item: WakeItem =
        state.wakeVariant === 'running'
          ? {
              ...wake,
              finishedAt: null,
              durationMs: null,
              outcome: null,
              reasonCode: null,
            }
          : state.wakeVariant === 'missing'
            ? {
                ...wake,
                uncachedInputTokens: null,
                cachedInputTokens: undefined,
              }
            : wake;
      body =
        path === '/api/wakes'
          ? ({
              range,
              availability,
              items: state.empty ? [] : [item],
              nextCursor: null,
            } satisfies WakesResponse)
          : ({
              ...wakeDetail,
              wake: item,
              tools: state.tools ?? wakeDetail.tools,
            } satisfies WakeReviewDetail);
    } else if (path.startsWith('/api/requests/')) {
      const id = decodeURIComponent(path.split('/').at(-1)!);
      if (
        ![request.requestId, previous.requestId, failed.requestId].includes(id)
      ) {
        return route.fulfill({ status: 404, json: { error: 'not_found' } });
      }
      const response = detail(id);
      if (state.continuation && id === request.requestId) {
        response.request = {
          ...response.request,
          requestMode: 'continue_live',
        };
        response.requestBody = {
          model: request.model,
          previous_response_id: previous.responseId,
          input: [
            {
              type: 'function_call_output',
              call_id: 'call-synthetic',
              output: 'Synthetic incremental tool output',
            },
          ],
        };
      }
      body = response;
    } else {
      return route.fulfill({ status: 404, json: { error: 'not_found' } });
    }
    return route.fulfill({
      json:
        transportUrl.pathname === '/api/resource-sync' ? snapshot(body) : body,
    });
  });
  return { requests, posts };
}

test('overview charts preserve raw metrics, free coordinates, filters and mobile layout', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const { requests } = await mock(page);
  await page.goto('/?range=5m&chartMetric=duration');
  const scatter = page.getByRole('img', {
    name: '每请求原始散点图',
    exact: true,
  });
  await expect(scatter).toBeVisible();
  await expect(scatter.locator('canvas').first()).toBeVisible();
  await expect(page.getByTestId('request-trends-summary')).toContainText('3');
  const metric = page.getByLabel('散点纵轴指标');
  await expect(metric.locator('option')).toHaveCount(8);
  for (const key of [
    'input',
    'totalInput',
    'cachedInput',
    'output',
    'ttft',
    'tps',
    'cacheHitRate',
    'duration',
  ]) {
    await metric.selectOption(key);
    await expect(page).toHaveURL(new RegExp(`chartMetric=${key}`));
    await expect(page.getByTestId('request-scatter-summary')).toContainText(
      '总数 3',
    );
  }
  await scatter.scrollIntoViewIfNeeded();
  const box = (await scatter.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await expect(page.getByTestId('chart-crosshair')).toBeVisible();
  const firstX = await page.getByTestId('crosshair-x').textContent();
  const firstY = await page.getByTestId('crosshair-y').textContent();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.45);
  await expect(page.getByTestId('crosshair-x')).not.toHaveText(firstX!);
  await expect(page.getByTestId('crosshair-y')).not.toHaveText(firstY!);
  await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.45);
  await expect(page).not.toHaveURL(/selected=/);
  await page.mouse.move(0, 0);
  await expect(page.getByTestId('chart-crosshair')).toHaveCount(0);
  await page.getByLabel('群组', { exact: true }).selectOption('10001');
  await page.getByLabel('时间范围').selectOption('3h');
  await expect
    .poll(() =>
      requests.some(
        (u) =>
          u.pathname === '/api/request-trends/sync' &&
          u.searchParams.get('groupId') === '10001' &&
          Number(u.searchParams.get('until')) -
            Number(u.searchParams.get('since')) ===
            3 * 3600000,
      ),
    )
    .toBe(true);
  expect(
    requests
      .filter((u) => u.pathname === '/api/request-trends/sync')
      .every((u) => !u.searchParams.has('chartMetric')),
  ).toBe(true);
  await metric.selectOption('output');
  // 每个选项是一个循环按钮：范围 全部 -> 99% -> 95% -> 全部。
  const cycle = (name: string) =>
    page.getByRole('button', { name: new RegExp(`^${name}：`) });
  const range = cycle('散点显示范围');
  await expect(range).toHaveAccessibleName('散点显示范围：全部，点击切换');
  await range.click();
  await expect(page).toHaveURL(/chartRange=p99/);
  await range.click();
  await expect(page).toHaveURL(/chartRange=p95/);
  await expect(page.getByLabel('请求趋势图表', { exact: true })).toContainText(
    '有效点少于20条',
  );
  await page.reload();
  await expect(metric).toHaveValue('output');
  await expect(range).toHaveAccessibleName('散点显示范围：95%，点击切换');
  expect(
    requests
      .filter((u) => u.pathname === '/api/request-trends/sync')
      .every((u) => !u.searchParams.has('chartRange')),
  ).toBe(true);
  // 刻度与点样式同样只在URL中，不改变数据请求；百分比指标禁用对数刻度。
  const scale = cycle('散点纵轴刻度');
  await scale.click();
  await expect(page).toHaveURL(/chartScale=log/);
  await cycle('散点样式').click();
  await expect(page).toHaveURL(/chartDots=bold/);
  await metric.selectOption('cacheHitRate');
  await expect(scale).toBeDisabled();
  await expect(scale).toHaveAccessibleName('散点纵轴刻度：线性，点击切换');
  await metric.selectOption('output');
  await expect(scale).toHaveAccessibleName('散点纵轴刻度：对数，点击切换');
  // 选项按钮与纵轴下拉框在同一行。
  const top = async (locator: typeof metric) =>
    Math.round((await locator.boundingBox())!.y);
  expect(
    Math.abs((await top(scale)) - (await top(metric))),
  ).toBeLessThanOrEqual(4);
  expect(
    requests
      .filter((u) => u.pathname === '/api/request-trends/sync')
      .every(
        (u) =>
          !u.searchParams.has('chartScale') && !u.searchParams.has('chartDots'),
      ),
  ).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(scatter).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await mkdir(resolve('artifacts'), { recursive: true });
  await page.screenshot({
    path: resolve('artifacts/dashboard-charts-mobile.png'),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test('scatter guide toggle is local, persists in URL and survives cached navigation', async ({
  page,
}) => {
  await page.clock.install();
  const { requests } = await mock(page);
  await page.goto('/?chartGuides=invalid');
  const button = page.getByRole('button', { name: /^散点辅助线：/ });
  const note = page.locator('.scatter-panel .chart-note');
  await expect(page.getByTestId('request-scatter-summary')).toBeVisible();
  await expect(button).toHaveAccessibleName('散点辅助线：分位线，点击切换');
  const count = () =>
    requests.filter((u) => u.pathname === '/api/request-trends/sync').length;
  const before = count();
  await button.click();
  await expect(page).toHaveURL(/chartGuides=hide/);
  await expect(button).toHaveAccessibleName('散点辅助线：隐藏，点击切换');
  await expect(note).not.toContainText('P5/P95');
  expect(count()).toBe(before);
  await page.getByLabel('散点纵轴指标').selectOption('totalInput');
  await expect(button).toHaveAccessibleName('散点辅助线：隐藏，点击切换');
  expect(count()).toBe(before);
  await page.reload();
  await expect(button).toHaveAccessibleName('散点辅助线：隐藏，点击切换');
  await page.getByRole('link', { name: '工具', exact: true }).click();
  await page.getByRole('link', { name: '总览', exact: true }).click();
  await expect(button).toHaveAccessibleName('散点辅助线：隐藏，点击切换');
  await expect(page.getByTestId('dashboard-refresh-status')).not.toHaveText(
    '刷新中…',
  );
  await button.click();
  await expect(page).not.toHaveURL(/chartGuides=/);
  await expect(note).toContainText('P5/P95');
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(button).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  }
  expect(requests.every((u) => !u.searchParams.has('chartGuides'))).toBe(true);
});

// 独立覆盖趋势接口，避免拟合数据改变其他页面的通用 fixture。
async function mockFitTrends(page: Page) {
  const { requests } = await mock(page);
  const trendRequests: URL[] = [];
  const groups = ['10001', '10002'];
  await page.route(
    (url) => effectiveApiUrl(url).pathname === '/api/meta',
    (route) =>
      route.fulfill({
        json: snapshot({
          groups: groups.map((groupId) => ({ groupId })),
          models: ['synthetic'],
          readOnly: true,
          maxRangeDays: 31,
          now,
          availability,
        }),
      }),
  );
  await page.route('**/api/request-trends/sync?*', async (route) => {
    const url = new URL(route.request().url());
    trendRequests.push(url);
    const selectedRange = {
      since: Number(url.searchParams.get('since')),
      until: Number(url.searchParams.get('until')),
    };
    const rows = groups
      .flatMap((groupId, groupIndex) =>
        Array.from({ length: 16 }, (_, index): ReviewRequest => {
          const totalInputTokens = 2000 + groupIndex * 4000 + index * 600;
          // 单个缓存跌落不应被当作整群重置；两群复用 requestId 验证复合键。
          const cachedInputTokens =
            index === 8 ? 100 : 1000 + groupIndex * 2000 + index * 400;
          const startedAt =
            selectedRange.since +
            ((selectedRange.until - selectedRange.since) * (index + 1)) / 18;
          return {
            ...request,
            groupId,
            requestId: `fit-request-${index}`,
            startedAt,
            endedAt: startedAt + 2000,
            totalInputTokens,
            cachedInputTokens,
            inputTokens: totalInputTokens - cachedInputTokens,
          };
        }),
      )
      .filter(
        (row) =>
          !url.searchParams.has('groupId') ||
          row.groupId === url.searchParams.get('groupId'),
      );
    const data = buildRequestTrends(selectedRange, availability, rows);
    await route.fulfill({
      json: {
        ...data,
        mode: 'snapshot',
        cursor: 'fit-fixture-cursor',
        removals: [],
        upserts: data.points.map((point, index) => ({
          ...point,
          key: JSON.stringify([rows[index]!.groupId, rows[index]!.requestId]),
        })),
      },
    });
  });
  return { requests, trendRequests };
}

test('scatter fit mode cycles locally, supports only total and cached input and restores URL intent', async ({
  page,
}) => {
  await page.clock.install();
  const { requests, trendRequests } = await mockFitTrends(page);
  await page.goto('/?range=5m&chartMetric=totalInput');
  const metric = page.getByLabel('散点纵轴指标');
  const button = page.getByRole('button', { name: /^散点辅助线：/ });
  const legend = page.getByRole('list', { name: '拟合线群组图例' });
  await expect(page.getByTestId('request-scatter-summary')).toContainText(
    '总数 32',
  );
  await expect(page.getByTestId('dashboard-refresh-status')).not.toHaveText(
    '刷新中…',
  );
  const before = [requests.length, trendRequests.length];
  await expect(button).toHaveAccessibleName('散点辅助线：分位线，点击切换');
  await button.click();
  await expect(button).toHaveAccessibleName('散点辅助线：拟合线，点击切换');
  await expect(page).toHaveURL(/chartGuides=fit/);
  await expect(legend.getByRole('listitem')).toHaveCount(2);
  await expect(legend).toContainText('群 10001');
  await expect(legend).toContainText('群 10002');
  await button.click();
  await expect(button).toHaveAccessibleName('散点辅助线：隐藏，点击切换');
  await expect(page).toHaveURL(/chartGuides=hide/);
  await expect(legend).toHaveCount(0);
  await button.click();
  await expect(button).toHaveAccessibleName('散点辅助线：分位线，点击切换');
  await expect(page).not.toHaveURL(/chartGuides=/);
  await metric.selectOption('cachedInput');
  await button.click();
  await expect(button).toHaveAccessibleName('散点辅助线：拟合线，点击切换');
  await expect(legend.getByRole('listitem')).toHaveCount(2);
  for (const unsupported of [
    'duration',
    'input',
    'output',
    'ttft',
    'tps',
    'cacheHitRate',
  ]) {
    await metric.selectOption(unsupported);
    await expect(button).toHaveAccessibleName('散点辅助线：隐藏，点击切换');
    await expect(legend).toHaveCount(0);
    await expect(page).toHaveURL(/chartGuides=fit/);
  }
  for (const supported of ['totalInput', 'cachedInput']) {
    await metric.selectOption(supported);
    await expect(button).toHaveAccessibleName('散点辅助线：拟合线，点击切换');
    await expect(legend.getByRole('listitem')).toHaveCount(2);
  }
  await metric.selectOption('output');
  await button.click();
  await expect(button).toHaveAccessibleName('散点辅助线：分位线，点击切换');
  await expect(page).not.toHaveURL(/chartGuides=/);
  await button.click();
  await expect(button).toHaveAccessibleName('散点辅助线：隐藏，点击切换');
  await expect(page).toHaveURL(/chartGuides=hide/);
  expect([requests.length, trendRequests.length]).toEqual(before);
  expect(
    [...requests, ...trendRequests].every(
      (url) =>
        !url.searchParams.has('chartGuides') &&
        !url.searchParams.has('chartMetric'),
    ),
  ).toBe(true);
});

test('scatter per-group fit legend filters and survives reload, cached navigation and mobile layout', async ({
  page,
}) => {
  await page.clock.install();
  const { trendRequests } = await mockFitTrends(page);
  await page.goto('/?range=5m&chartMetric=cachedInput&chartGuides=fit');
  const button = page.getByRole('button', { name: /^散点辅助线：/ });
  const legend = page.getByRole('list', { name: '拟合线群组图例' });
  await expect(legend.getByRole('listitem')).toHaveCount(2);
  await page.reload();
  await expect(button).toHaveAccessibleName('散点辅助线：拟合线，点击切换');
  await expect(legend.getByRole('listitem')).toHaveCount(2);
  await page.getByRole('link', { name: '工具', exact: true }).click();
  await page.getByRole('link', { name: '总览', exact: true }).click();
  await expect(page).toHaveURL(/chartGuides=fit/);
  await expect(button).toHaveAccessibleName('散点辅助线：拟合线，点击切换');
  await expect(legend.getByRole('listitem')).toHaveCount(2);
  for (const groupId of ['10001', '10002']) {
    await page.getByLabel('群组', { exact: true }).selectOption(groupId);
    await expect
      .poll(() => trendRequests.at(-1)?.searchParams.get('groupId'))
      .toBe(groupId);
    await expect(page.getByTestId('request-scatter-summary')).toContainText(
      '总数 16',
    );
    await expect(legend.getByRole('listitem')).toHaveCount(1);
    await expect(legend.getByRole('listitem')).toContainText(`群 ${groupId}`);
    await expect(legend).not.toContainText(
      `群 ${groupId === '10001' ? '10002' : '10001'}`,
    );
  }
  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(legend).toBeVisible();
    await expect(button).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  }
  // 不支持指标刷新仍保留 fit 意图，随后切回支持指标恢复。
  await page.getByLabel('散点纵轴指标').selectOption('duration');
  await page.reload();
  await expect(page).toHaveURL(/chartGuides=fit/);
  await expect(button).toHaveAccessibleName('散点辅助线：隐藏，点击切换');
  await expect(legend).toHaveCount(0);
  await page.getByLabel('散点纵轴指标').selectOption('totalInput');
  await expect(button).toHaveAccessibleName('散点辅助线：拟合线，点击切换');
  await expect(legend.getByRole('listitem')).toHaveCount(1);
  await expect(legend).toContainText('群 10002');
});

// Hold only overview-owned responses; all fixture data still comes from mock().
async function interceptOverviewSync(page: Page) {
  const paths = ['/api/overview', '/api/health', '/api/request-trends/sync'];
  const calls: URL[] = [];
  let held = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => paths.includes(effectiveApiUrl(url).pathname),
    async (route) => {
      const url = new URL(route.request().url());
      calls.push(url);
      if (held) {
        await pending;
      }
      await route.fallback();
    },
  );
  return {
    calls,
    paths,
    hold: () => {
      held = true;
    },
    release: () => {
      held = false;
      release();
    },
  };
}

test('overview KeepAlive preserves canvas and visible data while immediately resuming all cursors', async ({
  page,
}) => {
  await page.clock.install();
  await mock(page);
  const sync = await interceptOverviewSync(page);
  await page.goto('/?range=5m');
  const scatter = page.getByRole('img', {
    name: '每请求原始散点图',
    exact: true,
  });
  const canvas = scatter.locator('canvas').first();
  const summary = page.getByTestId('request-scatter-summary');
  const metrics = page.getByLabel('总览汇总');
  await expect(canvas).toBeVisible();
  await expect(summary).toContainText('总数 3');
  await expect(metrics).toBeVisible();
  const originalCanvas = (await canvas.elementHandle())!;
  const initialSummary = await summary.textContent();
  const initialMetrics = await metrics.textContent();
  await page.getByRole('link', { name: '工具', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '工具统计', exact: true }),
  ).toBeVisible();
  await expect(scatter).toHaveCount(0);
  const before = sync.calls.length;
  sync.hold();
  try {
    await page.getByRole('link', { name: '总览', exact: true }).click();
    // No clock advancement: reactivation must not wait for the next poll.
    await expect.poll(() => sync.calls.length).toBe(before + 3);
    for (const path of sync.paths) {
      const call = sync.calls
        .slice(before)
        .find((url) => effectiveApiUrl(url).pathname === path)!;
      expect(call.pathname).toBe(
        path === '/api/request-trends/sync' ? path : '/api/resource-sync',
      );
      expect(call.searchParams.get('cursor')).toBe(
        path === '/api/request-trends/sync'
          ? 'fixture-cursor'
          : 'opaque-fixture-cursor',
      );
    }
    await expect(canvas).toBeVisible();
    expect(
      await canvas.evaluate(
        (node, original) => node === original,
        originalCanvas,
      ),
    ).toBe(true);
    await expect(summary).toHaveText(initialSummary!);
    await expect(metrics).toHaveText(initialMetrics!);
  } finally {
    sync.release();
  }
  await expect(page.getByTestId('dashboard-refresh-status')).not.toHaveText(
    '刷新中…',
  );
  expect(
    await canvas.evaluate(
      (node, original) => node === original,
      originalCanvas,
    ),
  ).toBe(true);
});

test('overview KeepAlive stays idle while hidden and resets changed scope before showing old data', async ({
  page,
}) => {
  await page.clock.install();
  const state: MockState = {};
  await mock(page, state);
  const sync = await interceptOverviewSync(page);
  await page.goto('/?range=5m');
  const summary = page.getByTestId('request-scatter-summary');
  const metrics = page.getByLabel('总览汇总');
  await expect(summary).toContainText('总数 3');
  await expect(metrics.locator('strong').first()).toHaveText('3');
  await page.getByRole('link', { name: '工具', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '工具统计', exact: true }),
  ).toBeVisible();
  const before = sync.calls.length;
  await refreshImmediately(page);
  await page.clock.runFor(15100);
  expect(sync.calls).toHaveLength(before);
  await page.getByLabel('群组', { exact: true }).selectOption('10001');
  await page.getByLabel('时间范围').selectOption('3h');
  await page.clock.runFor(5100);
  expect(sync.calls).toHaveLength(before);
  state.empty = true;
  state.dense = true;
  sync.hold();
  try {
    await page.getByRole('link', { name: '总览', exact: true }).click();
    await expect.poll(() => sync.calls.length).toBe(before + 3);
    for (const path of ['/api/overview', '/api/request-trends/sync']) {
      const call = sync.calls
        .slice(before)
        .find((url) => effectiveApiUrl(url).pathname === path)!;
      expect(call.searchParams.has('cursor')).toBe(false);
      const scope = effectiveApiUrl(call).searchParams;
      expect(scope.get('groupId')).toBe('10001');
      expect(Number(scope.get('until')) - Number(scope.get('since'))).toBe(
        3 * 3600000,
      );
    }
    // Responses are held so a fast replacement cannot mask stale scope data.
    await expect(metrics).not.toBeVisible();
    await expect(summary.filter({ hasText: '总数 3' })).toHaveCount(0);
  } finally {
    sync.release();
  }
  await expect(metrics.locator('strong').first()).toHaveText('16');
  await expect(summary).toContainText('总数 0');
});

test('overview KeepAlive cache is destroyed on logout and login starts without old cursors', async ({
  page,
}) => {
  await page.clock.install();
  const state: MockState = {};
  await mock(page, state);
  const sync = await interceptOverviewSync(page);
  await page.goto('/?range=5m');
  const canvas = page
    .getByRole('img', { name: '每请求原始散点图', exact: true })
    .locator('canvas')
    .first();
  await expect(canvas).toBeVisible();
  await expect(page.getByTestId('request-scatter-summary')).toContainText(
    '总数 3',
  );
  const originalCanvas = (await canvas.elementHandle())!;
  await page.getByRole('link', { name: '工具', exact: true }).click();
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '登录', exact: true }),
  ).toBeVisible();
  const before = sync.calls.length;
  await page.clock.runFor(15000);
  expect(sync.calls).toHaveLength(before);
  state.dense = true;
  sync.hold();
  try {
    await page.getByLabel('密码', { exact: true }).fill('synthetic-password');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('link', { name: '总览', exact: true }).click();
    await expect.poll(() => sync.calls.length).toBe(before + 3);
    for (const call of sync.calls.slice(before)) {
      expect(call.searchParams.has('cursor')).toBe(false);
    }
    await expect(page.getByLabel('总览汇总')).not.toBeVisible();
    await expect(
      page.getByTestId('request-scatter-summary').filter({ hasText: '总数 3' }),
    ).toHaveCount(0);
  } finally {
    sync.release();
  }
  await expect(
    page.getByLabel('总览汇总').locator('strong').first(),
  ).toHaveText('16');
  await expect(canvas).toBeVisible();
  expect(
    await canvas.evaluate(
      (node, original) => node === original,
      originalCanvas,
    ),
  ).toBe(false);
});

test('overview KeepAlive aborts in-flight trends and ignores late responses after reactivation', async ({
  page,
}) => {
  await page.clock.install();
  const { requests } = await mock(page);
  await page.goto('/?range=5m');
  const summary = page.getByTestId('request-scatter-summary');
  await expect(summary).toContainText('总数 3');
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let heldUrl: string | undefined;
  let aborted = false;
  page.on('requestfailed', (request) => {
    if (request.url() === heldUrl) {
      aborted = true;
    }
  });
  await page.route('**/api/request-trends/sync?*', async (route) => {
    if (heldUrl) {
      return route.fallback();
    }
    heldUrl = route.request().url();
    const url = new URL(heldUrl);
    const stale = buildRequestTrends(
      {
        since: Number(url.searchParams.get('since')),
        until: Number(url.searchParams.get('until')),
      },
      availability,
      [],
    );
    await pending;
    try {
      await route.fulfill({
        json: {
          ...stale,
          mode: 'snapshot',
          cursor: 'late-obsolete-cursor',
          upserts: [],
          removals: [],
        },
      });
    } finally {
      finish();
    }
  });
  try {
    await refreshImmediately(page);
    await expect.poll(() => heldUrl).toBeTruthy();
    await page.getByRole('link', { name: '工具', exact: true }).click();
    await expect.poll(() => aborted).toBe(true);
    const before = requests.filter(
      (url) => url.pathname === '/api/request-trends/sync',
    ).length;
    await page.getByRole('link', { name: '总览', exact: true }).click();
    await expect
      .poll(
        () =>
          requests.filter((url) => url.pathname === '/api/request-trends/sync')
            .length,
      )
      .toBe(before + 1);
    await expect(summary).toContainText('总数 3');
    await expect(page.getByTestId('dashboard-refresh-status')).toHaveText(
      '5秒',
    );
    release();
    await finished;
    // The abandoned empty snapshot must not clear the restored chart or cursor.
    await refreshImmediately(page);
    await expect
      .poll(
        () =>
          requests.filter((url) => url.pathname === '/api/request-trends/sync')
            .length,
      )
      .toBe(before + 2);
    expect(
      requests
        .filter((url) => url.pathname === '/api/request-trends/sync')
        .at(-1)!
        .searchParams.get('cursor'),
    ).toBe('fixture-cursor');
    await expect(summary).toContainText('总数 3');
  } finally {
    release();
  }
});

test('trend refresh merges delta updates and removals, retries stale data and resets on filters', async ({
  page,
}) => {
  await mock(page);
  const calls: URL[] = [];
  let version = 0;
  let fail = false;
  await page.route('**/api/request-trends/sync?*', async (route) => {
    const url = new URL(route.request().url());
    calls.push(url);
    if (fail) {
      return route.fulfill({ status: 503, json: { error: 'unavailable' } });
    }
    const range = {
      since: Number(url.searchParams.get('since')),
      until: Number(url.searchParams.get('until')),
    };
    const snapshot = buildRequestTrends(range, availability, [
      {
        ...request,
        startedAt: range.until - 1000,
        durationMs: version ? 9000 : 1000,
      },
    ]);
    const hasCursor = url.searchParams.has('cursor');
    await route.fulfill({
      json: {
        ...snapshot,
        cursor: `version-${++version}`,
        mode: hasCursor ? 'delta' : 'snapshot',
        upserts: snapshot.points.map((point) => ({
          ...point,
          key: 'same-request',
        })),
        removals: hasCursor ? ['old-request'] : [],
        ...(!hasCursor
          ? {
              upserts: [
                ...snapshot.points.map((point) => ({
                  ...point,
                  key: 'same-request',
                })),
                { ...snapshot.points[0], key: 'old-request' },
              ],
            }
          : {}),
      },
    });
  });
  await page.goto('/?range=5m');
  const summary = page.getByTestId('request-scatter-summary');
  await expect(summary).toContainText('总数 2');
  await refreshImmediately(page);
  await expect(summary).toContainText('总数 1');
  expect(calls.at(-1)!.searchParams.get('cursor')).toBe('version-1');
  fail = true;
  await refreshImmediately(page);
  await expect(
    page.getByLabel('请求趋势图表', { exact: true }).getByRole('alert'),
  ).toBeVisible();
  await expect(summary).toContainText('总数 1');
  fail = false;
  await page.getByRole('button', { name: '重试图表', exact: true }).click();
  await expect(
    page.getByLabel('请求趋势图表', { exact: true }).getByRole('alert'),
  ).toHaveCount(0);
  await page.getByLabel('时间范围').selectOption('3h');
  await expect(summary).toContainText('总数 2');
  expect(calls.at(-1)!.searchParams.has('cursor')).toBe(false);
});

test('global refresh counts down each second and shows pending until the refresh completes', async ({
  page,
}) => {
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now + 1000);
  await mock(page);
  let calls = 0;
  let holdRefresh = false;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(
    (url) => effectiveApiUrl(url).pathname === '/api/tools',
    async (route) => {
      calls++;
      if (holdRefresh) {
        await pending;
      }
      await route.fulfill({ json: snapshot(tools) });
    },
  );
  await page.goto('/tools');
  await expect(page.locator('main tbody tr')).toHaveCount(1);
  const status = page.getByTestId('dashboard-refresh-status');
  await expect(
    page.getByRole('checkbox', { name: '自动刷新', exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole('button', { name: /^(刷新|暂停自动刷新|恢复自动刷新)$/ }),
  ).toHaveCount(0);
  await expect(status).toHaveText('5秒');
  // 认证启用调度器时可能立即补刷新，与路由首次加载先后顺序有关。
  // 启动请求全部完成后才挂起下一轮，不能将“第二个请求”误认为5秒定时刷新。
  const initialCalls = calls;
  expect(initialCalls).toBeGreaterThan(0);
  holdRefresh = true;
  for (const seconds of [4, 3, 2, 1]) {
    await page.clock.runFor(1000);
    await expect(status).toHaveText(`${seconds}秒`);
    expect(calls).toBe(initialCalls);
  }
  await page.clock.runFor(999);
  await expect(status).toHaveText('1秒');
  expect(calls).toBe(initialCalls);
  await page.clock.runFor(1);
  await expect.poll(() => calls).toBe(initialCalls + 1);
  await expect(status).toContainText('刷新中');
  // 慢响应不能与下一轮刷新重叠，也不能显示错误的倒计时。
  await page.clock.runFor(15000);
  expect(calls).toBe(initialCalls + 1);
  await expect(status).toContainText('刷新中');
  release();
  await expect(status).toHaveText('5秒');
  await page.clock.runFor(1000);
  await expect(status).toHaveText('4秒');
});

test('global refresh defaults to five seconds, polls overview and charts, and pauses when hidden or disabled', async ({
  page,
}) => {
  await page.clock.install();
  const { requests } = await mock(page);
  // 已移除的chartRefresh参数不能关闭全局刷新。
  await page.goto('/?range=5m&chartRefresh=0');
  await expect(page.getByTestId('request-scatter-summary')).toBeVisible();
  await expect(page.getByTestId('dashboard-refresh-status')).toHaveText('5秒');
  await expect(
    page.getByRole('checkbox', { name: '自动刷新', exact: true }),
  ).toBeChecked();
  await expect(page.getByLabel('图表自动刷新')).toHaveCount(0);
  const paths = [
    '/api/meta',
    '/api/health',
    '/api/overview',
    '/api/request-trends/sync',
  ];
  const count = (path: string) =>
    requests.filter((u) => u.pathname === path).length;
  const initial = paths.map(count);
  await page.clock.runFor(5100);
  for (const [i, path] of paths.entries()) {
    await expect.poll(() => count(path)).toBe(initial[i]! + 1);
  }
  expect(
    requests
      .filter((u) => u.pathname === '/api/request-trends/sync')
      .at(-1)!
      .searchParams.has('cursor'),
  ).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.getByTestId('dashboard-refresh-status')).toHaveText(
    '页面隐藏，已暂停',
  );
  await expect(
    page.getByRole('checkbox', { name: '自动刷新', exact: true }),
  ).toBeChecked();
  const hiddenCounts = paths.map(count);
  await page.clock.runFor(60000);
  expect(paths.map(count)).toEqual(hiddenCounts);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => false,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(5100);
  for (const [i, path] of paths.entries()) {
    await expect.poll(() => count(path)).toBeGreaterThan(hiddenCounts[i]!);
  }
  await page.getByRole('checkbox', { name: '自动刷新', exact: true }).uncheck();
  await expect(page.getByTestId('dashboard-refresh-status')).toHaveText(
    '已暂停',
  );
  await expect(
    page.getByRole('checkbox', { name: '自动刷新', exact: true }),
  ).not.toBeChecked();
  const pausedCounts = paths.map(count);
  const pausedRequestCount = requests.length;
  await page.clock.runFor(60000);
  expect(paths.map(count)).toEqual(pausedCounts);
  expect(requests).toHaveLength(pausedRequestCount);
  await expect(page.getByTestId('dashboard-refresh-status')).toHaveText(
    '已暂停',
  );
  // 页面重新可见时不能覆盖用户取消勾选的设置。
  for (const hidden of [true, false]) {
    await page.evaluate((hidden) => {
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => hidden,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
    await page.clock.runFor(10000);
    expect(requests).toHaveLength(pausedRequestCount);
  }
  await page.getByRole('checkbox', { name: '自动刷新', exact: true }).check();
  for (const [i, path] of paths.entries()) {
    await expect.poll(() => count(path)).toBeGreaterThan(pausedCounts[i]!);
  }
});

for (const [url, paths] of [
  [
    '/requests?selected=req-synthetic-2&detailGroup=10001',
    ['/api/requests', '/api/requests/req-synthetic-2'],
  ],
  [
    '/wakes?selected=wake-synthetic&detailGroup=10001',
    ['/api/wakes', '/api/wakes/wake-synthetic/review'],
  ],
  ['/tools', ['/api/tools']],
  ['/events', ['/api/events']],
] as const) {
  test(`global refresh polls the active list and detail on ${url}`, async ({
    page,
  }) => {
    await page.clock.install();
    const { requests } = await mock(page);
    await page.goto(url);
    const count = (path: string) =>
      requests.filter((u) => u.pathname === path).length;
    for (const path of paths) {
      await expect.poll(() => count(path)).toBeGreaterThan(0);
    }
    await expect(page.getByTestId('dashboard-refresh-status')).toHaveText(
      '5秒',
    );
    const initial = paths.map(count);
    await page.clock.runFor(5100);
    for (const [i, path] of paths.entries()) {
      await expect.poll(() => count(path)).toBe(initial[i]! + 1);
    }
  });
}

test('scatter percentile controls clip the display without changing request totals', async ({
  page,
}) => {
  await mock(page);
  await page.route('**/api/request-trends/sync?*', async (route) => {
    const url = new URL(route.request().url());
    const range = {
      since: Number(url.searchParams.get('since')),
      until: Number(url.searchParams.get('until')),
    };
    const rows = Array.from({ length: 100 }, (_, i) => ({
      ...request,
      startedAt: range.since + i,
      durationMs: i * 1000,
    }));
    const snapshot = buildRequestTrends(range, availability, rows);
    await route.fulfill({
      json: {
        ...snapshot,
        mode: 'snapshot',
        cursor: 'fixture-cursor',
        removals: [],
        upserts: snapshot.points.map((point, i) => ({
          ...point,
          key: String(i),
        })),
      },
    });
  });
  await page.goto('/?chartRange=invalid');
  const summary = page.getByTestId('request-scatter-summary');
  const control = page.getByRole('button', { name: /^散点显示范围：/ });
  const pick = async (label: string) => {
    for (let i = 0; i < 3; i++) {
      if (
        (await control.getAttribute('aria-label')) ===
        `散点显示范围：${label}，点击切换`
      ) {
        return;
      }
      await control.click();
    }
    await expect(control).toHaveAccessibleName(
      `散点显示范围：${label}，点击切换`,
    );
  };
  await expect(control).toHaveAccessibleName('散点显示范围：全部，点击切换');
  await expect(summary).toContainText('可绘制 100');
  await pick('95%');
  await expect(summary).toContainText('可绘制 96');
  await expect(summary).toContainText(
    '低于下限 2 · 高于上限 2 · 下限 2 秒 · 上限 97 秒',
  );
  await expect(page.getByTestId('request-trends-summary')).toContainText(
    '总数 100',
  );
  await pick('99%');
  await expect(summary).toContainText('可绘制 100');
  await expect(summary).toContainText(
    '低于下限 0 · 高于上限 0 · 下限 0 秒 · 上限 99 秒',
  );
  await pick('全部');
  await expect(page).not.toHaveURL(/chartRange=/);
  await expect(summary).toContainText('可绘制 100');
  await expect(summary).not.toContainText('· 上限');
  await expect(summary).not.toContainText('· 下限');
});

test('chart empty, unavailable, failed and missing metric states stay distinct', async ({
  page,
}) => {
  await mock(page);
  let mode = 'error';
  await page.route('**/api/request-trends/sync?*', async (route) => {
    if (mode === 'error') {
      return route.fulfill({
        status: 503,
        json: { error: 'unavailable', message: 'Select a narrower time range' },
      });
    }
    const url = new URL(route.request().url());
    const r = {
      since: Number(url.searchParams.get('since')),
      until: Number(url.searchParams.get('until')),
    };
    const rows =
      mode === 'missing'
        ? [
            {
              ...request,
              startedAt: r.since,
              durationMs: null,
              inputTokens: null,
              totalInputTokens: null,
              cachedInputTokens: null,
              outputTokens: 0,
              tps: null,
            },
          ]
        : [];
    const snapshot = buildRequestTrends(
      r,
      { ...availability, telemetry: mode !== 'unavailable' },
      rows,
    );
    return route.fulfill({
      json: {
        ...snapshot,
        mode: 'snapshot',
        cursor: 'fixture-cursor',
        removals: [],
        upserts: snapshot.points.map((point, i) => ({
          ...point,
          key: String(i),
        })),
      },
    });
  });
  await page.goto('/?range=15m&chartMetric=invalid');
  const charts = page.getByLabel('请求趋势图表', { exact: true });
  await expect(charts).toContainText('失败');
  await expect(page.getByRole('heading', { name: '群组汇总' })).toBeVisible();
  mode = 'missing';
  await charts.getByRole('button', { name: '重试图表', exact: true }).click();
  await expect(page.getByLabel('散点纵轴指标')).toHaveValue('duration');
  await expect(page.getByTestId('request-scatter-summary')).toContainText(
    '可绘制 0',
  );
  await expect(page.getByTestId('request-scatter-summary')).toContainText(
    '缺失 1',
  );
  await page.getByLabel('散点纵轴指标').selectOption('output');
  await expect(page.getByTestId('request-scatter-summary')).toContainText(
    '可绘制 1',
  );
  mode = 'empty';
  await refreshImmediately(page);
  await expect(page.getByTestId('request-scatter-summary')).toContainText(
    '总数 0',
  );
  mode = 'unavailable';
  await refreshImmediately(page);
  await expect(charts).toContainText('不可用');
});

const requestUrl = `/requests?selected=${request.requestId}&detailGroup=10001`;
const wakeUrl = `/wakes?selected=${wake.wakeId}&detailGroup=10001`;

test('password login, session restore, no password-change UI, logout and API 401', async ({
  page,
}) => {
  await page.clock.install();
  const state: MockState = { authenticated: false };
  const { posts, requests } = await mock(page, state);
  await page.goto('/requests');
  await expect(
    page.getByRole('heading', { name: '登录', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('在此浏览器保持登录7天', { exact: false }),
  ).toBeVisible();
  await page.getByLabel('密码', { exact: true }).fill('incorrect');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('密码不正确');
  await page.getByLabel('密码', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '模型请求', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: '模型请求', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /改密码|修改密码|保存密码/ }),
  ).toHaveCount(0);
  await expect(page.getByLabel('新密码', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '登录', exact: true }),
  ).toBeVisible();
  expect(posts.find((p) => p.path.endsWith('/logout'))?.body).toEqual({});
  const loggedOutCount = requests.length;
  await page.clock.runFor(15000);
  expect(requests.length).toBe(loggedOutCount);
  await page.getByLabel('密码', { exact: true }).fill('synthetic-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '模型请求', exact: true }),
  ).toBeVisible();
  state.expired = true;
  await page.clock.runFor(5100);
  await expect(
    page.getByRole('heading', { name: '登录', exact: true }),
  ).toBeVisible();
});

for (const invalidConfig of [false, true]) {
  test(`unconfigured authentication denies access without a form (${invalidConfig ? 'invalid' : 'missing'} password)`, async ({
    page,
  }) => {
    await page.clock.install();
    const { requests } = await mock(page, { configured: false, invalidConfig });
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: '拒绝访问', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('.env');
    await expect(page.getByRole('alert')).toContainText('DASHBOARD_PASSWORD');
    await expect(page.getByRole('alert')).toContainText('重启面板');
    if (invalidConfig) {
      await expect(page.getByRole('alert')).toContainText('至少12字符');
    }
    await expect(page.locator('form')).toHaveCount(0);
    await expect(page.getByLabel('密码', { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /登录|改密码|修改密码/ }),
    ).toHaveCount(0);
    await page.clock.runFor(15000);
    expect(requests.every((url) => url.pathname.startsWith('/api/auth/'))).toBe(
      true,
    );
  });
}

for (const error of [
  'password_not_configured',
  'password_invalid_configuration',
] as const) {
  test(`business API ${error} clears authenticated content and denies access`, async ({
    page,
  }) => {
    await page.clock.install();
    const state: MockState = {};
    await mock(page, state);
    await page.goto(requestUrl);
    await expect(page.locator('.request-detail')).toContainText(
      'Synthetic Responses readable answer',
    );
    state.businessConfigError = error;
    await page.clock.runFor(5100);
    await expect(
      page.getByRole('heading', { name: '拒绝访问', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('DASHBOARD_PASSWORD');
    if (error === 'password_invalid_configuration') {
      await expect(page.getByRole('alert')).toContainText('至少12字符');
    }
    await expect(page.locator('.request-detail')).toHaveCount(0);
    await expect(
      page.getByText('Synthetic Responses readable answer', { exact: true }),
    ).toHaveCount(0);
    await expect(page.locator('form')).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: '登录', exact: true }),
    ).toHaveCount(0);
  });
}

test('compact overview has trifold token counts and factual health, never offline inference', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await mock(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '群组汇总' })).toBeVisible();
  const groupTable = page
    .locator('section.panel')
    .filter({ has: page.getByRole('heading', { name: '群组汇总' }) })
    .locator('table');
  await expect(groupTable.locator('thead th')).toHaveText([
    '群组',
    '请求',
    '成功',
    '失败 / 超时',
    '输入',
    '缓存',
    '输出',
    '缓存命中',
    'TTFT',
    'TPS',
    'P95',
  ]);
  await expect(
    groupTable.locator('tbody tr').first().locator('td'),
  ).toHaveCount(11);
  await expect(page.locator('.metric-strip')).toContainText('缓存命中');
  await expect(page.locator('.metric-strip')).toContainText('TTFT');
  await expect(page.locator('.metric-strip')).toContainText('TPS');
  await expect(page.locator('.metric-strip')).toContainText('模型累计');
  await expect(page.locator('.metric-strip')).toContainText('工具累计');
  const headers = await groupTable.locator('thead th').allTextContents();
  for (const [label, value] of <[string, string][]>[
    ['输入', '400'],
    ['缓存', '800'],
    ['输出', '160'],
    ['TTFT', '500 ms'],
    ['TPS', '40.0 tok/s'],
  ]) {
    const index = headers.indexOf(label);
    expect(index).toBeGreaterThanOrEqual(0);
    await expect(
      groupTable.locator('tbody tr').first().locator('td').nth(index),
    ).toHaveText(value);
  }
  const strip = page.getByLabel('总览汇总', { exact: true });
  await expect(strip.locator(':scope > div')).toHaveCount(11);
  await expect(
    strip
      .locator(':scope > div')
      .filter({ has: page.locator('span', { hasText: /^TTFT$/ }) })
      .locator('strong'),
  ).toHaveText('500 ms');
  await expect(
    strip
      .locator(':scope > div')
      .filter({ has: page.locator('span', { hasText: /^TPS$/ }) })
      .locator('strong'),
  ).toHaveText('40.0 tok/s');
  await expect(page.getByLabel('性能指标', { exact: true })).toHaveCount(0);
  await expect(page.getByTestId('chart-updated-at')).toHaveCount(0);
  await expect(
    page.getByText('与全局数据同步刷新。', { exact: true }),
  ).toHaveCount(0);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await strip.evaluate((el) => getComputedStyle(el).display)).toBe(
      'grid',
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    const styles = await strip.locator('strong').evaluateAll((elements) =>
      elements.map((el) => ({
        size: getComputedStyle(el).fontSize,
        weight: getComputedStyle(el).fontWeight,
      })),
    );
    expect(new Set(styles.map((s) => JSON.stringify(s))).size).toBe(1);
  }
  await expect(page.locator('.topbar')).not.toContainText('Token');
  await expect(
    page.getByRole('heading', { name: '最近运行事实' }),
  ).toBeVisible();
  await expect(page.locator('main')).toContainText('无近期活动不代表离线');
  await expect(
    page.locator('td[title="未记录或不可用，不能视为 0。"]'),
  ).toContainText('—');
  await expect(
    page.getByRole('img', { name: '每请求原始散点图', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('img', {
      name: '按时间桶的请求数量堆叠柱状图',
      exact: true,
    }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('request rows show uncached/cache/output and TTFT/TPS without adding reasoning', async ({
  page,
}) => {
  await mock(page);
  await page.goto(requestUrl);
  const row = page.locator('.list-pane tbody tr').filter({
    has: page.getByRole('button', {
      name: `查看请求 ${request.requestId}`,
      exact: true,
    }),
  });
  await expect(row.locator('td').nth(4)).toHaveText('200 / 400 / 80');
  await expect(row.locator('td').nth(5)).toHaveText('66.7%');
  await expect(row.locator('td').nth(6)).toHaveText('500 ms / 40.0');
  await expect(row.locator('td').nth(7)).toHaveText('2.00 s');
  const pane = page.locator('.request-detail');
  await expect(pane.getByRole('tablist', { name: '请求详情' })).toBeVisible();
  await expect(pane.locator('.error')).toHaveCount(0);
  await expect(pane.locator('.request-tokens')).toContainText('输入 200');
  await expect(pane.locator('.request-tokens')).toContainText('缓存 400');
  await expect(pane.locator('.request-tokens')).toContainText('输出 80');
  await expect(pane.locator('.request-tokens')).toContainText('其中推理 30');
  await expect(
    pane
      .getByLabel('性能指标')
      .locator('div')
      .filter({ hasText: 'TPS' })
      .locator('dd'),
  ).toHaveText('40.0');
  await pane.getByText('技术详情', { exact: true }).click();
  await expect(pane).toContainText('新请求');
  await expect(
    page
      .locator('.list-pane tbody tr')
      .filter({ hasText: failed.requestId })
      .locator('td')
      .nth(6),
  ).toHaveText('— / —');
});

test('requests show the configured model name, not the request model id, and filter by it', async ({
  page,
}) => {
  await mock(page);
  await page.goto('/requests');
  const cells = page.locator('.list-pane tbody td.model-cell');
  await expect(cells.first()).toHaveText('synthetic');
  await expect(page.locator('.list-pane')).not.toContainText('synthetic-model');
  const urls: string[] = [];
  page.on('request', (r) => urls.push(r.url()));
  await page.getByLabel('模型', { exact: true }).selectOption('synthetic');
  await expect(page).toHaveURL(/model=synthetic/);
  await expect
    .poll(() =>
      urls.some(
        (u) =>
          new URL(
            new URL(u).searchParams.get('resource') ?? '/',
            'http://x',
          ).searchParams.get('modelName') === 'synthetic',
      ),
    )
    .toBe(true);
  await page.goto('/');
  const models = page
    .locator('section.panel')
    .filter({ has: page.getByRole('heading', { name: '模型汇总' }) });
  await expect(
    models.getByRole('link', { name: 'synthetic', exact: true }),
  ).toBeVisible();
});

test('cancellation diagnostics stay collapsed and expose only recorded Chinese facts', async ({
  page,
}) => {
  await mock(page);
  await page.route(
    (url) => effectiveApiUrl(url).pathname === '/api/requests/req-synthetic-2',
    async (route) => {
      const record = detail(request.requestId);
      record.request = {
        ...record.request,
        outcome: 'cancelled',
        status: 'cancelled',
        diagnostics: {
          abortSource: 'turn_timeout',
          failureStage: 'response_body',
          requestTimeoutMs: 12000,
          providerCategory: 'previous_response_missing',
          providerParameter: 'previous_response_id',
        },
      };
      await route.fulfill({ json: snapshot(record) });
    },
  );
  await page.goto(requestUrl);
  const pane = page.locator('.request-detail');
  await expect(
    pane.getByText('整轮时间上限', { exact: true }),
  ).not.toBeVisible();
  await pane.getByText('技术详情', { exact: true }).click();
  for (const text of [
    '取消原因',
    '整轮时间上限',
    '失败阶段',
    '读取响应',
    '请求时限',
    '12.00 s',
    '服务商错误类别',
    '前序响应不存在',
    '关联参数',
    'previous_response_id',
  ]) {
    await expect(pane.getByText(text, { exact: true })).toBeVisible();
  }
  await expect(pane).not.toContainText('abortSource');
});

test('request chain navigation and genuine error diagnostics', async ({
  page,
}) => {
  const { requests } = await mock(page);
  await page.goto(requestUrl);
  await page.getByRole('link', { name: '← 前序响应' }).click();
  await expect(page).toHaveURL(/selected=req-synthetic-1/);
  await expect(page.getByRole('link', { name: '← 前序响应' })).toHaveCount(0);
  await page.getByRole('link', { name: '后续响应 →', exact: true }).click();
  await expect(page).toHaveURL(/selected=req-synthetic-2/);
  await page.getByRole('link', { name: '后续响应 →', exact: true }).click();
  await expect(page).toHaveURL(/selected=req-synthetic-3/);
  await expect(page.locator('.request-detail')).toContainText('429');
  await expect(
    page.getByRole('region', { name: '错误详情', exact: true }),
  ).toContainText('Synthetic rate limit provider detail');
  expect(
    requests
      .filter((u) => u.pathname.startsWith('/api/requests/'))
      .every((u) => u.searchParams.get('groupId') === '10001'),
  ).toBe(true);
});

test('reasoning and tool bodies support search, highlighted text and copying actual content', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mock(page, { dense: true });
  await page.goto(requestUrl);
  await page.getByRole('tab', { name: '思考', exact: true }).click();
  const reasoning = page.getByRole('region', { name: '思考', exact: true });
  await expect(reasoning).toContainText('Synthetic reasoning first line');
  await reasoning.getByLabel('搜索思考', { exact: true }).fill('needle');
  await expect(reasoning).toContainText('1 行匹配');
  await expect(reasoning).not.toContainText('Synthetic reasoning first line');
  await reasoning.getByRole('button', { name: '复制全文' }).click();
  await expect(reasoning.getByRole('status')).toHaveText('已复制');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    detail(request.requestId).reasoningText,
  );
  await page.getByRole('tab', { name: /^工具/ }).click();
  await page
    .locator('.tool-detail')
    .getByRole('button', { name: '原始数据', exact: true })
    .click();
  const args = page.getByRole('region', { name: '工具参数', exact: true });
  await expect(args).toContainText('synthetic needle');
  await args.getByLabel('搜索工具参数').fill('needle');
  await expect(args).toContainText('1 行匹配');
  await args.getByRole('button', { name: '复制全文' }).click();
  expect(
    JSON.parse(await page.evaluate(() => navigator.clipboard.readText())),
  ).toEqual(tool.arguments);
  const result = page.getByRole('region', { name: '工具结果', exact: true });
  await expect(result).toContainText('synthetic result body');
  await args.getByLabel('搜索工具参数').fill('');
  await expect(args).toBeInViewport({ ratio: 1 });
  await expect(result).toBeInViewport({ ratio: 1 });
  expect(
    await page.locator('.request-detail').evaluate((element) => {
      let ancestor: HTMLElement | null = element as HTMLElement;
      while (ancestor) {
        if (ancestor.scrollTop > 0) {
          return false;
        }
        ancestor = ancestor.parentElement;
      }
      return true;
    }),
  ).toBe(true);
  await mkdir(resolve('artifacts'), { recursive: true });
  await page.screenshot({
    path: resolve('artifacts/dashboard-review-tools.png'),
    fullPage: true,
  });
  await page.getByRole('tab', { name: '请求正文', exact: true }).click();
  await expect(
    page.getByRole('tabpanel', { name: '请求正文', exact: true }),
  ).toContainText('Synthetic request prompt');
});

for (const protocol of [
  {
    name: 'Responses',
    id: request.requestId,
    answer: 'Synthetic Responses readable answer',
    envelope: 'resp-synthetic-2',
    args: 'synthetic needle',
  },
  {
    name: 'Chat',
    id: previous.requestId,
    answer: 'Synthetic Chat readable answer',
    envelope: 'chatcmpl-synthetic-1',
    args: 'synthetic chat query',
  },
]) {
  test(`${protocol.name} protocol bodies default to readable prose and retain raw envelopes`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await mock(page, { dense: true });
    await page.goto(`/requests?selected=${protocol.id}&detailGroup=10001`);
    const output = page.getByRole('tabpanel', { name: '输出', exact: true });
    await expect(
      output.getByRole('region', { name: '模型正文', exact: true }),
    ).toContainText(protocol.answer);
    await expect(
      output.getByRole('heading', { name: /^提出调用 read_events/ }),
    ).toBeVisible();
    await expect(output).not.toContainText('工具名称');
    await expect(output).toContainText(protocol.args);
    if (protocol.name === 'Responses') {
      await mkdir(resolve('artifacts'), { recursive: true });
      await page.screenshot({
        path: resolve('artifacts/dashboard-review-reading.png'),
        fullPage: true,
      });
    }
    await output.getByRole('button', { name: '原始JSON', exact: true }).click();
    const raw = output.getByRole('region', { name: '原始JSON', exact: true });
    await expect(raw).toContainText(protocol.envelope);
    await expect(raw).toContainText(
      protocol.name === 'Chat' ? 'tool_calls' : 'function_call',
    );
    await expect(raw).toContainText(protocol.answer);
    await output.getByRole('button', { name: '阅读', exact: true }).click();
    await expect(
      output.getByRole('region', { name: '模型正文', exact: true }),
    ).toContainText(protocol.answer);
    await page.getByRole('tab', { name: '请求正文', exact: true }).click();
    const body = page.getByRole('tabpanel', { name: '请求正文', exact: true });
    await expect(body).toContainText('Synthetic request prompt');
    await expect(
      body.getByText('Synthetic system instructions', { exact: true }),
    ).not.toBeVisible();
    await expect(
      body.getByText('Synthetic tool definition', { exact: false }),
    ).not.toBeVisible();
    await body.locator('summary').filter({ hasText: '系统指令' }).click();
    await expect(
      body.getByText('Synthetic system instructions', { exact: true }),
    ).toBeVisible();
    await body.locator('summary').filter({ hasText: '工具定义' }).click();
    const definitions = body.getByRole('region', {
      name: '工具定义',
      exact: true,
    });
    await expect(definitions).toBeVisible();
    await expect(definitions).toContainText('Synthetic tool definition');
    await body.getByRole('button', { name: '原始JSON', exact: true }).click();
    await expect(
      body.getByRole('region', { name: '原始JSON', exact: true }),
    ).toContainText('synthetic-model');
  });
}

test('continued request shows only actual incremental input rather than fabricated history', async ({
  page,
}) => {
  await mock(page, { continuation: true });
  await page.goto(requestUrl);
  await page.getByRole('tab', { name: '请求正文', exact: true }).click();
  const body = page.getByRole('tabpanel', { name: '请求正文', exact: true });
  await expect(body).toContainText('本次续接仅显示实际发送的增量内容');
  await expect(body).toContainText('Synthetic incremental tool output');
  await expect(body).not.toContainText('Synthetic request prompt');
  await expect(body).not.toContainText('Synthetic system instructions');
});

test('historical session fallback is not described as an actual request snapshot', async ({
  page,
}) => {
  await mock(page);
  await page.route(
    (url) => effectiveApiUrl(url).pathname === '/api/requests/req-synthetic-2',
    async (route) => {
      const record = detail(request.requestId);
      record.request = { ...record.request, requestMode: 'continue_restored' };
      record.requestBody = {
        source: 'persisted_session_context',
        messages: [
          { role: 'user', content: 'Synthetic historical session message' },
        ],
      };
      await route.fulfill({ json: snapshot(record) });
    },
  );
  await page.goto(requestUrl);
  await page.getByRole('tab', { name: '请求正文', exact: true }).click();
  const body = page.getByRole('tabpanel', { name: '请求正文', exact: true });
  await expect(body).toContainText('历史会话记录，非当时完整请求快照');
  await expect(body).toContainText('Synthetic historical session message');
  await expect(body).not.toContainText('本次续接仅显示实际发送的增量内容');
});

test('wake process, conversation, requests and events preserve associations', async ({
  page,
}) => {
  await mock(page);
  await page.goto(wakeUrl);
  const pane = page.locator('.wake-detail');
  await expect(pane.getByRole('heading', { name: '唤醒详情' })).toBeVisible();
  await expect(pane.locator('.process-list > li')).toHaveCount(4);
  await expect(pane.locator('.tool-detail')).toContainText('read_events');
  await pane.getByRole('tab', { name: '对话', exact: true }).click();
  await expect(pane).toContainText('Synthetic user question');
  await expect(pane).toContainText('Synthetic assistant response');
  await expect(pane.getByRole('link', { name: '关联请求' })).toHaveAttribute(
    'href',
    /selected=req-synthetic-2/,
  );
  await pane.getByRole('tab', { name: '模型请求', exact: true }).click();
  await expect(pane.locator('tbody tr')).toHaveCount(3);
  await pane.getByRole('tab', { name: '事件', exact: true }).click();
  await expect(pane).toContainText('Synthetic operation submitted');
  await pane.getByRole('tab', { name: '对话', exact: true }).click();
  await pane.getByRole('link', { name: '关联请求' }).click();
  await expect(page).toHaveURL(/\/requests\?.*selected=req-synthetic-2/);
  await expect(page.locator('.request-detail')).toBeVisible();
});

test('wake tokens keep uncached input and cache separate and outcome filters use persisted values', async ({
  page,
}) => {
  const { requests } = await mock(page);
  await page.goto('/wakes');
  const table = page.locator('.list-pane table');
  await expect(table.locator('tbody tr')).toHaveCount(1);
  const headers = await table.locator('thead th').allTextContents();
  const index = headers
    .map((header) => header.trim())
    .indexOf('输入 / 缓存 / 输出');
  expect(index).toBeGreaterThanOrEqual(0);
  await expect(
    table.locator('tbody tr').first().locator('td').nth(index),
  ).toHaveText('400 / 800 / 160');
  const filter = page.getByLabel('状态', { exact: true });
  await expect(filter.locator('option[value="replied"]')).toHaveText('已回复');
  await expect(filter.locator('option[value="silent"]')).toHaveText('主动结束');
  await expect(filter.locator('option[value="finish"]')).toHaveCount(0);
  for (const outcome of ['replied', 'silent']) {
    await filter.selectOption(outcome);
    await expect(page).toHaveURL(new RegExp(`outcome=${outcome}`));
    await expect
      .poll(() =>
        requests.some(
          (url) =>
            url.pathname === '/api/wakes' &&
            url.searchParams.get('outcome') === outcome,
        ),
      )
      .toBe(true);
  }
});

test('missing wake token components remain dash instead of inferred zero or total input', async ({
  page,
}) => {
  await mock(page, { wakeVariant: 'missing' });
  await page.goto('/wakes');
  const table = page.locator('.list-pane table');
  await expect(table.locator('tbody tr')).toHaveCount(1);
  const headers = await table.locator('thead th').allTextContents();
  const index = headers
    .map((header) => header.trim())
    .indexOf('输入 / 缓存 / 输出');
  expect(index).toBeGreaterThanOrEqual(0);
  await expect(
    table.locator('tbody tr').first().locator('td').nth(index),
  ).toHaveText('— / — / 160');
});

test('unfinished wake shows running in both list and detail without claiming completion', async ({
  page,
}) => {
  await mock(page, { wakeVariant: 'running' });
  await page.goto(wakeUrl);
  await expect(page.locator('.list-pane tbody tr .badge')).toHaveText('执行中');
  await expect(
    page.locator('.wake-detail .detail-heading > .badge'),
  ).toHaveText('执行中');
  await expect(
    page.locator('.wake-detail dt').filter({ hasText: '结束时间' }),
  ).toHaveCount(0);
  await page.getByLabel('状态', { exact: true }).selectOption('running');
  await expect(page).toHaveURL(/outcome=running/);
  await expect(page.locator('.list-pane tbody tr .badge')).toHaveText('执行中');
});

test('global search, group, outcome, cursor and refresh retain server filters', async ({
  page,
}) => {
  const { requests } = await mock(page);
  await page.goto('/requests');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect
    .poll(() =>
      requests.some((u) => u.searchParams.get('cursor') === 'synthetic-next'),
    )
    .toBe(true);
  await page.getByLabel('群组', { exact: true }).selectOption('10001');
  await page.getByLabel('状态', { exact: true }).selectOption('failed');
  await page.getByLabel('搜索记录', { exact: true }).fill('req-synthetic-3');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page).toHaveURL(/q=req-synthetic-3/);
  await expect(page.locator('.list-pane tbody tr')).toHaveCount(1);
  await expect
    .poll(() =>
      requests.some(
        (u) =>
          u.pathname === '/api/requests' &&
          u.searchParams.get('groupId') === '10001' &&
          u.searchParams.get('outcome') === 'failed' &&
          u.searchParams.get('q') === failed.requestId &&
          !u.searchParams.has('cursor'),
      ),
    )
    .toBe(true);
  const count = requests.length;
  await refreshImmediately(page);
  await expect.poll(() => requests.length).toBeGreaterThan(count);
});

test('automatic polling and re-enabling refresh retain the current pagination cursor', async ({
  page,
}) => {
  await page.clock.install();
  const { requests } = await mock(page);
  await page.goto('/requests');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await expect
    .poll(() =>
      requests
        .filter((u) => u.pathname === '/api/requests')
        .at(-1)
        ?.searchParams.get('cursor'),
    )
    .toBe('synthetic-next');
  await expect(
    page.getByRole('button', { name: '下一页', exact: true }),
  ).toBeDisabled();
  const count = () =>
    requests.filter((u) => u.pathname === '/api/requests').length;
  const initial = count();
  await page.clock.runFor(5100);
  await expect.poll(count).toBe(initial + 1);
  await refreshImmediately(page);
  await expect.poll(count).toBe(initial + 2);
  await expect
    .poll(() =>
      requests
        .filter((u) => u.pathname === '/api/requests')
        .at(-1)
        ?.searchParams.get('cursor'),
    )
    .toBe('synthetic-next');
  expect(
    requests
      .filter((u) => u.pathname === '/api/requests')
      .slice(-2)
      .every((u) => u.searchParams.get('cursor') === 'synthetic-next'),
  ).toBe(true);
});

test('resource patches and unchanged preserve selected detail, tab, search and scroll', async ({
  page,
}) => {
  await page.clock.install();
  await mock(page);
  const calls: URL[] = [];
  const text = Array.from(
    { length: 150 },
    (_, i) => `needle reasoning line ${i}`,
  ).join('\n');
  await page.route(
    (url) => effectiveApiUrl(url).pathname === '/api/requests/req-synthetic-2',
    async (route) => {
      calls.push(new URL(route.request().url()));
      const index = calls.length;
      await route.fulfill({
        json:
          index === 1
            ? {
                ...snapshot({
                  ...detail(request.requestId),
                  reasoningText: text,
                }),
                cursor: 'detail-v1',
              }
            : index === 2
              ? {
                  mode: 'patch',
                  cursor: 'detail-v2',
                  patch: [
                    {
                      op: 'replace',
                      path: '/reasoningText',
                      value: `${text}\nneedle patched final line`,
                    },
                  ],
                }
              : { mode: 'unchanged', cursor: 'detail-v2' },
      });
    },
  );
  await page.goto(requestUrl);
  await page.getByRole('tab', { name: '思考', exact: true }).click();
  const region = page.getByRole('region', { name: '思考', exact: true });
  await region.getByLabel('搜索思考', { exact: true }).fill('needle');
  const scroll = page.locator('.detail-scroll');
  await scroll.evaluate((element) => {
    element.scrollTop = 180;
  });
  const top = await scroll.evaluate((element) => element.scrollTop);
  expect(top).toBeGreaterThan(0);
  await page.clock.runFor(5100);
  await expect(region).toContainText('needle patched final line');
  expect(calls[1]!.searchParams.get('cursor')).toBe('detail-v1');
  await page.clock.runFor(5100);
  await expect.poll(() => calls.length).toBe(3);
  expect(calls[2]!.searchParams.get('cursor')).toBe('detail-v2');
  await expect(page).toHaveURL(/selected=req-synthetic-2/);
  await expect(
    page.getByRole('tab', { name: '思考', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  expect(await scroll.evaluate((element) => element.scrollTop)).toBe(top);
  await expect(region.getByLabel('搜索思考', { exact: true })).toHaveValue(
    'needle',
  );
  await expect(region).toContainText('needle patched final line');
});

test('transient polling errors retain the last list and recover automatically', async ({
  page,
}) => {
  await page.clock.install();
  const state: MockState = {};
  await mock(page, state);
  await page.goto('/requests');
  await expect(page.locator('.list-pane tbody tr')).toHaveCount(3);
  state.fail = true;
  await page.clock.runFor(5100);
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('.list-pane tbody tr')).toHaveCount(3);
  state.fail = false;
  // 刷新失败后先退避，再尝试下一次自动刷新。
  await page.clock.runFor(10100);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.list-pane tbody tr')).toHaveCount(3);
});

for (const status of [401, 404]) {
  test(`automatic detail refresh clears cached sensitive content on ${status}`, async ({
    page,
  }) => {
    await page.clock.install();
    await mock(page);
    let expired = false;
    await page.route(
      (url) =>
        effectiveApiUrl(url).pathname === '/api/requests/req-synthetic-2',
      (route) =>
        route.fulfill(
          expired
            ? {
                status,
                json: { error: status === 401 ? 'unauthorized' : 'not_found' },
              }
            : { json: snapshot(detail(request.requestId)) },
        ),
    );
    await page.goto(requestUrl);
    await page.getByRole('tab', { name: '思考', exact: true }).click();
    await expect(
      page.getByText('Synthetic reasoning first line', { exact: false }),
    ).toBeVisible();
    expired = true;
    await page.clock.runFor(5100);
    await expect(
      page.getByText('Synthetic reasoning first line', { exact: false }),
    ).toHaveCount(0);
    if (status === 401) {
      await expect(page.getByLabel('密码', { exact: true })).toBeVisible();
    } else {
      await expect(page.getByRole('alert')).toBeVisible();
    }
  });
}

test('failed loading can retry and empty lists have no fabricated records', async ({
  page,
}) => {
  const state: MockState = { fail: true, empty: true };
  await mock(page, state);
  await page.goto('/requests');
  await expect(page.getByRole('alert')).toBeVisible();
  state.fail = false;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByText('此范围没有记录', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '下一页', exact: true }),
  ).toBeDisabled();
  await expect(page.locator('.list-pane tbody tr')).toHaveCount(0);
});

test('aggregate tools expose metadata and review links rather than invented bodies', async ({
  page,
}) => {
  await mock(page);
  await page.goto('/tools');
  await expect(page.locator('main tbody tr')).toHaveCount(1);
  await expect(page.locator('main tbody tr')).toContainText('read_events');
  await expect(page.locator('main tbody tr td').last()).toHaveText('—');
  await expect(
    page.getByRole('link', { name: '逐次调用复盘 →' }),
  ).toHaveAttribute('href', '/wakes');
  await expect(page.locator('main .tool-detail')).toHaveCount(0);
});

test('event category and metadata search preserve URL and link the actual turn to requests', async ({
  page,
}) => {
  const { requests } = await mock(page);
  await page.goto('/events');
  await expect(
    page.getByRole('heading', { name: '事件', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.events-table tbody tr')).toHaveCount(2);
  await expect(page.locator('.events-table')).toContainText('全局');
  await page.getByLabel('事件分类', { exact: true }).selectOption('model');
  await expect(page).toHaveURL(/category=model/);
  await page.getByLabel('搜索记录', { exact: true }).fill('turn-synthetic');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(page).toHaveURL(/q=turn-synthetic/);
  await expect(page.locator('.events-table tbody tr')).toHaveCount(1);
  await expect
    .poll(() =>
      requests.some(
        (url) =>
          url.pathname === '/api/events' &&
          url.searchParams.get('category') === 'model' &&
          url.searchParams.get('q') === 'turn-synthetic',
      ),
    )
    .toBe(true);
  await page
    .getByText('Synthetic model response observed', { exact: true })
    .click();
  const content = page.getByRole('region', { name: '事件详情', exact: true });
  await expect(content).toContainText('synthetic fixture');
  await content
    .getByLabel('搜索事件详情', { exact: true })
    .fill('outputTokens');
  await expect(content).toContainText('1 行匹配');
  await page.getByRole('link', { name: '查找请求', exact: true }).click();
  await expect(page).toHaveURL(/\/requests\?/);
  expect(new URL(page.url()).searchParams.get('q')).toBe('turn-synthetic');
  expect(new URL(page.url()).searchParams.get('group')).toBe('10001');
  expect(new URL(page.url()).searchParams.has('category')).toBe(false);
  await expect(page.locator('.list-pane tbody tr')).toHaveCount(3);
});

// 浏览器始终处于真正不安全的非回环origin。只有静态资源会到达Vite；
// API请求单独拦截，永远读不到本地生产数据。
async function insecureDashboard(page: Page) {
  await page.route('http://dashboard.example/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) {
      return route.fulfill({
        status: 500,
        json: { error: 'unmocked_synthetic_api' },
      });
    }
    const response = await route.fetch({
      url: `http://127.0.0.1:5175${url.pathname}${url.search}`,
    });
    await route.fulfill({ response });
  });
  await mock(page);
  await page.route(
    (url) =>
      url.origin === 'http://dashboard.example' &&
      effectiveApiUrl(url).pathname === '/api/requests/req-synthetic-2',
    (route) =>
      route.fulfill({
        json: snapshot({
          ...detail(request.requestId),
          reasoningText: largeCopyText,
        }),
      }),
  );
  await page.goto(`http://dashboard.example${requestUrl}`);
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  expect(await page.evaluate(() => typeof navigator.clipboard)).toBe(
    'undefined',
  );
  await page.getByRole('tab', { name: '思考', exact: true }).click();
  const region = page.getByRole('region', { name: '思考', exact: true });
  await region.getByLabel('搜索思考', { exact: true }).fill('needle');
  await expect(region).toContainText('1 行匹配');
  await expect(region).not.toContainText('中文开头');
  return region;
}

const largeCopyText = `中文开头：完整正文不可被搜索截断\n${'大段合成文本，保留换行和标点。\n'.repeat(3000)}needle 唯一匹配行\n中文结尾`;

test('insecure HTTP uses native execCommand and copies the full filtered text', async ({
  page,
  context,
}) => {
  const region = await insecureDashboard(page);
  await page.evaluate(() => {
    const original = document.execCommand.bind(document);
    Object.defineProperty(window, '__copyCalls', { value: [] });
    document.execCommand = (command: string) => {
      const active = document.activeElement as HTMLTextAreaElement;
      (window as unknown as { __copyCalls: unknown[] }).__copyCalls.push({
        command,
        text: active.value,
        selected: active.selectionEnd! - active.selectionStart!,
        activation: navigator.userActivation.isActive,
      });
      return original(command);
    };
  });
  await region.getByRole('button', { name: '复制全文', exact: true }).click();
  await expect(region.getByRole('status')).toHaveText('已复制');
  expect(
    await page.evaluate(
      () => (window as unknown as { __copyCalls: unknown[] }).__copyCalls,
    ),
  ).toEqual([
    {
      command: 'copy',
      text: largeCopyText,
      selected: largeCopyText.length,
      activation: true,
    },
  ]);
  // 通过完全合成的可信文档读回，不发起网络请求。
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: 'https://clipboard.example',
  });
  const reader = await context.newPage();
  await reader.route('https://clipboard.example/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Synthetic clipboard reader</title>',
    }),
  );
  await reader.goto('https://clipboard.example/clipboard-reader');
  expect(await reader.evaluate(() => navigator.clipboard.readText())).toBe(
    largeCopyText,
  );
  await reader.close();
});

for (const mode of ['api-rejection', 'manual'] as const) {
  test(`insecure HTTP ${mode} preserves full selectable Chinese multiline text`, async ({
    page,
  }) => {
    const region = await insecureDashboard(page);
    await page.evaluate((mode) => {
      const calls: unknown[] = [];
      Object.defineProperty(window, '__copyCalls', { value: calls });
      if (mode === 'api-rejection') {
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: (text: string) => {
              calls.push({ api: text });
              return Promise.reject(
                new DOMException('Synthetic denial', 'NotAllowedError'),
              );
            },
          },
        });
      }
      document.execCommand = (command: string) => {
        const active = document.activeElement as HTMLTextAreaElement;
        calls.push({
          command,
          text: active.value,
          selected: active.selectionEnd! - active.selectionStart!,
        });
        return mode !== 'manual';
      };
    }, mode);
    await region.getByRole('button', { name: '复制全文', exact: true }).click();
    if (mode === 'api-rejection') {
      await expect(region.getByRole('status')).toHaveText('已复制');
      expect(
        await page.evaluate(
          () => (window as unknown as { __copyCalls: unknown[] }).__copyCalls,
        ),
      ).toEqual([
        { api: largeCopyText },
        {
          command: 'copy',
          text: largeCopyText,
          selected: largeCopyText.length,
        },
      ]);
    } else {
      await expect(region.getByRole('status')).toHaveText(
        '自动复制失败，请手动复制下方完整文本',
      );
      const manual = region.getByRole('textbox', {
        name: '待手动复制的完整文本',
        exact: true,
      });
      await expect(manual).toBeVisible();
      await expect(manual).toHaveValue(largeCopyText);
      await expect(manual).toHaveAttribute('readonly', '');
      await expect(manual).toBeFocused();
      expect(
        await manual.evaluate((element: HTMLTextAreaElement) => [
          element.selectionStart,
          element.selectionEnd,
        ]),
      ).toEqual([0, largeCopyText.length]);
      await region
        .getByRole('button', { name: '全选文本', exact: true })
        .click();
      expect(
        await manual.evaluate((element: HTMLTextAreaElement) =>
          element.value.slice(element.selectionStart, element.selectionEnd),
        ),
      ).toBe(largeCopyText);
      await page.keyboard.press('Escape');
      await expect(manual).toHaveCount(0);
      await expect(page).toHaveURL(/selected=req-synthetic-2/);
    }
  });
}

test('clipboard fallback restores focus, backward selection and nested scroll even on failure', async ({
  page,
}) => {
  await insecureDashboard(page);
  const result = await page.evaluate(async () => {
    const modulePath = '/src/components/review/clipboard.ts';
    const { copyText } = await import(modulePath);
    const container = document.createElement('div');
    container.style.cssText =
      'position:fixed;inset:0 auto auto 0;width:150px;height:80px;overflow:auto;';
    const input = document.createElement('textarea');
    input.value = '中文原始选择\n第二行';
    input.style.cssText =
      'display:block;margin-top:180px;margin-bottom:180px;height:50px;';
    container.append(input);
    document.body.append(container);
    input.focus();
    input.setSelectionRange(1, 6, 'backward');
    container.scrollTop = 150;
    const before = { top: container.scrollTop, x: scrollX, y: scrollY };
    const original = document.execCommand;
    document.execCommand = () => {
      container.scrollTop = 0;
      throw new Error('synthetic copy failure');
    };
    const success = await copyText('中文复制\n完整全文');
    const result = {
      success,
      focused: document.activeElement === input,
      selection: [
        input.selectionStart,
        input.selectionEnd,
        input.selectionDirection,
      ],
      scroll: { top: container.scrollTop, x: scrollX, y: scrollY },
      before,
      leaked: document.querySelectorAll('textarea[tabindex="-1"]').length,
    };
    document.execCommand = original;
    container.remove();
    return result;
  });
  expect(result.success).toBe(false);
  expect(result.focused).toBe(true);
  expect(result.selection).toEqual([1, 6, 'backward']);
  expect(result.scroll).toEqual(result.before);
  expect(result.leaked).toBe(0);
});

test('mobile multi-day lists distinguish identical clock times and retain visible metrics', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mock(page);
  for (const kind of ['requests', 'wakes'] as const) {
    const first = kind === 'requests' ? request : wake;
    await page.route(
      (url) => effectiveApiUrl(url).pathname === `/api/${kind}`,
      (route) =>
        route.fulfill({
          json: snapshot({
            range,
            availability,
            nextCursor: null,
            items: [
              first,
              {
                ...first,
                requestId: 'req-other-day',
                wakeId: 'wake-other-day',
                startedAt: first.startedAt - 86400000,
              },
            ],
          }),
        }),
    );
    await page.goto(`/${kind}?range=7d`);
    const times = page.locator('.list-pane .row-link .mobile-label');
    await expect(times).toHaveCount(2);
    const labels = await times.allTextContents();
    expect(labels[0]).toMatch(/^9\/21 \d{2}:\d{2}:\d{2}$/);
    expect(labels[1]).toMatch(/^9\/20 \d{2}:\d{2}:\d{2}$/);
    expect(labels[0]!.split(' ')[1]).toBe(labels[1]!.split(' ')[1]);
    await expect(times.first()).toHaveAttribute('title', /2026/);
    for (const column of ['cache-column', 'tps-column', 'duration-column']) {
      const box = await page
        .locator(`.list-pane tbody tr:first-child .${column}`)
        .boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(390);
    }
  }
});

for (const viewport of [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`${viewport.name} compact review layout and synthetic screenshot`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await mock(page, { dense: true });
    await mkdir(resolve('artifacts'), { recursive: true });
    for (const [name, url, ready] of <[string, string, string][]>[
      ['overview', '/', '.metric-strip'],
      ['wakes', '/wakes', '.list-pane tbody tr'],
      ['requests', '/requests', '.list-pane tbody tr'],
      ['tools', '/tools', 'main tbody tr'],
      ['events', '/events', '.events-table tbody tr'],
      ['wake-detail', wakeUrl, '.wake-detail'],
      ['request-detail', requestUrl, '.request-detail'],
    ]) {
      await page.goto(url);
      await expect(page.locator(ready).first()).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
        `${name}: viewport overflow`,
      ).toBe(true);
      if (
        viewport.name === 'mobile' &&
        (name === 'requests' || name === 'wakes')
      ) {
        for (const column of [
          'cache-column',
          'tps-column',
          'duration-column',
        ]) {
          const cell = page.locator(
            `.list-pane tbody tr:first-child .${column}`,
          );
          await expect(cell).toBeVisible();
          const box = await cell.boundingBox();
          expect(box!.x, `${name}: ${column} left edge`).toBeGreaterThanOrEqual(
            0,
          );
          expect(
            box!.x + box!.width,
            `${name}: ${column} visible without horizontal scrolling`,
          ).toBeLessThanOrEqual(390);
        }
        await expect(
          page.locator('.list-pane tbody tr:first-child .mobile-tokens'),
        ).toBeVisible();
        await expect(
          page.locator('.list-pane tbody tr:first-child .record-id'),
        ).toBeHidden();
      }
      const nestedScrollers = await page
        .locator('main *')
        .evaluateAll((elements) =>
          elements
            .filter((element) => {
              const style = getComputedStyle(element);
              const scrolls =
                element.clientHeight > 0 &&
                element.scrollHeight > element.clientHeight + 1 &&
                /^(auto|scroll)$/.test(style.overflowY);
              // 列表和详情是并列的主滚动容器，而不是嵌套的正文滚动区。
              return (
                scrolls &&
                !element.matches('.list-pane > .table-wrap, .detail-scroll')
              );
            })
            .map((element) => `${element.tagName}.${element.className}`),
        );
      expect(
        nestedScrollers,
        `${name}: content should use document scrolling`,
      ).toEqual([]);
      await page.screenshot({
        path: resolve(`artifacts/dashboard-${name}-${viewport.name}.png`),
        fullPage: true,
      });
    }
    await expect(page.locator('.list-pane tbody tr')).toHaveCount(16);
    await expect(page.locator('.request-detail')).toBeVisible();
    await expect(page.getByLabel('Token统计')).toHaveCount(0);
    if (viewport.name === 'desktop') {
      const bounds = await page
        .getByRole('tablist', { name: '请求详情', exact: true })
        .boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.y).toBeLessThanOrEqual(360);
    }
    await page.getByRole('tab', { name: '思考', exact: true }).click();
    await expect(
      page.getByRole('region', { name: '思考', exact: true }),
    ).toContainText('needle reasoning');
    await expect(page.getByLabel('搜索记录')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBe(true);
    await mkdir(resolve('artifacts'), { recursive: true });
    await page.screenshot({
      path: resolve(`artifacts/dashboard-review-${viewport.name}.png`),
      fullPage: true,
    });
    await page.keyboard.press('Escape');
    await expect(page).not.toHaveURL(/selected=/);
    await expect(page.locator('.request-detail')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

test('javascript tools show folded code, raw or JSON return values and failures', async ({
  page,
}) => {
  const code = Array.from(
    { length: 30 },
    (_, i) => `const line${i} = ${i}; // 第${i}行`,
  ).join('\n');
  const art = '  *  \n ***\n*****';
  const script = (ordinal: number, args: unknown, result: unknown) => ({
    ...tool,
    ordinal,
    callId: `call-js-${ordinal}`,
    name: 'execute_javascript',
    arguments: args,
    result,
  });
  const tools: ReviewTool[] = [
    script(
      1,
      { description: '画字符画', code, mode: 'sync', wait_ms: 5000 },
      {
        job_id: 'js_1',
        value: art,
        logs: [],
        tool_calls: {
          counts: { create_image: { ok: 1 } },
          abnormal: [],
          abnormal_omitted: 0,
        },
        status: 'ok',
        task_status: 'completed',
      },
    ),
    script(
      2,
      {
        description: '返回对象',
        code: 'return JSON.stringify({a:1})',
        mode: 'sync',
      },
      {
        job_id: 'js_2',
        value: '{"artifact":"a.png"}',
        logs: [],
        status: 'ok',
        task_status: 'completed',
      },
    ),
    script(
      3,
      { description: '会失败', code: 'x()', mode: 'sync' },
      {
        job_id: 'js_3',
        error: 'execution_error',
        logs: [],
        diagnostic: {
          name: 'TypeError',
          message: 'x is not a function',
          stack: 'TypeError: x is not a function\n    at main (job.js:1:1)',
          truncated: false,
          kind: 'guest_exception',
          phase: 'execute',
        },
        status: 'error',
        task_status: 'failed',
      },
    ),
    script(
      4,
      { description: '后台跑', code: 'await sleep(1)', mode: 'async' },
      { status: 'pending', job_id: 'js_4' },
    ),
  ];
  await mock(page, { tools });
  await page.goto(wakeUrl);
  const items = page.locator('.wake-detail .tool-detail');
  await expect(items).toHaveCount(4);
  const first = items.nth(0);
  await expect(first).toContainText('画字符画');
  await expect(first).toContainText('同步');
  await expect(first).toContainText('最多等待 5 秒，超时终止');
  await expect(first).not.toContainText('约 ');
  await expect(first).not.toContainText('已到预计时限');
  await expect(first).toContainText('create_image ×1');
  const codeBlock = first.getByLabel('代码', { exact: true });
  const folded = (await codeBlock.boundingBox())!.height;
  await expect(codeBlock).toContainText('line0');
  await first.getByRole('button', { name: '展开全部' }).first().click();
  expect((await codeBlock.boundingBox())!.height).toBeGreaterThan(folded * 1.8);
  await expect(codeBlock.locator('.keyword').first()).toHaveText('const');
  // 普通字符串返回值原样显示，保留空格与换行。
  const value = first.getByLabel('返回值', { exact: true });
  expect(await value.textContent()).toBe(art);
  await expect(first.locator('.script-label .badge')).toHaveCount(0);
  const second = items.nth(1);
  await expect(second.locator('.script-label .badge')).toHaveText('JSON');
  await expect(
    second.getByLabel('返回值', { exact: true }).locator('.key'),
  ).toHaveText('"artifact"');
  const third = items.nth(2);
  await expect(third).toContainText('TypeError: x is not a function');
  await expect(third.getByLabel('调用栈')).toHaveCount(0);
  await third.getByRole('button', { name: '调用栈' }).click();
  await expect(third.getByLabel('调用栈')).toContainText('at main');
  await expect(items.nth(3)).toContainText('任务 IDjs_4');
  await expect(items.nth(3).locator('.tool-evidence')).toContainText(
    '已返回后台句柄，任务未确认完成',
  );
  await expect(items.nth(3)).toContainText('异步');
  await expect(items.nth(3).locator('p.error')).toHaveCount(0);
});

test('javascript internal non-success details stay distinct, local and safe on mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  const rawError = `<img src=x onerror="window.__internalCallExecuted=true"><script>window.__internalCallExecuted=true</script>${'long-error-'.repeat(80)}`;
  const abnormal = Array.from({ length: 8 }, (_, index) => ({
    seq: index + 1,
    tool: `internal_tool_${index + 1}`,
    status:
      index === 1 ? 'unknown' : index === 2 ? 'confirmation_required' : 'error',
    error: index === 0 ? rawError : `original-error-${index + 1}`,
  }));
  const state: MockState = {
    tools: [
      {
        ...tool,
        name: 'execute_javascript',
        arguments: {
          description: '内部调用合成回归',
          code: 'return "outer success"',
          mode: 'sync',
        },
        result: {
          status: 'ok',
          task_status: 'completed',
          value: 'outer success',
          tool_calls: {
            counts: Object.fromEntries(
              abnormal.map((item) => [item.tool, { [item.status]: 1 }]),
            ),
            abnormal,
            abnormal_omitted: 0,
          },
        },
      },
    ],
  };
  const { requests, posts } = await mock(page, state);
  await page.goto(wakeUrl);
  await page.getByRole('checkbox', { name: '自动刷新', exact: true }).uncheck();
  const item = page.locator('.wake-detail .tool-detail');
  const section = item.getByRole('region', { name: '内部调用非成功明细' });
  const rows = section.locator('ul.script-abnormal > li');
  await expect(item.locator('.script-internal-notice')).toHaveText(
    '内部调用有非成功记录或明细不完整；脚本返回成功不代表所有内部调用成功。',
  );
  await expect(item.locator('.tool-evidence')).toContainText('工具返回成功');
  await expect(item.locator('.tool-evidence')).not.toContainText(
    '工具返回错误',
  );
  await expect(item.locator('p.error')).toHaveCount(0);
  await expect(item.getByLabel('返回值', { exact: true })).toHaveText(
    'outer success',
  );
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(0)).toContainText('#1');
  await expect(rows.nth(0).locator('code')).toHaveText('internal_tool_1');
  await expect(rows.nth(0).locator('.badge.error')).toHaveText('工具返回错误');
  await expect(rows.nth(1).locator('.badge.warning')).toHaveText('结果未知');
  await expect(rows.nth(2).locator('.badge.warning')).toHaveText('待确认');
  await expect(rows.nth(0).locator('.internal-call-detail')).toHaveText(
    `工具返回错误，不代表已有副作用已撤销。\n${rawError}`,
  );
  await expect(rows.nth(1).locator('.internal-call-detail')).toHaveText(
    '调用结果未知，不能断定未执行，也不能确认成功。\noriginal-error-2',
  );
  await expect(rows.nth(2).locator('.internal-call-detail')).toHaveText(
    '调用待确认，不应视为失败。\noriginal-error-3',
  );
  await expect(item.locator('.script-calls .error')).toHaveCount(6);
  await expect(item.locator('.script-calls .warning')).toHaveCount(2);
  await expect(section.locator('img, script')).toHaveCount(0);
  expect(await page.evaluate(() => '__internalCallExecuted' in window)).toBe(
    false,
  );
  const initialRequests = requests.length;
  const expand = section.getByRole('button', { name: '展开其余 3 条明细' });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expand.click();
  await expect(rows).toHaveCount(8);
  await expect(rows.last()).toContainText('#8');
  await expect(
    section.getByRole('button', { name: '收起内部明细' }),
  ).toHaveAttribute('aria-expanded', 'true');
  await page.clock.runFor(1000);
  expect(requests).toHaveLength(initialRequests);
  expect(posts).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(
    await section.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);

  // 同一工具的新快照更新结果，但保留本地展开状态。
  state.tools = [
    {
      ...state.tools![0]!,
      result: {
        ...(state.tools![0]!.result as Record<string, unknown>),
        value: 'refreshed success',
      },
    },
  ];
  await refreshImmediately(page);
  await expect(item.getByLabel('返回值', { exact: true })).toHaveText(
    'refreshed success',
  );
  await expect(rows).toHaveCount(8);
  await expect(
    section.getByRole('button', { name: '收起内部明细' }),
  ).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('checkbox', { name: '自动刷新', exact: true }).uncheck();
  const refreshedRequests = requests.length;
  await section.getByRole('button', { name: '收起内部明细' }).click();
  await expect(rows).toHaveCount(5);
  await section.getByRole('button', { name: '展开其余 3 条明细' }).click();
  await expect(rows).toHaveCount(8);
  expect(requests).toHaveLength(refreshedRequests);
  expect(posts).toEqual([]);

  state.tools = [
    {
      ...state.tools![0]!,
      callId: 'different-script-call',
      result: {
        ...(state.tools![0]!.result as Record<string, unknown>),
        value: 'different tool',
      },
    },
  ];
  await refreshImmediately(page);
  await expect(item.getByLabel('返回值', { exact: true })).toHaveText(
    'different tool',
  );
  await expect(rows).toHaveCount(5);
  await expect(
    section.getByRole('button', { name: '展开其余 3 条明细' }),
  ).toHaveAttribute('aria-expanded', 'false');
  expect(posts).toEqual([]);
});

test('javascript omitted and missing internal details are explicit and legacy job toolCalls work', async ({
  page,
}) => {
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  const summary = {
    counts: { legacy_tool: { unknown: 9 } },
    abnormal: Array.from({ length: 6 }, (_, index) => ({
      seq: index + 1,
      tool: 'legacy_tool',
      status: 'unknown',
      error: `legacy-${index}`,
    })),
    abnormal_omitted: 3,
  };
  const tools: ReviewTool[] = [
    {
      ...tool,
      name: 'query_javascript_jobs',
      arguments: { job_id: 'legacy-job' },
      result: {
        status: 'ok',
        job: {
          job_id: 'legacy-job',
          status: 'completed',
          value: 'legacy success',
          toolCalls: summary,
        },
      },
    },
    {
      ...tool,
      ordinal: 2,
      callId: 'missing-details',
      proposedAt: tool.proposedAt! + 1,
      name: 'execute_javascript',
      arguments: { code: 'return 1' },
      result: {
        status: 'ok',
        value: 1,
        tool_calls: {
          counts: { missing_tool: { error: 2 } },
          abnormal_omitted: 0,
        },
      },
    },
    {
      ...tool,
      ordinal: 3,
      callId: 'all-ok-details',
      proposedAt: tool.proposedAt! + 2,
      name: 'execute_javascript',
      arguments: { code: 'return 2' },
      result: {
        status: 'ok',
        value: 2,
        tool_calls: {
          counts: { successful_tool: { ok: 2 } },
          abnormal: [],
          abnormal_omitted: 0,
        },
      },
    },
  ];
  const { requests, posts } = await mock(page, { tools });
  await page.goto(wakeUrl);
  await page.getByRole('checkbox', { name: '自动刷新', exact: true }).uncheck();
  const items = page.locator('.wake-detail .tool-detail');
  await expect(items).toHaveCount(3);
  const legacy = items.nth(0);
  const details = legacy.getByRole('region', { name: '内部调用非成功明细' });
  await expect(legacy.locator('.tool-evidence')).toContainText('工具返回成功');
  await expect(legacy.locator('.script-calls .warning')).toContainText(
    'legacy_tool',
  );
  await expect(legacy.locator('p.error')).toHaveCount(0);
  await expect(details).toContainText(
    '另有 3 条内部非 ok 调用未包含在返回中。',
  );
  await expect(details.locator('li')).toHaveCount(5);
  const initialRequests = requests.length;
  await details.getByRole('button', { name: '展开其余 1 条明细' }).click();
  await expect(details.locator('li')).toHaveCount(6);
  await expect(details).toContainText(
    '另有 3 条内部非 ok 调用未包含在返回中。',
  );
  await expect(details).not.toContainText('全部展开');
  await expect(details.getByRole('button')).toHaveText('收起内部明细');
  await page.clock.runFor(1000);
  expect(requests).toHaveLength(initialRequests);
  expect(posts).toEqual([]);
  const missing = items.nth(1);
  await expect(missing.locator('.script-internal-notice')).toBeVisible();
  await expect(missing).toContainText(
    '内部非 ok 调用明细未提供或列表格式异常，明细不完整。',
  );
  await expect(missing).toContainText('汇总存在非 ok 调用，但明细未提供。');
  await expect(missing.locator('.script-abnormal li')).toHaveCount(0);
  await expect(missing.locator('.internal-toggle')).toHaveCount(0);
  await expect(missing.locator('.tool-evidence')).toContainText('工具返回成功');
  await expect(missing.locator('p.error')).toHaveCount(0);
  const allOk = items.nth(2);
  await expect(
    allOk.locator('.script-internal-notice, .script-internal'),
  ).toHaveCount(0);
  await expect(allOk.locator('.script-calls')).toContainText(
    'successful_tool ×2',
  );
  await expect(
    allOk.locator('.script-calls .error, .script-calls .warning'),
  ).toHaveCount(0);
});

test('javascript foreground waits count down locally and stop on refreshed results', async ({
  page,
}) => {
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  const running = (ordinal: number, mode: 'sync' | 'auto'): ReviewTool => ({
    ...tool,
    ordinal,
    callId: `call-wait-${ordinal}`,
    name: 'execute_javascript',
    arguments: {
      description: `等待-${mode}`,
      code: 'await sleep(10)',
      mode,
      wait_ms: 5000,
    },
    state: 'started',
    outcome: 'started',
    status: null,
    result: null,
    startedAt: now,
    finishedAt: null,
    durationMs: null,
  });
  const state: MockState = { tools: [running(1, 'sync'), running(2, 'auto')] };
  const { requests, posts } = await mock(page, state);
  await page.goto(wakeUrl);
  const automatic = page.getByRole('checkbox', {
    name: '自动刷新',
    exact: true,
  });
  await automatic.uncheck();
  const items = page.locator('.wake-detail .tool-detail');
  const sync = items.nth(0);
  const auto = items.nth(1);
  await expect(sync).toContainText('最多等待 5 秒，超时终止');
  await expect(auto).toContainText('自动');
  await expect(auto).toContainText('最多等待 5 秒，未完成则转后台');
  await expect(sync).toContainText('约 5 秒后超时终止');
  await expect(auto).toContainText('约 5 秒后转后台');
  const initialRequests = requests.length;
  await page.clock.runFor(2000);
  await expect(sync).toContainText('约 3 秒后超时终止');
  await expect(auto).toContainText('约 3 秒后转后台');
  expect(requests).toHaveLength(initialRequests);
  await page.clock.runFor(3000);
  for (const item of [sync, auto]) {
    await expect(item).toContainText('已到预计时限，等待状态更新');
    await expect(item).not.toContainText('约 ');
    await expect(item.locator('.tool-evidence')).toContainText(
      '执行中，尚未返回',
    );
    await expect(item.locator('.tool-evidence')).not.toContainText(
      '已返回后台句柄',
    );
    await expect(item).not.toContainText('已取消');
  }
  expect(requests).toHaveLength(initialRequests);
  expect(posts).toEqual([]);

  // Resource snapshots, not the local clock, determine completion/background state.
  state.tools = [
    {
      ...state.tools![0]!,
      state: 'finished',
      outcome: 'handled',
      status: 'ok',
      finishedAt: now + 5000,
      result: { status: 'ok', task_status: 'completed', value: 'done' },
    },
    {
      ...state.tools![1]!,
      status: 'pending',
      result: { status: 'pending', job_id: 'js_wait' },
    },
  ];
  await refreshImmediately(page);
  await expect(sync).toContainText('done');
  await expect(auto).toContainText('任务 IDjs_wait');
  await expect(auto.locator('.tool-evidence')).toContainText(
    '已返回后台句柄，任务未确认完成',
  );
  await automatic.uncheck();
  for (const item of [sync, auto]) {
    await expect(item).not.toContainText('已到预计时限');
    await expect(item).not.toContainText('约 ');
  }
  await expect(sync).toContainText('最多等待 5 秒，超时终止');
  await expect(auto).toContainText('最多等待 5 秒，未完成则转后台');
  const refreshedRequests = requests.length;
  await page.clock.runFor(10000);
  expect(requests).toHaveLength(refreshedRequests);
  expect(posts).toEqual([]);
  await expect(sync).not.toContainText('已到预计时限');
  await expect(auto).not.toContainText('已到预计时限');
  await expect(sync).not.toContainText('约 ');
  await expect(auto).not.toContainText('约 ');
});

test('tool evidence preserves send intent without overstating results on mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const args = {
    segments: [{ type: 'text', text: '同一条请求内容，不等于已送达' }],
  };
  // 文案取自 tool-evidence.ts；刻意让 handled/ok 元数据与返回相冲突。
  const cases: {
    changes: Partial<ReviewTool>;
    text: string;
    tone: 'neutral' | 'warning' | 'error';
    problem?: string;
  }[] = [
    {
      changes: { result: { status: 'error', reason_code: 'send_failed' } },
      text: '工具返回错误',
      tone: 'error',
      problem: 'send_failed',
    },
    {
      changes: {
        result: {
          status: 'unknown',
          reason_code: 'effect_uncertain',
          retry_allowed: false,
        },
      },
      text: '结果未知，外部效果未确认',
      tone: 'warning',
      problem: 'effect_uncertain',
    },
    {
      changes: {
        result: {
          status: 'ok',
          submitted: true,
          effect_confirmed: false,
          delivery_confirmed: false,
        },
      },
      text: '已提交，外部结果未确认',
      tone: 'warning',
    },
    {
      changes: { result: { status: 'ok', effect_confirmed: true } },
      text: '工具返回成功',
      tone: 'neutral',
    },
    {
      changes: {
        state: 'unknown',
        outcome: 'unknown',
        result: { status: 'ok', effect_confirmed: true },
      },
      text: '账本结果未知',
      tone: 'warning',
    },
    { changes: { result: null }, text: '结果未记录', tone: 'warning' },
    {
      changes: { result: { status: 'confirmation_required' } },
      text: '待确认',
      tone: 'warning',
    },
    {
      changes: {
        result: { status: 'ok', duplicate: true, effect_confirmed: true },
      },
      text: '复用/重复结果 · 不确认新的执行',
      tone: 'warning',
    },
    {
      changes: {
        state: 'pending',
        outcome: 'pending',
        startedAt: null,
        finishedAt: null,
        result: null,
      },
      text: '尚未执行',
      tone: 'neutral',
    },
    {
      changes: {
        state: 'started',
        outcome: 'started',
        finishedAt: null,
        result: null,
      },
      text: '执行中，尚未返回',
      tone: 'neutral',
    },
  ];
  const { posts } = await mock(page, {
    tools: cases.map(({ changes }, index) => ({
      ...tool,
      name: 'send_message',
      ordinal: index + 1,
      callId: `evidence-send-${index}`,
      arguments: args,
      ...changes,
    })),
  });
  await page.goto(wakeUrl);
  await page.getByRole('checkbox', { name: '自动刷新', exact: true }).uncheck();
  const items = page.locator('.wake-detail .tool-detail');
  await expect(items).toHaveCount(cases.length);
  for (const [index, expected] of cases.entries()) {
    const item = items.nth(index);
    const evidence = item.locator('.summary-line.tool-evidence');
    await expect(evidence).toHaveText(`请求发送的内容 · ${expected.text}`);
    await expect(evidence).toHaveClass(new RegExp(`\\b${expected.tone}\\b`));
    await expect(evidence).toHaveAttribute('title', /原始 JSON 保留供核对/);
    await expect(item.locator('.bubble')).toHaveText(args.segments[0]!.text);
    if (expected.tone !== 'error') {
      await expect(item).not.toHaveClass(/\bfailed\b/);
      await expect(item.locator('.error')).toHaveCount(0);
    }
    if (expected.problem) {
      await expect(item.locator('.result-detail')).toContainText(
        expected.problem,
      );
      await expect(item.locator('.result-detail')).toHaveClass(
        new RegExp(`\\b${expected.tone}\\b`),
      );
    } else {
      await expect(item.locator('.result-detail')).toHaveCount(0);
    }
    await item.getByRole('button', { name: '原始数据', exact: true }).click();
    await expect(
      item.getByRole('region', { name: '工具参数', exact: true }),
    ).toContainText(args.segments[0]!.text);
    const result = item.getByRole('region', { name: '工具结果', exact: true });
    await expect(result).toBeVisible();
    if (index === 2) {
      await expect(result).toContainText('submitted');
      await expect(result).toContainText('delivery_confirmed');
      await expect(result).toContainText('false');
    }
    await item
      .getByRole('button', { name: '收起原始数据', exact: true })
      .click();
  }
  expect(posts).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});

test('tool evidence labels operations, returns and fallback arguments neutrally on mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const cases = [
    {
      name: 'poke_member',
      arguments: { user_id: '10002' },
      result: { status: 'error', code: 'poke_failed' },
      label: '请求操作',
      text: '工具返回错误',
      body: '戳一戳 10002',
    },
    {
      name: 'react_message',
      arguments: { action: 'add', emoji_id: 'e', message_id: 'm' },
      result: { status: 'confirmation_required' },
      label: '请求操作',
      text: '待确认',
      body: '添加回应 e → 消息 m',
    },
    {
      name: 'react_message',
      arguments: { action: 'remove', emoji_id: 'e', message_id: 'm' },
      result: { status: 'staged' },
      label: '请求操作',
      text: '已暂存，待后续处理',
      body: '撤回回应 e → 消息 m',
    },
    {
      name: 'send_group_ai_voice',
      arguments: { text: '合成语音请求' },
      result: { status: 'submitted' },
      label: '请求发送的内容',
      text: '已提交，外部结果未确认',
      body: '合成语音请求',
    },
    {
      name: 'finish',
      arguments: {},
      result: { status: 'executed' },
      label: '请求操作',
      text: '工具返回成功',
      body: '结束本次唤醒',
    },
    {
      name: 'read_messages',
      arguments: { limit: 1 },
      result: { status: 'ok', messages: [] },
      label: '工具返回',
      text: '工具返回成功',
      body: '没有消息',
    },
    {
      name: 'query_javascript_jobs',
      arguments: {},
      result: { status: 'pending', jobs: [] },
      label: '工具返回',
      text: '结果待定',
      body: '列出 0 个任务',
    },
    {
      name: 'query_javascript_jobs',
      arguments: { job_id: 'js_queued' },
      result: {
        status: 'ok',
        job: { job_id: 'js_queued', task_status: 'queued', background: false },
      },
      label: '工具返回',
      text: '工具返回成功',
      body: '任务 IDjs_queued',
    },
    {
      name: 'execute_javascript',
      arguments: { code: 'return 1' },
      result: { status: 'pending' },
      label: '执行请求与返回',
      text: '状态未识别',
      body: '未返回任务 ID',
    },
    {
      name: 'query_javascript_jobs',
      arguments: { job_id: 'js_missing_result' },
      result: null,
      label: '调用参数',
      text: '结果未记录',
      body: 'js_missing_result',
    },
    {
      name: 'synthetic_unknown_tool',
      arguments: { query: 'fallback request' },
      result: { status: 'duplicate' },
      label: '调用参数',
      text: '复用/重复结果 · 不确认新的执行',
      body: 'fallback request',
    },
  ];
  const { posts } = await mock(page, {
    tools: cases.map((entry, index) => ({
      ...tool,
      name: entry.name,
      arguments: entry.arguments,
      result: entry.result,
      ordinal: index + 1,
      callId: `evidence-operation-${index}`,
      proposedAt: now - 4500 + index,
    })),
  });
  await page.goto(wakeUrl);
  await page.getByRole('checkbox', { name: '自动刷新', exact: true }).uncheck();
  const items = page.locator('.wake-detail .tool-detail');
  await expect(items).toHaveCount(cases.length);
  for (const [index, expected] of cases.entries()) {
    const item = items.nth(index);
    await expect(item.locator('.summary-line.tool-evidence')).toHaveText(
      `${expected.label} · ${expected.text}`,
    );
    await expect(item).toContainText(expected.body);
    await expect(item).not.toContainText('戳了戳');
    await expect(item).not.toContainText('已添加');
    await expect(item).not.toContainText('已转为后台任务');
    await expect(item.locator('.tool-evidence')).not.toContainText(
      '已返回后台句柄',
    );
    if (index > 0) {
      await expect(item.locator('.result-detail, .error')).toHaveCount(0);
      await expect(item).not.toHaveClass(/\bfailed\b/);
    }
  }
  expect(posts).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});

test('javascript wait metadata handles pending, missing, invalid and async values on mobile', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  const script = (
    ordinal: number,
    args: Record<string, unknown>,
    overrides: Partial<ReviewTool> = {},
  ): ReviewTool => ({
    ...tool,
    ordinal,
    callId: `call-metadata-${ordinal}`,
    name: 'execute_javascript',
    arguments: {
      code: 'await sleep(10)',
      mode: 'sync',
      wait_ms: 5000,
      ...args,
    },
    state: 'started',
    outcome: 'started',
    status: null,
    result: null,
    startedAt: now,
    finishedAt: null,
    durationMs: null,
    ...overrides,
  });
  const { requests, posts } = await mock(page, {
    tools: [
      script(1, {}, { state: 'pending', outcome: 'pending', startedAt: null }),
      script(2, {}, { startedAt: null }),
      script(3, {}, { arguments: { code: 'return 1', mode: 'auto' } }),
      script(4, { wait_ms: '5000' }),
      script(5, { mode: 'async' }),
      script(
        6,
        {},
        {
          state: 'finished',
          outcome: 'handled',
          status: 'ok',
          finishedAt: now - 1000,
          startedAt: now - 10000,
          result: { status: 'ok', task_status: 'completed', value: '历史完成' },
        },
      ),
    ],
  });
  await page.goto(wakeUrl);
  await page.getByRole('checkbox', { name: '自动刷新', exact: true }).uncheck();
  const items = page.locator('.wake-detail .tool-detail');
  await expect(items).toHaveCount(6);
  await expect(items.nth(0)).toContainText('尚未开始计时');
  await expect(items.nth(1)).toContainText('开始时间未记录');
  await expect(items.nth(2)).toContainText('等待时限未记录');
  await expect(items.nth(3)).toContainText('等待时限无效');
  await expect(items.nth(4)).toContainText('立即返回');
  await expect(items.nth(5)).toContainText('最多等待 5 秒，超时终止');
  const initialRequests = requests.length;
  await page.clock.runFor(10000);
  for (const item of await items.all()) {
    await expect(item).not.toContainText('约 ');
    await expect(item).not.toContainText('已到预计时限');
  }
  expect(requests).toHaveLength(initialRequests);
  expect(posts).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});
