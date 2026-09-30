import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, request as httpRequest, type Server, type IncomingMessage, type ServerResponse, type RequestOptions } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { createWebFetcher, validateFetchUrl, FetchError, FETCH_LIMITS, type FetchDependencies } from '../../../../src/tools/web/fetch.ts';

const PUBLIC = '93.184.216.34';
async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}
/** DNS says every host is public; the transport records the pinned address and routes to the fixture server. */
function network(port: number, answers: Record<string, string[]> = {}) {
  const pinned: string[] = [], hosts: string[] = [];
  const deps: FetchDependencies = {
    lookup: async host => { hosts.push(host); return (answers[host] ?? [PUBLIC]).map(address => ({ address, family: address.includes(':') ? 6 : 4 })); },
    request: (options: RequestOptions, callback) => {
      (options.lookup as Function)(options.hostname, {}, (_e: unknown, address: string) => pinned.push(address));
      assert.equal(options.agent, false);
      return httpRequest({ ...options, protocol: 'http:', hostname: '127.0.0.1', port, lookup: undefined, servername: undefined }, callback);
    },
  };
  return { deps, pinned, hosts };
}
const code = async (promise: Promise<unknown>) => { try { await promise; return 'resolved'; } catch (error) { return error instanceof FetchError ? error.code : String(error); } };

test('URL validation accepts only credential-free http(s)', () => {
  for (const bad of ['ftp://example.com/', 'file:///etc/passwd', 'http://user:pw@example.com/', 'javascript:alert(1)', 'http://exa mple.com/', '', 'x'.repeat(3000), 42])
    assert.throws(() => validateFetchUrl(bad), FetchError, String(bad).slice(0, 30));
  assert.equal(validateFetchUrl('https://example.com/a?b#frag').href, 'https://example.com/a?b');
});

test('private, loopback, metadata, mapped and mixed DNS answers are blocked before connecting', async () => {
  let connected = 0;
  for (const answer of [['127.0.0.1'], ['10.0.0.8'], ['169.254.169.254'], ['192.168.1.1'], ['::1'], ['::ffff:127.0.0.1'], ['fd00::1'], [PUBLIC, '10.0.0.1'], []]) {
    const fetcher = createWebFetcher({ lookup: async () => answer.map(address => ({ address, family: address.includes(':') ? 6 : 4 })), request: () => { connected++; throw new Error('must not connect'); } });
    assert.equal(await code(fetcher('https://example.com/')), 'blocked_url', answer.join(','));
  }
  for (const literal of ['http://127.0.0.1:8888/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data/', 'http://0x7f000001/'])
    assert.equal(await code(createWebFetcher({ request: () => { connected++; throw new Error(); } })(literal)), 'blocked_url', literal);
  assert.equal(connected, 0);
});

test('fetches HTML with pinned address and decodes declared charsets', async () => {
  const { server, port } = await serve((req, res) => {
    if (req.url === '/gbk') { res.setHeader('content-type', 'text/html'); res.end(Buffer.concat([Buffer.from('<meta charset="gbk"><p>'), Buffer.from([0xc4, 0xe3, 0xba, 0xc3]), Buffer.from('</p>')])); return; }
    res.setHeader('content-type', 'text/html; charset=utf-8'); res.setHeader('content-encoding', 'gzip');
    res.end(gzipSync('<title>T</title><p>你好</p>'));
  });
  try {
    const n = network(port), fetcher = createWebFetcher(n.deps);
    const page = await fetcher('https://example.com/page');
    assert.equal(page.kind, 'body');
    assert.ok(page.kind === 'body' && page.text.includes('你好') && page.contentType === 'html' && page.httpStatus === 200);
    assert.deepEqual(n.pinned, [PUBLIC]);
    const gbk = await fetcher('https://example.com/gbk');
    assert.ok(gbk.kind === 'body' && gbk.text.includes('你好'));
  } finally { server.close(); }
});

test('redirects: same-origin followed with fresh checks, cross-origin returned, rebinding blocked', async () => {
  const { server, port } = await serve((req, res) => {
    const to: Record<string, string> = { '/a': '/b', '/cross': 'https://other.example/x', '/loop': '/loop', '/rebind': 'https://evil.example/' };
    if (to[req.url!]) { res.statusCode = 302; res.setHeader('location', to[req.url!]!); res.end('ignored body'); return; }
    res.setHeader('content-type', 'text/plain'); res.statusCode = 404; res.end('final');
  });
  try {
    const n = network(port, { 'evil.example': ['10.1.1.1'] }), fetcher = createWebFetcher(n.deps);
    const followed = await fetcher('https://example.com/a');
    assert.ok(followed.kind === 'body' && followed.url === 'https://example.com/b' && followed.httpStatus === 404 && followed.text === 'final');
    assert.deepEqual(n.hosts, ['example.com', 'example.com']);
    assert.deepEqual(await fetcher('https://example.com/cross'), { kind: 'redirect', url: 'https://example.com/cross', httpStatus: 302, location: 'https://other.example/x' });
    const loop = await fetcher('https://example.com/loop');
    assert.equal(loop.kind, 'redirect');
    assert.equal(n.hosts.filter(h => h === 'example.com').length, 2 + 1 + FETCH_LIMITS.redirects + 1);
    // A cross-origin hop is only a suggestion; reading it runs the full address policy again.
    const rebind = await fetcher('https://example.com/rebind');
    assert.ok(rebind.kind === 'redirect');
    assert.equal(await code(fetcher(rebind.location)), 'blocked_url');
  } finally { server.close(); }
});

test('size, content type, compression bomb, timeout and cancellation bounds', async () => {
  const { server, port } = await serve((req, res) => {
    if (req.url === '/big') { res.setHeader('content-type', 'text/plain'); res.end(Buffer.alloc(FETCH_LIMITS.responseBytes + 1, 97)); return; }
    if (req.url === '/bomb') { res.setHeader('content-type', 'text/plain'); res.setHeader('content-encoding', 'gzip'); res.end(gzipSync(Buffer.alloc(FETCH_LIMITS.responseBytes * 4, 97))); return; }
    if (req.url === '/pdf') { res.setHeader('content-type', 'application/pdf'); res.end('%PDF'); return; }
    if (req.url === '/binary') { res.setHeader('content-type', 'text/plain'); res.end(Buffer.from([0, 1, 2, 3, 0, 0, 5])); return; }
    if (req.url === '/charset') { res.setHeader('content-type', 'text/plain; charset=x-nope'); res.end('a'); return; }
    if (req.url === '/hang') return;
    res.end('?');
  });
  try {
    const fetcher = createWebFetcher(network(port).deps);
    assert.equal(await code(fetcher('https://example.com/big')), 'fetch_too_large');
    assert.equal(await code(fetcher('https://example.com/bomb')), 'fetch_too_large');
    assert.equal(await code(fetcher('https://example.com/pdf')), 'unsupported_content_type');
    assert.equal(await code(fetcher('https://example.com/binary')), 'unsupported_content_type');
    assert.equal(await code(fetcher('https://example.com/charset')), 'unsupported_charset');
    assert.equal(await code(createWebFetcher({ ...network(port).deps, timeoutMs: 100 })('https://example.com/hang')), 'fetch_timeout');
    const controller = new AbortController();
    const pending = fetcher('https://example.com/hang', controller.signal);
    setTimeout(() => controller.abort(), 20);
    assert.equal(await code(pending), 'cancelled');
  } finally { server.closeAllConnections(); server.close(); }
});
