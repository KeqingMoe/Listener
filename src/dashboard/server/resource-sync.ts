import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { sessionToken } from './auth.ts';
import { Repository } from './repository.ts';
import { RESOURCE_SYNC_MAX_PAYLOAD_BYTES, type ResourcePatch, type ResourceSyncResponse } from '../contracts/resource-sync.ts';

export const RESOURCE_SYNC_TTL_MS = 5 * 60_000;
export const RESOURCE_SYNC_MAX_ENTRIES = 64;
export const RESOURCE_SYNC_MAX_CACHE_BYTES = 16 * 1024 * 1024;
type State = { session: string; policy: string; scope: string; resource: string; since: number | null; until: number | null; version: string | null; data: unknown; bytes: number; expires: number };
const escape = (key: string) => key.replace(/~/g, '~0').replace(/\//g, '~1');
/** Bounded structural delta: unchanged body strings are never recopied into patches. */
function diff(before: any, after: any, path = '', out: ResourcePatch[] = []): ResourcePatch[] {
  if (before === after) return out;
  if (out.length > 4096) throw new Error('patch_limit');
  if (before && after && typeof before === 'object' && typeof after === 'object' && Array.isArray(before) === Array.isArray(after)) {
    if (Array.isArray(before)) {
      for (let i = before.length - 1; i >= after.length; i--) out.push({ op: 'remove', path: `${path}/${i}` });
      for (let i = 0; i < after.length; i++) {
        if (i >= before.length) out.push({ op: 'add', path: `${path}/${i}`, value: after[i] });
        else diff(before[i], after[i], `${path}/${i}`, out);
      }
    } else {
      for (const key of Object.keys(before)) if (!Object.hasOwn(after, key)) out.push({ op: 'remove', path: `${path}/${escape(key)}` });
      for (const key of Object.keys(after)) {
        if (!Object.hasOwn(before, key)) out.push({ op: 'add', path: `${path}/${escape(key)}`, value: after[key] });
        else diff(before[key], after[key], `${path}/${escape(key)}`, out);
      }
    }
  } else out.push({ op: 'replace', path, value: after });
  if (out.length > 4096) throw new Error('patch_limit');
  return out;
}
function resourceURL(raw: unknown) {
  if (typeof raw !== 'string' || raw.length > 8192 || !raw.startsWith('/api/') || /[\x00-\x20#\\]/.test(raw)) return null;
  const url = new URL(raw, 'http://localhost');
  if (url.origin !== 'http://localhost' || url.pathname !== raw.split('?')[0]) return null;
  if (!/^\/api\/(?:meta|overview|health|requests|wakes|tools|events)$/.test(url.pathname) && !/^\/api\/(?:requests\/[^/]+|wakes\/[^/]+(?:\/review)?)$/.test(url.pathname)) return null;
  // Encoded path separators and traversal must not bypass the allowlist.
  try { if (decodeURIComponent(url.pathname).split('/').some(p => p === '.' || p === '..') || /%2f|%5c/i.test(url.pathname)) return null; } catch { return null; }
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length) return null;
  url.searchParams.sort();
  return url;
}
export function registerResourceSync(app: FastifyInstance, base: Repository, now: () => number): void {
  const cache = new Map<string, State>();
  let cacheBytes = 0;
  const drop = (key: string) => { const s = cache.get(key); if (s) cacheBytes -= s.bytes; cache.delete(key); };
  const clearSession = (session: string) => { for (const [key, s] of cache) if (s.session === session) drop(key); };
  app.addHook('onClose', async () => { cache.clear(); cacheBytes = 0; });
  app.get('/api/resource-sync', async (req, reply): Promise<unknown> => {
    const q = req.query as Record<string, unknown>;
    const session = createHash('sha256').update(sessionToken(req.headers.cookie) ?? '').digest('hex');
    const fail = () => { clearSession(session); return reply.code(400).send({ error: 'invalid_query', message: 'Invalid resource sync parameters' }); };
    const url = resourceURL(q.resource);
    if (!url || Object.keys(q).some(k => !['resource', 'cursor'].includes(k)) || q.cursor !== undefined && (typeof q.cursor !== 'string' || q.cursor.length > 128)) return fail();
    const time = now();
    for (const [key, s] of cache) if (s.expires <= time) drop(key);
    base.refreshGroups(); // Dynamic permissions must be checked even on unchanged polls.
    const policy = createHash('sha256').update(JSON.stringify([base.groups, base.sources.telemetryPath, base.sources.inspectionSecrets ?? []])).digest('hex');
    for (const s of cache.values()) if (s.session === session && s.policy !== policy) { clearSession(session); break; }
    const group = url.searchParams.get('groupId');
    if (group !== null && !base.groups.some(g => g.groupId === group)) return fail();
    const resource = url.pathname + url.search;
    const explicit = ['since', 'until'].every(k => /^\d{1,16}$/.test(url.searchParams.get(k) ?? '') && Number.isSafeInteger(Number(url.searchParams.get(k))));
    const since = explicit ? Number(url.searchParams.get('since')) : null;
    const until = explicit ? Number(url.searchParams.get('until')) : null;
    const scopeURL = new URL(url);
    if (explicit) { scopeURL.searchParams.delete('since'); scopeURL.searchParams.delete('until'); }
    const scope = scopeURL.pathname + scopeURL.search;
    const candidate = typeof q.cursor === 'string' ? cache.get(q.cursor) : undefined;
    const previous = candidate && candidate.session === session && candidate.policy === policy && candidate.scope === scope &&
      (candidate.resource === resource || since !== null && until !== null && candidate.since !== null && candidate.until !== null && since >= candidate.since && until - since === candidate.until - candidate.since) ? candidate : undefined;
    // Implicit/sliding ranges and health leases cannot be proven unchanged by a DB version.
    const temporal = ['/api/meta', '/api/health'].includes(url.pathname) || !explicit && !/^\/api\/(requests|wakes)\//.test(url.pathname);
    const version = base.resourceVersion();
    if (previous && !temporal && previous.resource === resource && version !== null && previous.version === version) {
      previous.expires = time + RESOURCE_SYNC_TTL_MS;
      return { mode: 'unchanged', cursor: q.cursor };
    }
    // Internal injection retains existing auth, query validation, projection limits and errors.
    const response = await app.inject({ method: 'GET', url: resource, headers: { host: req.headers.host!, ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}) } });
    if (response.statusCode !== 200) { clearSession(session); return reply.code(response.statusCode).type('application/json').send(response.body); }
    base.refreshGroups();
    const afterPolicy = createHash('sha256').update(JSON.stringify([base.groups, base.sources.telemetryPath, base.sources.inspectionSecrets ?? []])).digest('hex');
    if (policy !== afterPolicy) { clearSession(session); return reply.code(403).send({ error: 'forbidden', message: 'Resource permissions changed; retry' }); }
    if (Buffer.byteLength(response.body) > RESOURCE_SYNC_MAX_PAYLOAD_BYTES) {
      // An oversized detail must not evict unrelated resources in this session.
      if (previous && typeof q.cursor === 'string') drop(q.cursor);
      // Preserve existing bounded detail budgets without retaining/copying large
      // bodies in a patch cache. Such resources honestly fall back to snapshots.
      return { mode: 'snapshot', cursor: randomBytes(32).toString('hex'), data: JSON.parse(response.body) } satisfies ResourceSyncResponse;
    }
    const afterVersion = base.resourceVersion();
    const data: unknown = JSON.parse(response.body);
    const cursor = randomBytes(32).toString('hex');
    let result: ResourceSyncResponse = { mode: 'snapshot', cursor, data };
    if (previous) {
      try {
        const patch = diff(previous.data, data);
        if (!patch.length) result = { mode: 'unchanged', cursor };
        else if (Buffer.byteLength(JSON.stringify(patch)) < Buffer.byteLength(response.body)) result = { mode: 'patch', cursor, patch };
      } catch { /* Large structural changes reset to a bounded snapshot. */ }
    }
    // Retire predecessor: in-flight replays may reset, but never apply a wrong patch.
    if (previous && typeof q.cursor === 'string') drop(q.cursor);
    const bytes = Buffer.byteLength(response.body) + Buffer.byteLength(resource + scope + policy + session + (afterVersion ?? '')) + 512;
    cache.set(cursor, { session, policy, scope, resource, since, until, version: version !== null && version === afterVersion ? version : null, data, bytes, expires: time + RESOURCE_SYNC_TTL_MS });
    cacheBytes += bytes;
    while (cache.size > RESOURCE_SYNC_MAX_ENTRIES || cacheBytes > RESOURCE_SYNC_MAX_CACHE_BYTES) drop(cache.keys().next().value!);
    return result;
  });
}
