import assert from 'node:assert/strict';
import test from 'node:test';
import { GroupFileTools, GROUP_FILE_TOOL_NAMES, buildGroupFileTools } from '../src/tools/files/tools.js';
import type { Api } from '../src/contracts/onebot.js';
import type { JsonObject } from '../src/contracts/json.js';
import type { TurnContext } from '../src/contracts/tools.js';
import type { GroupTextDownloader } from '../src/tools/files/download.js';
const ctx: TurnContext = { groupId: '123', selfId: '456', actorId: '789', messageId: '1' };
const file = (n = 1, extra: JsonObject = {}) => ({ group_id: 123, file_id: `provider-encoded-${n}`, file_name: `文档${n}.txt`, file_size: 100, uploader: 456, upload_time: 10, ...extra });
const folder = (extra: JsonObject = {}) => ({ group_id: 123, folder_id: 'provider-folder-1', folder_name: '文档', creator: 456, total_file_count: 1, ...extra });
function harness(options: { role?: string; respond?: (action: string, params: JsonObject) => unknown | Promise<unknown>; enabled?: readonly string[]; group?: string; downloader?: GroupTextDownloader } = {}) {
  const calls: { action: string; params: JsonObject }[] = [];
  const api: Api = { async call(action, params = {}) {
    calls.push({ action, params }); const result = options.respond?.(action, params); if (result !== undefined) return await result;
    if (action === 'get_login_info') return { user_id: 456 };
    if (action === 'get_group_member_info') return { group_id: Number(options.group ?? '123'), user_id: 456, role: options.role ?? 'admin' };
    if (action === 'get_group_root_files') return { files: [file()], folders: [folder()] };
    if (action === 'get_group_files_by_folder') return { files: [file()], folders: [] };
    if (action === 'get_group_file_url') return { url: 'https://downloads.example.test/private-signed-token' };
    if (action === 'get_group_file_system_info') return { file_count: 1, limit_count: 10000, used_space: 0, total_space: 10737418240 };
    if (action === 'upload_group_file') return { file_id: 'native-upload-uuid' };
    if (action === 'create_group_file_folder') return { result: {}, groupItem: [] };
    if (action === 'delete_group_file') return { result: 0, transGroupFileResult: { result: {}, successFileIdList: ['native-file-uuid'], failFileIdList: [] } };
    if (action === 'delete_group_folder') return { retCode: 0 };
    throw new Error(`Unexpected ${action}`);
  } };
  const tools = new GroupFileTools(api, options.group ?? '123', options.enabled ?? GROUP_FILE_TOOL_NAMES, { downloader: options.downloader ?? (async () => { throw new Error('unexpected download'); }) });
  return { calls, tools, run: (name: string, args: unknown, signal?: AbortSignal) => tools.execute(name, args, { ...ctx, groupId: options.group ?? '123' }, signal) };
}
async function handles(h: ReturnType<typeof harness>) {
  const result = await h.run('list_group_files', { limit: 20 }); assert.equal(result.status, 'ok');
  const items = result.items as JsonObject[];
  return { file: items.find(x => x.kind === 'file')!.file_handle, folder: items.find(x => x.kind === 'folder')!.folder_handle };
}
test('file tools default disabled, definitions scoped and schemas immutable', async () => {
  assert.deepEqual(buildGroupFileTools(), []);
  const h = harness({ enabled: [] }); assert.deepEqual(h.tools.definitions(), []);
  assert.deepEqual(await h.run('list_group_files', { limit: 1 }), { status: 'error', error: 'tool_disabled' }); assert.equal(h.calls.length, 0);
  const all = harness(); const defs = all.tools.definitions(['list_group_files']); assert.equal(defs.length, 1);
  defs[0]!.function.name = 'tampered'; assert.equal(all.tools.definitions(['list_group_files'])[0]!.function.name, 'list_group_files');
  assert.throws(() => buildGroupFileTools(['anything']));
});
test('reject malformed args, unsafe numeric bounds, injected fields and cross-group context without requests', async () => {
  const h = harness();
  for (const args of [{}, { limit: 0 }, { limit: -1 }, { limit: 1.1 }, { limit: Number.MAX_SAFE_INTEGER + 1 }, { limit: 1, offset: -1 }, { limit: 1, offset: NaN }, { limit: 1, group_id: '999' }, { limit: 1, url: 'http://localhost' }, { limit: 1, folder_handle: 'provider-folder-1' }]) assert.equal((await h.run('list_group_files', args)).status, 'error');
  assert.equal((await h.tools.execute('list_group_files', { limit: 1 }, { ...ctx, groupId: '999' })).error, 'forbidden_group');
  assert.equal(h.calls.length, 0);
});
test('verify login and fresh member identity before read/write and suppress upstream secrets', async () => {
  for (const respond of [(a: string) => a === 'get_login_info' ? { user_id: '999' } : undefined, (a: string) => a === 'get_group_member_info' ? { group_id: 999, user_id: 456, role: 'admin' } : undefined, (a: string) => a === 'get_group_member_info' ? { group_id: 123, user_id: 456, role: 'invented' } : undefined]) {
    const h = harness({ respond }); assert.equal((await h.run('create_group_folder', { name: 'safe' })).error, 'verification_failed'); assert.ok(!h.calls.some(c => c.action === 'create_group_file_folder'));
  }
  const h = harness({ respond: action => { if (action === 'get_login_info') throw new Error('SECRET /etc/private http://127.0.0.1'); } });
  assert.deepEqual(await h.run('get_group_file_space', {}), { status: 'error', error: 'api_unavailable' });
});
test('space exposes bounded numeric fields and explicitly marks native fallback uncertainty', async () => {
  const h = harness(); const result = await h.run('get_group_file_space', {});
  assert.equal(result.status, 'ok'); assert.equal(result.provider_values_unverified, true); assert.equal(result.total_space, 10737418240);
  assert.equal(h.calls[1]!.params.no_cache, true);
  const invalid = harness({ respond: a => a === 'get_group_file_system_info' ? { file_count: 1, limit_count: 2, used_space: 'SECRET', total_space: 3 } : undefined }); assert.equal((await invalid.run('get_group_file_space', {})).error, 'verification_failed');
});
test('opaque handles hide provider IDs/URLs and are bound to instance, type and reset lifecycle', async () => {
  const h = harness(); const tokens = await handles(h); assert.match(String(tokens.file), /^gf_[a-f0-9]{48}$/);
  const listed = await h.run('list_group_files', { limit: 20 }); assert.ok(!JSON.stringify(listed).includes('provider-')); assert.ok(!JSON.stringify(listed).includes('native-'));
  assert.equal((await h.run('list_group_files', { limit: 2, folder_handle: tokens.file })).error, 'invalid_handle');
  assert.equal((await harness({ group: '999' }).run('list_group_files', { limit: 2, folder_handle: tokens.folder })).error, 'invalid_handle');
  h.tools.resetWake(); assert.equal((await h.run('list_group_files', { limit: 2, folder_handle: tokens.folder })).status, 'ok');
  const call = h.calls.find(c => c.action === 'get_group_files_by_folder')!; assert.equal(call.params.folder_id, 'provider-folder-1');
  h.tools.reset(); assert.equal((await h.run('list_group_files', { limit: 2, folder_handle: tokens.folder })).error, 'invalid_handle');
});
test('expired resource handles cannot authorize use', async () => {
  const h = harness(); const tokens = await handles(h); const old = Date.now;
  try { const now = old(); Date.now = () => now + 16 * 60 * 1000; assert.equal((await h.run('delete_group_file', { file_handle: tokens.file })).error, 'invalid_handle'); } finally { Date.now = old; }
  assert.ok(!h.calls.some(c => c.action === 'delete_group_file'));
});
test('prefix pagination expands request, locally slices and never claims complete', async () => {
  const h = harness({ respond: (action, params) => action === 'get_group_root_files' ? { files: Array.from({ length: Math.min(10, Number(params.file_count)) }, (_, i) => file(i + 1)), folders: [] } : undefined });
  const a = await h.run('list_group_files', { limit: 2 }); assert.equal(a.next_offset, 2); assert.equal(a.upstream_requested, 3);
  const b = await h.run('list_group_files', { offset: 2, limit: 2 }); assert.equal(b.next_offset, 4); assert.equal(b.upstream_requested, 5); assert.equal((b.items as JsonObject[])[0]!.name, '文档3.txt');
  assert.equal(b.complete, false); assert.equal(b.upstream_partial, true); assert.equal(b.pagination, 'live_prefix_local_slice');
  const tail = await h.run('list_group_files', { offset: 9, limit: 2 }); assert.equal(tail.next_offset, null); assert.equal(tail.complete, false);
  assert.equal((await h.run('list_group_files', { offset: 1000, limit: 1 })).error, 'resource_limit');
  assert.ok(h.calls.filter(c => c.action === 'get_group_root_files').every(c => !Object.hasOwn(c.params, 'offset') && !Object.hasOwn(c.params, 'start_index')));
});
test('resource and output bounds do not pretend truncated prefix is complete', async () => {
  const h = harness({ respond: (a, p) => a === 'get_group_root_files' ? { files: Array.from({ length: Number(p.file_count) }, (_, i) => file(i, { file_name: '长'.repeat(300) })), folders: [] } : undefined });
  const result = await h.run('list_group_files', { limit: Number.MAX_SAFE_INTEGER }); assert.equal(result.status, 'ok'); assert.equal(result.upstream_requested, 1000); assert.equal(result.truncated, true); assert.ok(Number(result.returned) < 1000); assert.ok(Buffer.byteLength(JSON.stringify(result)) < 24000); assert.ok(Number(result.next_offset) > 0);
  const large = harness({ respond: a => a === 'get_group_root_files' ? { files: Array.from({ length: 1001 }, (_, i) => file(i)), folders: [] } : undefined }); assert.equal((await large.run('list_group_files', { limit: 1 })).error, 'resource_limit');
});
test('reject provider cross-scope rows before minting resource handles', async () => {
  for (const row of [file(1, { group_id: 999 }), file(1, { group_id: undefined }), file(1, { file_id: '' })]) {
    const h = harness({ respond: a => a === 'get_group_root_files' ? { files: [row], folders: [] } : undefined }); assert.equal((await h.run('list_group_files', { limit: 1 })).error, 'verification_failed');
  }
});
test('never mint root-directory handles and recheck current role instead of trusting listing-time role', async () => {
  for (const folder_id of ['/', '.', '..', '0', '']) { const h = harness({ respond: a => a === 'get_group_root_files' ? { files: [], folders: [folder({ folder_id })] } : undefined }); assert.equal((await h.run('list_group_files', { limit: 2 })).error, 'verification_failed'); }
  let role = 'admin'; const h = harness({ respond: a => a === 'get_group_member_info' ? { group_id: 123, user_id: 456, role } : undefined }); const t = await handles(h); role = 'member'; assert.equal((await h.run('delete_group_folder', { folder_handle: t.folder })).error, 'insufficient_permission'); assert.ok(!h.calls.some(c => c.action === 'delete_group_folder'));
});
test('upload only explicit UTF-8 bytes as base64, no arbitrary file path or network', async () => {
  const h = harness({ role: 'member' }); const tokens = await handles(h);
  const result = await h.run('upload_group_text_file', { name: '记录.txt', content: '你好\nhttps://example.com is text', folder_handle: tokens.folder }); assert.deepEqual(result, { status: 'ok', uploaded: true, resource_id_available: true, effect_confirmed: true, confirmation_basis: 'native_send_success' });
  const call = h.calls.find(c => c.action === 'upload_group_file')!; assert.equal(call.params.group_id, '123'); assert.equal(call.params.name, '记录.txt'); assert.equal(call.params.folder_id, 'provider-folder-1'); assert.match(String(call.params.file), /^base64:\/\//);
  assert.equal(Buffer.from(String(call.params.file).slice(9), 'base64').toString('utf8'), '你好\nhttps://example.com is text'); assert.ok(!JSON.stringify(result).includes('uuid'));
  assert.ok(!h.calls.some(c => c.action === 'download_file' || c.action === 'get_group_file_url'));
});
test('reject path names, URL passthrough, NUL, empty and oversized UTF-8 upload', async () => {
  const h = harness();
  for (const name of ['../secret', '/etc/passwd', 'C:\\test', 'https://test', 'a\nb', '.', '..', '.env', ' space', 'trailing.', '']) assert.equal((await h.run('upload_group_text_file', { name, content: 'hi' })).error, 'invalid_arguments');
  for (const content of ['', '\0', '中'.repeat(90000)]) assert.equal((await h.run('upload_group_text_file', { name: 'safe.txt', content })).error, 'invalid_arguments');
  assert.equal((await h.run('upload_group_text_file', { name: 'safe.txt', content: 'x', file: '/etc/passwd' })).error, 'invalid_arguments'); assert.equal(h.calls.length, 0);
});
test('documented nullable upload and broad create wrappers are normal outcomes, invalid shapes remain unknown', async () => {
  for (const payload of [null, {}, { file_id: '' }]) { const h = harness({ respond: a => a === 'upload_group_file' ? payload : undefined }); assert.equal((await h.run('upload_group_text_file', { name: 'file.txt', content: 'x' })).status, 'unknown'); }
  const nullable=harness({respond:a=>a==='upload_group_file'?{file_id:null}:undefined});
  assert.deepEqual(await nullable.run('upload_group_text_file',{name:'file.txt',content:'x'}),{status:'ok',uploaded:true,resource_id_available:false,effect_confirmed:true,confirmation_basis:'native_send_success'});
  for (const payload of [{ result: {}, groupItem: [] }, { result: {}, groupItem: {} }, { result: { retCode: 0 }, groupItem: [] }]) { const h = harness({ respond: a => a === 'create_group_file_folder' ? payload : undefined }); const r=await h.run('create_group_folder', { name: 'docs' });assert.equal(r.status,'ok');assert.equal(r.submitted,true);assert.equal(r.effect_confirmed,false); }
});
test('deletion requires fresh role, ordinary member may only delete own issued file', async () => {
  const own = harness({ role: 'member' }); const tokens = await handles(own);
  assert.equal((await own.run('delete_group_file', { file_handle: tokens.file })).submitted, true);
  assert.equal(own.calls.filter(c => c.action === 'delete_group_file').length, 1);
  assert.equal((await own.run('delete_group_folder', { folder_handle: tokens.folder })).error, 'insufficient_permission');
  const other = harness({ role: 'member', respond: a => a === 'get_group_root_files' ? { files: [file(1, { uploader: 999 })], folders: [folder()] } : undefined }); const otherTokens = await handles(other);
  assert.equal((await other.run('delete_group_file', { file_handle: otherTokens.file })).error, 'insufficient_permission'); assert.ok(!other.calls.some(c => c.action === 'delete_group_file'));
});
test('folder native retCode confirms effects while file malformed wrappers remain unknown', async () => {
  const good = harness(); const token = await handles(good); assert.deepEqual(await good.run('delete_group_folder', { folder_handle: token.folder }), { status: 'ok', deleted: true, effect_confirmed: true, confirmation_basis: 'provider_business_ack' });
  for (const payload of [null, {}, { result: 0 }, { result: 0, transGroupFileResult: { successFileIdList: [], failFileIdList: null } }]) { const h = harness({ respond: a => a === 'delete_group_file' ? payload : undefined }); const t = await handles(h); assert.equal((await h.run('delete_group_file', { file_handle: t.file })).status, 'unknown'); }
  const bad = harness({ respond: a => a === 'delete_group_folder' ? { retCode: 5, retMsg: 'SECRET' } : undefined }); const badTokens = await handles(bad); assert.deepEqual(await bad.run('delete_group_folder', { folder_handle: badTokens.folder }), { status: 'error', error: 'operation_rejected' });
});
test('same-wake duplicate and concurrent upload never repeat QQ effects; wake reset permits new deliberate call', async () => {
  let release!: (v: unknown) => void; const deferred = new Promise(resolve => { release = resolve; });
  const h = harness({ respond: a => a === 'upload_group_file' ? deferred : undefined }); const args = { name: 'once.txt', content: 'same' };
  const a = h.run('upload_group_text_file', args), b = h.run('upload_group_text_file', args);
  await new Promise<void>(resolve => setImmediate(resolve)); assert.equal(h.calls.filter(c => c.action === 'upload_group_file').length, 1);
  release({ file_id: 'uuid' }); const first=await a;assert.deepEqual(await b,{...first,cached:true}); assert.equal((await h.run('upload_group_text_file', args)).status, 'ok'); assert.equal(h.calls.filter(c => c.action === 'upload_group_file').length, 1);
  h.tools.resetWake(); await h.run('upload_group_text_file', args); assert.equal(h.calls.filter(c => c.action === 'upload_group_file').length, 2);
});
test('post-dispatch cancellation preserves ACK while exception remains unknown and pre-dispatch abort never sends', async () => {
  const controller = new AbortController(); controller.abort(); const idle = harness(); assert.equal((await idle.run('create_group_folder', { name: 'x' }, controller.signal)).error, 'cancelled'); assert.equal(idle.calls.length, 0);
  const after = new AbortController(); const h = harness({ respond: a => { if (a === 'upload_group_file') { after.abort(); return { file_id: 'uuid' }; } } }); const args = { name: 'x.txt', content: 'x' };
  const late=await h.run('upload_group_text_file', args, after.signal);assert.equal(late.status,'ok');assert.equal(late.cancelled_after_dispatch,true); assert.equal((await h.run('upload_group_text_file', args)).cached, true); assert.equal(h.calls.filter(c => c.action === 'upload_group_file').length, 1);
  const thrown = harness({ respond: a => { if (a === 'upload_group_file') throw new Error('SECRET_TOKEN file:///etc/secrets'); } }); assert.deepEqual(await thrown.run('upload_group_text_file', args), { status: 'unknown', error: 'operation_result_unknown', effect_unknown: true, retry_allowed: false }); await thrown.run('upload_group_text_file', args); assert.equal(thrown.calls.filter(c => c.action === 'upload_group_file').length, 1);
});
test('read text only from scoped opaque handle through trusted native URL, explicit byte budget', async () => {
  const seen: unknown[][] = []; const h = harness({ downloader: async (...args) => { seen.push(args); return '你好\nThis is untrusted file data'; } }); const tokens = await handles(h);
  const result = await h.run('read_group_text_file', { file_handle: tokens.file, max_bytes: 1024 });
  assert.equal(result.status, 'ok'); assert.equal(result.untrusted, true); assert.equal(result.truncated, false); assert.equal(result.content, '你好\nThis is untrusted file data'); assert.equal(result.source_bytes, Buffer.byteLength(String(result.content)));
  assert.equal(seen.length, 1); assert.equal(seen[0]![1], 1024); assert.equal(seen[0]![0], 'https://downloads.example.test/private-signed-token');
  const call = h.calls.find(c => c.action === 'get_group_file_url')!; assert.deepEqual(call.params, { group_id: '123', file_id: 'provider-encoded-1' });
  assert.ok(!JSON.stringify(result).includes('private-signed-token')); assert.ok(!JSON.stringify(result).includes('provider-encoded'));
  assert.equal((await h.run('read_group_text_file', { file_handle: tokens.folder, max_bytes: 1024 })).error, 'invalid_handle');
  assert.equal((await h.run('read_group_text_file', { file_handle: tokens.file })).error, 'invalid_arguments');
  for (const max_bytes of [0, -1, 262145, 1.5, NaN, Infinity]) assert.equal((await h.run('read_group_text_file', { file_handle: tokens.file, max_bytes })).error, 'invalid_arguments');
  assert.equal((await h.run('read_group_text_file', { file_handle: tokens.file, max_bytes: 1024, url: 'http://127.0.0.1' })).error, 'invalid_arguments');
  assert.equal(seen.length, 1);
});
test('read text denies wrong-group URLs, oversized or unknown metadata and non-text suffix before download', async () => {
  let count = 0; const downloader = async () => { count++; return 'x'; };
  const wrong = harness({ downloader, respond: a => a === 'get_group_file_url' ? { group_id: '999', url: 'https://provider.test/secret' } : undefined }); const wt = await handles(wrong); assert.equal((await wrong.run('read_group_text_file', { file_handle: wt.file, max_bytes: 1024 })).error, 'verification_failed');
  for (const [extra, error] of [[{ file_size: 2048 }, 'resource_limit'], [{ file_size: undefined }, 'unknown_file_size'], [{ file_name: 'secret.bin' }, 'unsupported_file_type']] as [JsonObject, string][]) {
    const h = harness({ downloader, respond: a => a === 'get_group_root_files' ? { files: [file(1, extra)], folders: [folder()] } : undefined }); const t = await handles(h); assert.equal((await h.run('read_group_text_file', { file_handle: t.file, max_bytes: 1024 })).error, error); assert.ok(!h.calls.some(c => c.action === 'get_group_file_url'));
  }
  assert.equal(count, 0);
});
test('UTF-8 text projection respects JSON escaping byte budget without splitting codepoints', async () => {
  const content = ('😀\\\"\n\t').repeat(9000); const h = harness({ downloader: async () => content }); const t = await handles(h);
  const result = await h.run('read_group_text_file', { file_handle: t.file, max_bytes: 262144 });
  assert.equal(result.status, 'ok'); assert.equal(result.truncated, true); assert.equal(result.complete, false); assert.ok(Buffer.byteLength(JSON.stringify(result)) < 24000); assert.ok(content.startsWith(String(result.content))); assert.equal(result.returned_bytes, Buffer.byteLength(String(result.content))); assert.ok(!String(result.content).endsWith('\ud83d'));
  const lying = harness({ downloader: async () => 'x'.repeat(1025) }); const lt = await handles(lying); assert.equal((await lying.run('read_group_text_file', { file_handle: lt.file, max_bytes: 1024 })).error, 'resource_limit');
  const binary = harness({ downloader: async () => 'x\0y' }); const bt = await handles(binary); assert.equal((await binary.run('read_group_text_file', { file_handle: bt.file, max_bytes: 1024 })).error, 'invalid_text');
});
test('download error redacts URLs and reset/expiry/abort suppress downloaded content', async () => {
  const errors = harness({ downloader: async () => { throw new Error('https://private-signed-token/secret /etc/passwd'); } }); const et = await handles(errors); assert.deepEqual(await errors.run('read_group_text_file', { file_handle: et.file, max_bytes: 1024 }), { status: 'error', error: 'download_failed' });
  let release!: (value: string) => void; const pending = new Promise<string>(resolve => { release = resolve; }); const h = harness({ downloader: async () => pending }); const t = await handles(h);
  const reading = h.run('read_group_text_file', { file_handle: t.file, max_bytes: 1024 }); await new Promise<void>(resolve => setImmediate(resolve)); h.tools.reset(); release('SECRET CONTENT'); assert.deepEqual(await reading, { status: 'error', error: 'cancelled' });
  const aborter = new AbortController(); const a = harness({ downloader: async () => { aborter.abort(); return 'SECRET'; } }); const at = await handles(a); assert.equal((await a.run('read_group_text_file', { file_handle: at.file, max_bytes: 1024 }, aborter.signal)).error, 'cancelled');
});
test('unknown name-slot locks block changed-content retry across wakes without freezing independent root writes', async () => {
  const h = harness({ respond: (a, p) => a === 'upload_group_file' && p.name === 'uncertain.txt' ? null : undefined });
  assert.equal((await h.run('upload_group_text_file', { name: 'uncertain.txt', content: 'first' })).status, 'unknown');
  h.tools.resetWake(); assert.equal((await h.run('upload_group_text_file', { name: 'uncertain.txt', content: 'changed' })).error, 'target_result_unknown');
  assert.equal((await h.run('upload_group_text_file', { name: 'independent.txt', content: 'allowed' })).status, 'ok');
  assert.equal((await h.run('create_group_folder', { name: 'unknown-folder' })).submitted, true);
  assert.equal((await h.run('upload_group_text_file', { name: 'another.txt', content: 'allowed' })).status, 'ok');
  assert.equal((await h.run('create_group_folder', { name: 'another-folder' })).submitted, true);
  assert.equal(h.calls.filter(c => c.action === 'upload_group_file' && c.params.name === 'uncertain.txt').length, 1);
});
test('folder deletion and child writes mutually exclude pending or unknown operations, not independent child slots', async () => {
  let release!: (value: unknown) => void; const deferred = new Promise(resolve => { release = resolve; });
  const h = harness({ respond: a => a === 'delete_group_folder' ? deferred : undefined }); const t = await handles(h);
  const deletion = h.run('delete_group_folder', { folder_handle: t.folder }); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await h.run('upload_group_text_file', { folder_handle: t.folder, name: 'child.txt', content: 'x' })).error, 'target_busy'); release(null); assert.equal((await deletion).status, 'unknown');
  h.tools.resetWake(); assert.equal((await h.run('upload_group_text_file', { folder_handle: t.folder, name: 'different.txt', content: 'x' })).error, 'target_result_unknown');
  assert.equal(h.calls.filter(c => c.action === 'upload_group_file').length, 0);
  let finish!: (value: unknown) => void; const uploadResponse = new Promise(resolve => { finish = resolve; });
  const reverse = harness({ respond: (a, p) => a === 'upload_group_file' && p.name === 'pending.txt' ? uploadResponse : undefined }); const r = await handles(reverse);
  const upload = reverse.run('upload_group_text_file', { folder_handle: r.folder, name: 'pending.txt', content: 'x' }); await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal((await reverse.run('delete_group_folder', { folder_handle: r.folder })).error, 'target_busy'); finish(null); assert.equal((await upload).status, 'unknown');
  assert.equal((await reverse.run('delete_group_folder', { folder_handle: r.folder })).error, 'target_result_unknown');
  assert.equal((await reverse.run('upload_group_text_file', { folder_handle: r.folder, name: 'other.txt', content: 'x' })).status, 'ok');
  assert.equal(reverse.calls.filter(c => c.action === 'delete_group_folder').length, 0);
});
test('file ownership is revalidated from current parent listing before ordinary member deletion', async () => {
  let uploader = 456; const h = harness({ role: 'member', respond: a => a === 'get_group_root_files' ? { files: [file(1, { uploader })], folders: [folder()] } : undefined }); const t = await handles(h); uploader = 999;
  assert.equal((await h.run('delete_group_file', { file_handle: t.file })).error, 'insufficient_permission'); assert.equal(h.calls.filter(c => c.action === 'delete_group_file').length, 0);
});
test('confirmed folder deletion tombstone blocks stale aliases but not fresh independent named creation', async () => {
  const h = harness(); const t = await handles(h); assert.equal((await h.run('delete_group_folder', { folder_handle: t.folder })).status, 'ok');
  h.tools.resetWake(); const stale = await handles(h); assert.equal((await h.run('delete_group_folder', { folder_handle: stale.folder })).error, 'target_deleted');
  assert.equal((await h.run('upload_group_text_file', { folder_handle: stale.folder, name: 'child.txt', content: 'x' })).error, 'target_deleted');
  assert.equal((await h.run('create_group_folder', { name: '文档' })).submitted, true); assert.equal(h.calls.filter(c => c.action === 'delete_group_folder').length, 1);
});
test('handle expiry while resolving native URL rejects before downloader starts', async () => {
  const realNow = Date.now; let now = realNow(), downloads = 0;
  const h = harness({ downloader: async () => { downloads++; return 'secret'; }, respond: a => { if (a === 'get_group_file_url') { now += 16 * 60 * 1000; return { url: 'https://example.test/signed' }; } } });
  try { Date.now = () => now; const t = await handles(h); assert.equal((await h.run('read_group_text_file', { file_handle: t.file, max_bytes: 1024 })).error, 'invalid_handle'); } finally { Date.now = realNow; }
  assert.equal(downloads, 0);
});
test('reset during in-flight write preserves native ACK, reset during read cannot issue fresh handles', async () => {
  let release!: (v: unknown) => void; const deferred = new Promise(resolve => { release = resolve; }); const h = harness({ respond: a => a === 'get_group_root_files' ? deferred : undefined });
  const pending = h.run('list_group_files', { limit: 2 }); await new Promise<void>(resolve => setImmediate(resolve)); h.tools.reset(); release({ files: [file()], folders: [] }); assert.deepEqual(await pending, { status: 'error', error: 'cancelled' });
  let releaseWrite!: (v: unknown) => void; const dw = new Promise(resolve => { releaseWrite = resolve; }); const w = harness({ respond: a => a === 'upload_group_file' ? dw : undefined }); const sending = w.run('upload_group_text_file', { name: 'x.txt', content: 'x' }); await new Promise<void>(resolve => setImmediate(resolve)); w.tools.reset(); releaseWrite({ file_id: 'uuid' }); const late=await sending;assert.equal(late.status,'ok');assert.equal(late.cancelled_after_dispatch,true);
});
