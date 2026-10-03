import { test, expect, type Locator } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';

const root = resolve('.');
const review = 'src/dashboard/web/src/components/review/';
const baseline = 'e150e89c8368e51d3cc67aa72469acd2622384e2';
const hashes = {
  [`${review}MessageParts.vue`]:
    '5c2f616c8feca898fe966d0bee48c4e57fec5f91c6c44e6d3dc85d39bfe0084b',
  [`${review}ReplyQuote.vue`]:
    'bdbe39d6b34c86088946d5fe53d15c67b17908345ce9339c876a111a5838165f',
  [`${review}FoldBlock.vue`]:
    'b472de38e803bbc672e3266a954b818cddf5c2c643ccc958f606f230c48ffc00',
  [`${review}tool-summary.ts`]:
    '41ab6d86ba17d9b39cd1db1d974acce56e89e6cbf2e84aa1d1c86f2bc1a6e8ec',
  'src/dashboard/web/src/styles/main.css':
    '4d13a7825d7b66a5cd80dbab4a98dca429b91cc23ad55b6ee7cb3a165dc71d72',
};
const sha256 = (text: Buffer | string) =>
  createHash('sha256').update(text).digest('hex');

test('原始列表模板/CSS及共用依赖固定为e150e89', async () => {
  for (const [path, hash] of Object.entries(hashes)) {
    expect(sha256(await readFile(resolve(root, path))), path).toBe(hash);
    expect(
      sha256(execFileSync('git', ['show', `${baseline}:${path}`])),
      path,
    ).toBe(hash);
  }
  const old = execFileSync('git', [
    'show',
    `${baseline}:${review}ToolDetails.vue`,
  ]).toString();
  expect(sha256(old)).toBe(
    'ba4de28947712c264af27e5aefb1d0820d7ac97920b9093af924500426bbb57b',
  );
  const template = old
    .slice(
      old.indexOf('    <ul v-else-if='),
      old.indexOf('    <div v-else-if="view?.kind === \'script\'"'),
    )
    .replace(' v-else-if="view?.kind === \'messages\'"', '')
    .split('\n')
    .map((line) => (line.startsWith('  ') ? line.slice(2) : line))
    .join('\n');
  const css = old.slice(
    old.indexOf('.chat-lines {'),
    old.indexOf('.summary-line {'),
  );
  for (const path of [
    `${review}ChatLines.vue`,
    'tests/browser/fixtures/OriginalChatLines.vue',
  ]) {
    const source = await readFile(resolve(root, path), 'utf8');
    expect(source.split('<template>\n')[1]?.split('</template>')[0]).toBe(
      template,
    );
    expect(source.split('<style scoped>\n')[1]?.split('</style>')[0]).toBe(css);
  }
});

const message = (index: number) => ({
  type: 'message.created',
  payload: {
    message: {
      userId: String(10000 + index),
      nickname: index === 1 ? '机器人' : `成员${index}`,
      bot: index === 1,
      recalled: index === 2,
      ...(index === 3 ? { reply_to: 'quoted' } : {}),
      segments:
        index === 4
          ? [
              { type: 'at', user_id: '10001' },
              { type: 'image', file: 'synthetic.png' },
              { type: 'text', text: ' 图片与提及保持原有展示' },
            ]
          : [
              {
                type: 'text',
                text: `消息${index}：原样抽取，不增加时间、方向或按钮。`,
              },
            ],
    },
  },
});
const events = Array.from({ length: 23 }, (_, index) =>
  index === 5
    ? { type: 'notice.group_increase', actor_id: '10001' }
    : message(index),
);

async function snapshot(list: Locator) {
  return list.evaluate((element) => {
    const clone = element.cloneNode(true) as Element;
    for (const node of [clone, ...clone.querySelectorAll('*')]) {
      for (const attr of node.getAttributeNames()) {
        if (attr.startsWith('data-v-')) {
          node.removeAttribute(attr);
        }
      }
    }
    const origin = element.getBoundingClientRect();
    return {
      dom: clone.outerHTML,
      nodes: [element, ...element.querySelectorAll('*')].map((node) => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          geometry: [box.x - origin.x, box.y - origin.y, box.width, box.height],
          css: Object.fromEntries(
            Array.from(style).map((key) => [key, style.getPropertyValue(key)]),
          ),
        };
      }),
    };
  });
}

for (const width of [1280, 390]) {
  for (const empty of [false, true]) {
    test(`read_events真实ToolDetails原样对照 ${width}px ${empty ? '空列表' : '全部消息类型'}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1000 });
      // 精确匹配真实 /api/ 前缀，不能误拦 /src/api/client.ts。
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== 'http://127.0.0.1:5175') {
          await route.abort();
        } else if (url.pathname.startsWith('/api/')) {
          expect(url.pathname).toBe('/api/proof/read_events');
          await route.fulfill({ json: { events: empty ? [] : events } });
        } else {
          await route.continue();
        }
      });
      await page.route('**/__chat-lines-proof', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><body><div id="app"></div><script type="module" src="/@fs/${root}/tests/browser/fixtures/chat-lines-entry.mjs"></script></body></html>`,
        }),
      );
      await page.goto('/__chat-lines-proof');
      const list = page.locator('.tool-detail > .chat-lines');
      await expect(list).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      if (!empty) {
        await expect(list.locator(':scope > li')).toHaveCount(21);
        await expect(list).toContainText('另有 3 条');
        await expect(list.locator('.bot .who')).toContainText('机器人');
        await expect(list.locator('.recalled .said')).toHaveCSS(
          'text-decoration-line',
          'line-through',
        );
        await expect(list).toContainText('@机器人');
        await expect(list).toContainText('图片');
        await expect(list.locator('.who').first()).toContainText('(10000)');
        await expect(list).toHaveCSS('font-size', '12px');
        await expect(list.locator(':scope > li').first()).toHaveCSS(
          'padding-top',
          '2px',
        );
        await expect(list).toContainText('原有引用内容');
        await expect(list).toContainText('notice.group_increase');
      } else {
        await expect(list).toHaveText('没有消息');
      }
      const before = await snapshot(list);
      const directory = resolve(root, 'artifacts/chat-lines-proof');
      await mkdir(directory, { recursive: true });
      const label = `${width}-${empty ? 'empty' : 'mixed'}`;
      const actual = await page
        .locator('.tool-detail')
        .screenshot({ path: `${directory}/${label}-actual.png` });
      await page.evaluate('window.showOracle()');
      expect(await snapshot(list)).toEqual(before);
      const oracle = await page
        .locator('.tool-detail')
        .screenshot({ path: `${directory}/${label}-e150e89.png` });
      const actualPixels = await sharp(actual)
        .raw()
        .toBuffer({ resolveWithObject: true });
      const oraclePixels = await sharp(oracle)
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(actualPixels.info).toEqual(oraclePixels.info);
      expect(Buffer.compare(actualPixels.data, oraclePixels.data)).toBe(0);
    });
  }
}
