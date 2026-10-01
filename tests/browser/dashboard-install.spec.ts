import { test, expect } from '@playwright/test';

// Desktop Chromium at a narrow viewport checks web metadata/layout, not a real
// Android installation. Installation prompts depend on platform and engagement.
test('public login and deep links expose local install metadata without offline storage', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  // Stay signed out: no business API fixtures or production data are needed.
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({
      json: { authenticated: false, configured: true },
    }),
  );
  const cdp = await context.newCDPSession(page);
  await cdp.send('Page.enable');
  let rootManifest = '';
  let initialCaches: string[] | undefined;
  for (const path of ['/', '/wakes/install-fixture?groupId=11']) {
    await page.goto(path);
    await expect(page.locator('input[type="password"]')).toBeVisible();
    const storageBefore = await page.evaluate(async () => ({
      caches: await caches.keys(),
      workers: (await navigator.serviceWorker.getRegistrations()).length,
    }));
    initialCaches ??= storageBefore.caches;
    // Playwright provides a fresh context; even the first load must not cache.
    expect(initialCaches).toEqual([]);
    expect(storageBefore.caches).toEqual(initialCaches);
    expect(storageBefore.workers).toBe(0);
    const origin = new URL(page.url()).origin;
    const link = page.locator('link[rel="manifest"]');
    await expect(link).toHaveCount(1);
    await expect(link).toHaveAttribute('href', '/manifest.webmanifest');
    const parsed = await cdp.send('Page.getAppManifest');
    expect(parsed.url).toBe(`${origin}/manifest.webmanifest`);
    expect(parsed.errors).toEqual([]);
    expect(parsed.data).toBeTruthy();
    if (path === '/') {
      rootManifest = parsed.data!;
    } else {
      expect(parsed.data).toBe(rootManifest);
    }
    // CDP confirms browser parsing; fetch + Image.decode proves the actual
    // local resources work as images, rather than trusting manifest strings.
    const result = await page.evaluate(async () => {
      const url = (
        document.querySelector('link[rel="manifest"]') as HTMLLinkElement
      ).href;
      const response = await fetch(url);
      const manifest = await response.json();
      const icons = [];
      const avatarPixels: string[] = [];
      const links = [
        ...document.querySelectorAll<HTMLLinkElement>(
          'link[rel="icon"], link[rel="apple-touch-icon"]',
        ),
      ];
      for (const icon of [
        ...manifest.icons,
        ...links.map((link) => ({
          src: link.getAttribute('href'),
          sizes: link.sizes.value,
        })),
      ]) {
        const image = new Image();
        image.src = icon.src;
        await image.decode();
        if (
          icon.src === '/icons/icon-512.png' ||
          icon.src === '/icons/icon-maskable-512-v2.png'
        ) {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 512;
          canvas.getContext('2d')!.drawImage(image, 0, 0);
          avatarPixels.push(canvas.toDataURL());
        }
        icons.push({
          src: image.src,
          width: image.naturalWidth,
          height: image.naturalHeight,
          sizes: icon.sizes,
        });
      }
      return {
        status: response.status,
        type: response.headers.get('content-type'),
        manifest,
        icons,
        avatarPixels,
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        workers: (await navigator.serviceWorker.getRegistrations()).length,
        caches: await caches.keys(),
      };
    });
    expect(result.status).toBe(200);
    expect(result.type).toMatch(/^application\/manifest\+json(?:;|$)/);
    expect(result.manifest).toMatchObject({
      id: '/',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      name: 'Listener · 运行面板',
      short_name: 'Listener',
      theme_color: '#f3f5f8',
      background_color: '#f3f5f8',
    });
    expect(result.manifest.icons).toEqual([
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-maskable-512-v2.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ]);
    // A full-bleed maskable avatar must match the standard 512px image exactly.
    expect(result.avatarPixels).toHaveLength(2);
    expect(result.avatarPixels[1]).toBe(result.avatarPixels[0]);
    expect(result.icons).toHaveLength(5);
    for (const icon of result.icons) {
      expect(new URL(icon.src).origin).toBe(origin);
      expect(new URL(icon.src).pathname).toMatch(/^\/icons\/.+\.png$/);
      expect(`${icon.width}x${icon.height}`).toBe(icon.sizes);
    }
    await expect(page.locator('link[rel="icon"]')).toHaveAttribute(
      'href',
      '/icons/favicon-48.png',
    );
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
      'href',
      '/icons/apple-touch-icon.png',
    );
    expect(result.overflow).toBe(false);
    expect(result.workers).toBe(0);
    expect(result.caches).toEqual(initialCaches);
  }
  expect(requests.filter((url) => /qlogo\.(?:cn|com)/i.test(url))).toEqual([]);
  expect(
    requests.filter(
      (url) =>
        new URL(url).pathname.startsWith('/api/') &&
        new URL(url).pathname !== '/api/auth/session',
    ),
  ).toEqual([]);
  await cdp.detach();
});
