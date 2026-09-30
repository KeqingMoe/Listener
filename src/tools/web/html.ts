import TurndownService from 'turndown';

/**
 * 深层未闭合嵌套会让DOM构建和转换在事件循环上呈超线性耗时；真实页面一般只嵌套几十层。
 * 超过该深度的输入退化为直接剥离标签。
 */
const MAX_DEPTH = 512;
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const RAW = ['script', 'style', 'noscript', 'template', 'textarea', 'title'];

function hidden(node: HTMLElement): boolean {
  if (
    [
      'SCRIPT',
      'STYLE',
      'NOSCRIPT',
      'TEMPLATE',
      'IFRAME',
      'OBJECT',
      'EMBED',
      'HEAD',
      'TITLE',
      'SVG',
      'CANVAS',
      'FORM',
      'BUTTON',
      'SELECT',
      'NAV',
    ].includes(node.nodeName)
  ) {
    return true;
  }
  if (
    node.hasAttribute('hidden') ||
    node.getAttribute('aria-hidden')?.toLowerCase() === 'true'
  ) {
    return true;
  }
  if (node.nodeName === 'INPUT') {
    return true;
  }
  return (node.getAttribute('style') ?? '').split(';').some((declaration) => {
    const [property = '', value = ''] = declaration.split(':').map((part) =>
      part
        .trim()
        .toLowerCase()
        .replace(/\s*!important$/, ''),
    );
    return (
      (property === 'display' && value === 'none') ||
      (property === 'visibility' &&
        (value === 'hidden' || value === 'collapse'))
    );
  });
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});
// 隐藏内容常被用来做提示词注入，而且读者本来也看不到。
turndown.addRule('dropHidden', {
  filter: (node) => hidden(node as HTMLElement),
  replacement: () => '',
});
// 图片对模型没有文字信息，只保留有意义的alt文本。
turndown.addRule('imageAlt', {
  filter: 'img',
  replacement: (_content, node) => {
    const alt = (node as HTMLElement).getAttribute('alt')?.trim();
    return alt ? `[图片: ${alt.slice(0, 120)}]` : '';
  },
});
// 相对链接和脚本链接是噪音，只保留绝对http(s)链接。
turndown.addRule('safeLinks', {
  filter: (node) => node.nodeName === 'A',
  replacement: (content, node) => {
    const href = (node as HTMLElement).getAttribute('href') ?? '',
      text = content.trim();
    if (!text) {
      return '';
    }
    return /^https?:\/\//i.test(href) && href.length <= 2048
      ? `[${text}](${href})`
      : text;
  },
});

export function exceedsDepth(html: string): boolean {
  const lower = html.toLowerCase(),
    stack: string[] = [];
  const tag =
    /<!--[\s\S]*?(?:-->|$)|<\/?([a-z][a-z0-9-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;
  let match: RegExpExecArray | null;
  while ((match = tag.exec(lower))) {
    const name = match[1];
    if (!name) {
      continue;
    }
    if (match[0].startsWith('</')) {
      if (stack.at(-1) === name) {
        stack.pop();
      }
      continue;
    }
    if (VOID.has(name) || match[0].endsWith('/>')) {
      continue;
    }
    if (RAW.includes(name)) {
      const end = lower.indexOf(`</${name}`, tag.lastIndex);
      tag.lastIndex = end === -1 ? lower.length : end;
      continue;
    }
    stack.push(name);
    if (stack.length > MAX_DEPTH) {
      return true;
    }
  }
  return false;
}

function stripTags(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n');
}

export function htmlTitle(html: string): string | undefined {
  const raw = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(
    html.slice(0, 65536),
  )?.[1];
  const title = raw ? stripTags(raw).replace(/\s+/g, ' ').trim() : '';
  return title ? title.slice(0, 200) : undefined;
}

/** 把可见内容转成Markdown；存在主体区域时优先取它，避开站点导航等外围元素。 */
export function htmlToMarkdown(html: string): string {
  if (exceedsDepth(html)) {
    return stripTags(html).trim();
  }
  const main = /<(main|article)\b[^>]*>([\s\S]*)<\/\1\s*>/i.exec(html)?.[2];
  const body = main && stripTags(main).trim().length >= 200 ? main : html;
  return turndown
    .turndown(body)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
