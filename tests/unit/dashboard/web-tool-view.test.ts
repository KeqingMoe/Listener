import assert from 'node:assert/strict';
import test from 'node:test';
import {
  safeWebHref,
  webToolView,
} from '../../../src/dashboard/web/src/components/review/web-tool-view.ts';

const search = (result: unknown, args: unknown = { queries: ['news'] }) => {
  const view = webToolView('web_search', args, result);
  assert.equal(view?.kind, 'search');
  if (view?.kind !== 'search') {
    throw new Error('search view expected');
  }
  return view;
};
const fetch = (
  result: unknown,
  args: unknown = { url: 'https://example.com' },
) => {
  const view = webToolView('web_fetch', args, result);
  assert.equal(view?.kind, 'fetch');
  if (view?.kind !== 'fetch') {
    throw new Error('fetch view expected');
  }
  return view;
};
const source = {
  url: 'https://example.com/a',
  title: 'Title',
  snippet: 'Summary',
  published_at: '2026-01-01',
};
const page = {
  status: 'ok',
  url: 'https://example.com/a',
  content: 'hello',
  title: 'Page',
  http_status: 200,
  content_type: 'text',
  total_chars: 5,
  truncated: false,
};

test('normal protocol fields and exact names only', () => {
  const view = search({ status: 'ok', sources: [source], truncated: false });
  assert.deepEqual(view.queries, ['news']);
  assert.deepEqual(view.sources, [
    {
      url: source.url,
      href: source.url,
      title: source.title,
      snippet: source.snippet,
      publishedAt: source.published_at,
    },
  ]);
  assert.deepEqual(view.notices, []);
  assert.equal(view.empty, false);
  assert.equal(fetch(page).content, 'hello');
  assert.equal(fetch(page).start, 0);
  assert.deepEqual(fetch(page).notices, []);
  for (const name of [
    'search',
    'fetch',
    'webSearch',
    'tools.web_fetch',
    'WEB_SEARCH',
  ]) {
    assert.equal(webToolView(name, {}, {}), null);
  }
});

test('partial failures and server pagination are explicit', () => {
  const view = search({
    status: 'ok',
    sources: [source],
    failed_queries: 2,
    truncated: true,
  });
  assert.match(view.notices.join(' '), /部分查询失败（2条）/);
  assert.match(view.notices.join(' '), /服务端已截断/);
  const sliced = fetch({
    ...page,
    truncated: true,
    total_chars: 30000,
    next_start: 20000,
  });
  assert.equal(sliced.nextStart, 20000);
  assert.match(sliced.notices.join(' '), /next_start=20000/);
  assert.match(
    fetch({ ...page, truncated: true }).notices.join(' '),
    /不能推断续读位置/,
  );
});

test('failed, missing, unexecuted and malformed are not empty successes', () => {
  for (const result of [
    null,
    undefined,
    {},
    [],
    { status: 'error', error: 'secret', sources: [], content: '' },
    { status: 'pending', sources: [], content: '' },
    { status: true, sources: [], content: '' },
  ]) {
    assert.equal(search(result).empty, false);
    assert.equal(fetch(result).empty, false);
    assert.doesNotMatch(search(result).notices.join(' '), /secret/);
  }
  assert.equal(fetch({ ...page, status: 'error' }).content, 'hello');
  assert.equal(
    search({ status: 'error', sources: [source] }).sources.length,
    1,
  );
  assert.equal(search({ status: 'ok', sources: [null, 1, {}] }).empty, false);
  assert.match(
    search({ status: 'ok', sources: [null] }).notices.join(' '),
    /不能视为无结果/,
  );
});

test('ordinary failures do not require success-only fields', () => {
  for (const result of [
    null,
    undefined,
    { status: 'error', error: 'search_timeout' },
    { status: 'pending' },
  ]) {
    for (const view of [search(result), fetch(result)]) {
      assert.equal(view.empty, false);
      assert.equal(view.notices.length, 1);
      assert.match(view.notices[0]!, /尚无已确认成功/);
    }
  }
  assert.match(
    search({ status: 'error', sources: null, truncated: 'no' }).notices.join(
      ' ',
    ),
    /sources缺失或格式异常/,
  );
  assert.match(
    search({ status: 'error', truncated: 'no' }).notices.join(' '),
    /truncated信息缺失或格式异常/,
  );
  const malformed = fetch({ status: 'error', content: 42, total_chars: '3' });
  assert.match(malformed.notices.join(' '), /正文缺失或格式异常/);
  assert.match(malformed.notices.join(' '), /total_chars缺失或格式异常/);
});

test('encoded path and query spaces remain valid without accepting raw spaces', () => {
  const url = 'https://example.com/a%20b?q=a%20b';
  assert.equal(safeWebHref(url), url);
  assert.equal(fetch(page, { url }).requestedUrl.href, url);
  assert.equal(safeWebHref('https://exam%20ple.com/a'), null);
  assert.equal(safeWebHref('https://example.com/a b?q=a b'), null);
});

test('confirmed empty versus absent data, redirects and end slices', () => {
  assert.equal(
    search({ status: 'ok', sources: [], truncated: false }).empty,
    true,
  );
  assert.equal(search({ status: 'ok', truncated: false }).empty, false);
  assert.equal(fetch({ ...page, content: '', total_chars: 0 }).empty, true);
  assert.equal(fetch({ ...page, content: undefined }).empty, false);
  assert.equal(
    fetch({ ...page, content: '', total_chars: undefined }).empty,
    false,
  );
  assert.equal(
    fetch({ ...page, content: '', total_chars: 0, truncated: undefined }).empty,
    false,
  );
  assert.equal(
    fetch({ ...page, content: '', total_chars: 0, next_start: 20 }).empty,
    false,
  );
  assert.equal(safeWebHref('https://exam\u200bple.com'), null);
  const end = fetch({ ...page, content: '' }, { url: page.url, start: 5 });
  assert.equal(end.empty, false);
  assert.match(end.notices.join(' '), /分页切片为空，不代表整页正文为空/);
  const redirected = fetch({
    status: 'ok',
    url: page.url,
    http_status: 302,
    redirect_to: 'https://example.org/',
    content: '',
  });
  assert.equal(redirected.empty, false);
  assert.equal(redirected.content, null);
  assert.equal(redirected.redirect?.href, 'https://example.org/');
  assert.match(redirected.notices.join(' '), /未自动读取目标正文/);
  assert.equal(fetch({ ...page, content: '', redirect_to: {} }).empty, false);
});

test('invalid next_start cannot confirm an otherwise valid empty page', () => {
  for (const next_start of [null, '20', {}]) {
    const view = fetch({ ...page, content: '', total_chars: 0, next_start });
    assert.equal(view.start, 0);
    assert.equal(view.totalChars, 0);
    assert.equal(view.content, '');
    assert.equal(view.nextStart, null);
    assert.equal(view.empty, false);
    assert.match(view.notices.join(' '), /next_start格式异常，续读位置未知/);
    assert.match(view.notices.join(' '), /不能据此判断整页正文为空/);
  }
  assert.equal(fetch({ ...page, content: '', total_chars: 0 }).empty, true);
});

test('unknown and malformed scalars stay unknown; aliases are not guessed', () => {
  const view = fetch(
    {
      status: 'ok',
      text: 'alias',
      final_url: page.url,
      status_code: 200,
      total_chars: '5',
      next_start: {},
      truncated: 'false',
      content_type: {},
      title: {},
    },
    { url: {}, start: '0' },
  );
  assert.equal(view.content, null);
  assert.equal(view.returnedUrl, null);
  assert.equal(view.httpStatus, null);
  assert.equal(view.totalChars, null);
  assert.equal(view.nextStart, null);
  assert.equal(view.start, null);
  assert.equal(view.title, '');
  assert.equal(view.contentType, '');
  assert.equal(view.requestedUrl.url, '');
  assert.match(view.notices.join(' '), /完整性未知/);
  const aliases = search(
    { status: 'ok', results: [source], failed_queries: '1' },
    { query: 'alias' },
  );
  assert.deepEqual(aliases.sources, []);
  assert.deepEqual(aliases.queries, []);
  assert.equal(aliases.empty, false);
  assert.match(aliases.notices.join(' '), /失败数量未知/);
  assert.match(
    fetch({ ...page, truncated: undefined }).notices.join(' '),
    /完整性未知/,
  );
  for (const n of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(fetch({ ...page, total_chars: n }).totalChars, null);
  }
});

test('strict links reject dangerous schemes, confusion and local literals', () => {
  for (const value of [
    null,
    {},
    1,
    '',
    '/relative',
    '//example.com',
    'javascript:alert(1)',
    'data:text/html,x',
    'file:///etc/passwd',
    'blob:https://example.com/x',
    ' https://example.com',
    'https://example.com/a b',
    'https://example.com/\n',
    'https://example.com/\\evil',
    'https:///example.com',
    'https://u:p@example.com',
    'https://@example.com',
    'https://%65xample.com',
    'https://example.com/%0a',
    'https://example.com/%5c',
    'http://localhost',
    'http://x.localhost.',
    'http://127.0.0.1',
    'http://127.1',
    'http://2130706433',
    'http://0x7f000001',
    'http://10.1.2.3',
    'http://172.16.0.1',
    'http://172.31.255.255',
    'http://192.168.1.1',
    'http://169.254.169.254',
    'http://[::1]',
    'http://[0:0:0:0:0:0:0:1]',
    'http://[fc00::1]',
    'http://[fdff::1]',
    'http://[fe80::1]',
    'http://[febf::1]',
    'http://[::ffff:127.0.0.1]',
    'http://[::ffff:8.8.8.8]',
  ]) {
    assert.equal(safeWebHref(value), null, String(value));
  }
  for (const value of [
    'https://example.com/',
    'http://172.15.0.1/',
    'http://172.32.0.1/',
    'http://192.169.0.1/',
    'https://[2606:4700:4700::1111]/',
  ]) {
    assert.equal(safeWebHref(value), value);
  }
  const view = search({
    status: 'ok',
    sources: [
      {
        ...source,
        url: 'javascript:alert(1)',
        title: '<img src=x onerror=alert(1)>',
        snippet: '**markdown**',
      },
    ],
    truncated: false,
  });
  assert.equal(view.sources[0]?.href, null);
  assert.equal(view.sources[0]?.url, 'javascript:alert(1)');
  assert.equal(view.sources[0]?.title, '<img src=x onerror=alert(1)>');
  assert.equal(view.sources[0]?.snippet, '**markdown**');
});

test('bounded sources, queries, all text and Unicode code point boundaries', () => {
  const view = search(
    {
      status: 'ok',
      sources: Array(11).fill({
        ...source,
        title: '😀'.repeat(1025),
        snippet: 'a'.repeat(2049),
        published_at: 'a'.repeat(129),
      }),
      truncated: false,
    },
    { queries: Array(5).fill('😀'.repeat(513)) },
  );
  assert.equal(view.sources.length, 10);
  assert.equal(view.queries.length, 4);
  assert.equal(view.queries[0], '😀'.repeat(512));
  assert.equal(view.sources[0]?.title, '😀'.repeat(1024));
  assert.equal(view.sources[0]?.snippet.length, 2048);
  assert.equal(view.sources[0]?.publishedAt.length, 128);
  assert.match(view.notices.join(' '), /本地展示限制/);
  assert.match(view.notices.join(' '), /查询在本页最多展示4条/);
  const exact = fetch({
    ...page,
    content: '😀'.repeat(20000),
    total_chars: 20000,
  });
  assert.equal(exact.content, '😀'.repeat(20000));
  assert.doesNotMatch(exact.notices.join(' '), /正文在本页展示已截短/);
  const clipped = fetch({
    ...page,
    content: '😀'.repeat(20001),
    total_chars: 20001,
  });
  assert.equal(clipped.content, exact.content);
  assert.match(
    clipped.notices.join(' '),
    /正文在本页展示已截短（最多20000码点）/,
  );
  assert.equal(clipped.nextStart, null);
  const longUrl = 'https://example.com/' + 'a'.repeat(9000);
  assert.equal(safeWebHref(longUrl), null);
  assert.equal(fetch(page, { url: longUrl }).requestedUrl.href, null);
  assert.equal(fetch(page, { url: longUrl }).requestedUrl.url.length, 2048);
  // Query protocol limits are bytes; display limits are explicitly code points, not validation.
  assert.equal(Buffer.byteLength(view.queries[0]!), 2048);
});

test('adapter does not change frozen input or retain mutable nested records', () => {
  const args = Object.freeze({ queries: Object.freeze(['news']) });
  const result = Object.freeze({
    status: 'ok',
    sources: Object.freeze([Object.freeze({ ...source })]),
    truncated: false,
  });
  const before = JSON.stringify({ args, result });
  const view = search(result, args);
  view.queries.push('local');
  view.sources[0]!.title = 'changed';
  assert.equal(JSON.stringify({ args, result }), before);
  const frozenPage = Object.freeze({ ...page });
  fetch(frozenPage, Object.freeze({ url: page.url }));
  assert.deepEqual(frozenPage, page);
});
