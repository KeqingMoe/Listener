export type WebLink = { url: string; href: string | null };

export type WebToolView =
  | {
      kind: 'search';
      queries: string[];
      sources: (WebLink & {
        title: string;
        snippet: string;
        publishedAt: string;
      })[];
      notices: string[];
      empty: boolean;
    }
  | {
      kind: 'fetch';
      requestedUrl: WebLink;
      returnedUrl: WebLink | null;
      title: string;
      content: string | null;
      redirect: WebLink | null;
      httpStatus: number | null;
      contentType: string;
      start: number | null;
      totalChars: number | null;
      nextStart: number | null;
      notices: string[];
      empty: boolean;
    };

/** A conservative literal-address guard, not DNS resolution or a public-IP guarantee. */
export function safeWebHref(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length > 8192 ||
    !/^https?:\/\/[^/]/i.test(value) ||
    /[\s\p{Cf}\u0000-\u001f\u007f-\u009f\\]/u.test(value) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|5c|7f)/i.test(value)
  ) {
    return null;
  }
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      return null;
    }
    // Reject even empty userinfo, and percent-encoded/ambiguous authorities.
    const authority = value
      .slice(value.indexOf('://') + 3)
      .split(/[/?#]/, 1)[0]!;
    if (/[@%]/.test(authority)) {
      return null;
    }
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (host === 'localhost' || host.endsWith('.localhost')) {
      return null;
    }
    if (host.startsWith('[')) {
      const ip = host.slice(1, -1);
      if (
        ip === '::' ||
        ip === '::1' ||
        /^f[cd]/.test(ip) ||
        /^fe[89ab]/.test(ip) ||
        ip.startsWith('::ffff:')
      ) {
        return null;
      }
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const [a, b] = host.split('.').map(Number) as [number, number];
      if (
        a === 0 ||
        a === 127 ||
        a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254) ||
        (a === 100 && b >= 64 && b <= 127) ||
        a >= 224
      ) {
        return null;
      }
    }
    return url.href;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function integer(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/** Text only: consumers must render strings as text, never HTML/Markdown or images. */
export function webToolView(
  name: string,
  args: unknown,
  result: unknown,
): WebToolView | null {
  if (name !== 'web_search' && name !== 'web_fetch') {
    return null;
  }
  const a = record(args),
    r = record(result),
    notices: string[] = [];
  const notice = (message: string) => {
    if (!notices.includes(message)) {
      notices.push(message);
    }
  };
  const text = (
    value: unknown,
    label: string,
    limit = 1024,
    required = false,
  ): string => {
    if (typeof value !== 'string') {
      if (required || value !== undefined) {
        notice(`${label}缺失或格式异常，保持未知。`);
      }
      return '';
    }
    // Iterate only the bounded prefix, rather than allocating all code points.
    let end = 0,
      count = 0;
    while (end < value.length && count < limit) {
      end += value.codePointAt(end)! > 0xffff ? 2 : 1;
      count++;
    }
    if (end < value.length) {
      notice(
        `${label}在本页展示已截短（最多${limit}码点），不代表服务端截断。`,
      );
    }
    return value.slice(0, end);
  };
  const link = (value: unknown, label: string): WebLink => {
    const url = text(value, label, 2048, true);
    const href =
      typeof value === 'string' && url === value ? safeWebHref(value) : null;
    if (url && !href) {
      notice('受限或异常URL仅显示为文本；链接检查不包含DNS解析。');
    }
    return { url, href };
  };
  const ok = r.status === 'ok';
  if (!ok) {
    notice('尚无已确认成功的结果；不能据此判断无搜索结果或无正文。');
  }
  const truncation = () => {
    if (r.truncated === true) {
      notice('服务端已截断返回内容，当前结果不完整。');
    } else if (r.truncated !== false && (ok || r.truncated !== undefined)) {
      notice('服务端truncated信息缺失或格式异常，完整性未知。');
    }
  };
  if (name === 'web_search') {
    const queries: string[] = [],
      sources: Extract<WebToolView, { kind: 'search' }>['sources'] = [];
    if (Array.isArray(a.queries)) {
      if (a.queries.length > 4) {
        notice('查询在本页最多展示4条，其余已省略。');
      }
      for (const query of a.queries.slice(0, 4)) {
        if (typeof query === 'string') {
          queries.push(text(query, '查询', 512));
        } else {
          notice('查询记录格式异常，未作为文本展示。');
        }
      }
    } else {
      notice('queries缺失或格式异常，查询未知。');
    }
    if (Array.isArray(r.sources)) {
      if (r.sources.length > 10) {
        notice('来源在本页最多展示10条，其余已省略；这是本地展示限制。');
      }
      for (const value of r.sources.slice(0, 10)) {
        const source = record(value);
        if (typeof source.url !== 'string' || !source.url) {
          notice('部分来源记录缺失或格式异常，已跳过；不能视为无结果。');
          continue;
        }
        sources.push({
          ...link(source.url, '来源URL'),
          title: text(source.title, '来源标题', 1024, true),
          snippet: text(source.snippet, '来源摘要', 2048),
          publishedAt: text(source.published_at, '发布时间', 128),
        });
      }
    } else if (ok || r.sources !== undefined) {
      notice('sources缺失或格式异常，来源未知。');
    }
    if (r.failed_queries !== undefined) {
      const failed = integer(r.failed_queries);
      if (failed === null) {
        notice('failed_queries格式异常，查询失败数量未知。');
      } else if (failed > 0) {
        notice(`部分查询失败（${failed}条），当前来源不完整。`);
      }
    }
    truncation();
    return {
      kind: 'search',
      queries,
      sources,
      notices,
      empty: ok && Array.isArray(r.sources) && r.sources.length === 0,
    };
  }
  const requestedUrl = link(a.url, '请求URL');
  const returnedUrl = r.url === undefined ? null : link(r.url, '返回URL');
  const hasRedirect = r.redirect_to !== undefined;
  const redirect =
    typeof r.redirect_to === 'string' ? link(r.redirect_to, '重定向URL') : null;
  if (hasRedirect) {
    notice('返回了重定向信息，未自动读取目标正文。');
  }
  if (hasRedirect && (!redirect || !redirect.url)) {
    notice('redirect_to格式异常，重定向目标未知。');
  }
  const start =
    a.start === undefined
      ? typeof a.url === 'string'
        ? 0
        : null
      : integer(a.start);
  if (start === null) {
    notice('start缺失或格式异常，切片起点未知。');
  }
  const totalChars = integer(r.total_chars),
    nextStart = integer(r.next_start);
  if (
    !hasRedirect &&
    totalChars === null &&
    (ok || r.total_chars !== undefined)
  ) {
    notice('total_chars缺失或格式异常，整页长度未知。');
  }
  if (r.next_start !== undefined && nextStart === null) {
    notice('next_start格式异常，续读位置未知。');
  }
  if (nextStart !== null) {
    notice(`服务端提供续读位置next_start=${nextStart}，与本页展示截短不同。`);
  }
  if (!hasRedirect) {
    truncation();
  }
  if (!hasRedirect && r.truncated === true && nextStart === null) {
    notice('服务端未提供有效next_start，不能推断续读位置。');
  }
  const content =
    !hasRedirect && typeof r.content === 'string'
      ? text(r.content, '正文', 20_000)
      : null;
  if (!hasRedirect && content === null && (ok || r.content !== undefined)) {
    notice('正文缺失或格式异常，内容未知。');
  }
  if (ok && content === '' && start !== null && start > 0) {
    notice('当前分页切片为空，不代表整页正文为空。');
  }
  if (
    ok &&
    content === '' &&
    (start === null ||
      totalChars !== 0 ||
      r.truncated !== false ||
      r.next_start !== undefined)
  ) {
    notice('已返回空切片，但不能据此判断整页正文为空。');
  }
  const httpStatus = integer(r.http_status);
  if (
    r.http_status !== undefined &&
    (httpStatus === null || httpStatus < 100 || httpStatus > 599)
  ) {
    notice('http_status格式异常，HTTP状态未知。');
  }
  return {
    kind: 'fetch',
    requestedUrl,
    returnedUrl,
    title: text(r.title, '标题'),
    content,
    redirect,
    httpStatus:
      httpStatus !== null && httpStatus >= 100 && httpStatus <= 599
        ? httpStatus
        : null,
    contentType: text(r.content_type, '内容类型', 128),
    start,
    totalChars,
    nextStart,
    notices,
    empty:
      ok &&
      !hasRedirect &&
      content === '' &&
      start === 0 &&
      totalChars === 0 &&
      r.truncated === false &&
      r.next_start === undefined,
  };
}
