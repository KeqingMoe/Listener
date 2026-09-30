import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { join } from 'node:path';
import pino from 'pino';
import { ALL_TOOL_NAMES } from '../contracts/tool-names.ts';
import type { LoggingConfig, LogLevel } from '../config/app.ts';

const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const domains =
  /^(app|onebot|message|trigger|turn|model|tool|image|forward|memory|moderation|command|send|logging|attention|session)\.[a-z][a-z0-9_]{0,39}$/;
const owned = /^listener-(\d{4}-\d{2}-\d{2})-T\d{9}-[a-f0-9]{24}\.jsonl$/;
const tools = ALL_TOOL_NAMES;
const actions = new Set([
  ...tools,
  'get_login_info',
  'get_msg',
  'get_group_member_info',
  'get_group_member_list',
  'send_group_msg',
  'set_group_ban',
  'set_group_card',
  'delete_msg',
  'get_group_msg_history',
  'get_image',
  'get_forward_msg',
  'set_msg_emoji_like',
  'fetch_emoji_like',
  'get_group_honor_info',
  'get_group_shut_list',
  '_get_group_notice',
  'get_essence_msg_list',
  'send_poke',
  'group_poke',
  'set_group_sign',
  'set_group_special_title',
  'set_group_whole_ban',
  'set_group_kick',
  'set_essence_msg',
  'delete_essence_msg',
  '_send_group_notice',
  '_del_group_notice',
  'set_group_leave',
  'forward_group_single_msg',
  'send_group_forward_msg',
  'get_group_file_system_info',
  'get_group_root_files',
  'get_group_files_by_folder',
  'get_group_file_url',
  'upload_group_file',
  'create_group_file_folder',
  'delete_group_file',
  'delete_group_folder',
  'get_ai_characters',
  'send_group_ai_record',
  'get_group_system_msg',
  'set_group_add_request',
  'fetch_custom_face_detail',
  'set_custom_face_desc',
]);

export function managedLogFilename(name: string): boolean {
  return owned.test(name);
}

const numeric = [
  'duration_ms',
  'wait_ms',
  'round',
  'sent_messages',
  'images',
  'width',
  'height',
  'bytes',
  'input_bytes',
  'output_bytes',
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'input_tokens',
  'output_tokens',
  'cached_input_tokens',
  'reasoning_tokens',
  'cache_hit_rate',
  'http_status',
  'retcode',
  'attempt',
  'rows_before',
  'rows_after',
  'chars_before',
  'chars_after',
  'seconds',
  'count',
  'dropped',
  'retry',
  'start',
  'end',
  'total',
  'depth',
  'direct_count',
  'omitted_direct',
  'reactions',
  'reaction_unknown',
  'reaction_failures',
  'tool_calls',
  'model_rounds',
  'tool_calls_limit',
  'management_executed',
  'management_unknown',
  'management_submitted',
  'sent_submissions',
  'reaction_submitted',
];
const ids = ['group_id', 'actor_id', 'message_id', 'target_id', 'reply_to'];
const bools = [
  'images_enabled',
  'forward_enabled',
  'attention_enabled',
  'reactions_enabled',
  'first_frame_only',
  'submitted',
  'effect_confirmed',
  'effect_unknown',
  'provider_reported_failure',
  'cancelled_after_dispatch',
  'local_projection_failed',
  'cached',
  'duplicate',
  'dispatched',
];
const codes = ['outcome', 'reason', 'status', 'phase', 'trigger'];
const context = new AsyncLocalStorage<Record<string, unknown>>();
let secrets: string[] = [];
let current: ReturnType<typeof createLogger> | undefined;

export interface ObservedLog {
  level: LogLevel;
  event: string;
  observedAt: number;
  fields: Record<string, unknown>;
}

const observers = new Set<(record: ObservedLog) => void>();

/** 注册私有诊断sink：收到脱敏后的元数据，包括被控制台级别过滤掉的debug事件。 */
export function observeLogs(
  observer: (record: ObservedLog) => void,
): () => void {
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}

let lastWarning = 0;
let stderrGuarded = false;
let stdoutGuarded = false;

function warn(): void {
  try {
    if (Date.now() - lastWarning < 60_000) {
      return;
    }
    lastWarning = Date.now();
    if (!stderrGuarded) {
      process.stderr.on('error', () => {});
      stderrGuarded = true;
    }
    if (!process.stderr.destroyed && process.stderr.writableLength < 4096) {
      process.stderr.write(
        'logging: output unavailable or capacity exceeded\n',
        () => {},
      );
    }
  } catch {
    /* 日志出错不能影响应用本身。 */
  }
}

function clean(value: string): boolean {
  return !secrets.some((secret) => value.includes(secret));
}

function validEvent(value: unknown): value is string {
  return typeof value === 'string' && domains.test(value) && clean(value);
}

/** 严格按白名单保留字段（debug级别也一样），绝不调用用户对象的序列化方法。 */
export function sanitizeLogFields(
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  try {
    for (const key of [...ids, ...numeric]) {
      const value = fields[key];
      if (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (!ids.includes(key) || Number.isSafeInteger(value)) &&
        clean(String(value))
      ) {
        out[key] = value;
      } else if (
        ids.includes(key) &&
        typeof value === 'string' &&
        /^-?\d{1,32}$/.test(value) &&
        clean(value)
      ) {
        out[key] = value;
      }
    }
    for (const key of bools) {
      const value = fields[key];
      if (typeof value === 'boolean') {
        out[key] = value;
      }
    }
    for (const key of codes) {
      const value = fields[key];
      if (
        typeof value === 'string' &&
        /^[a-z][a-z0-9_]{0,63}$/.test(value) &&
        clean(value)
      ) {
        out[key] = value;
      }
    }
    for (const [key, pattern] of [
      ['turn_id', /^t_[a-f0-9]{16}$/],
      ['command_id', /^c_[a-f0-9]{16}$/],
      ['image_id', /^img_-?\d{1,32}_\d{1,10}$/],
      ['forward_id', /^(?:fwd_-?\d{1,32}_\d{1,3}|fwdn_[a-f0-9]{16})$/],
    ] as const) {
      const value = fields[key];
      if (typeof value === 'string' && pattern.test(value) && clean(value)) {
        out[key] = value;
      }
    }
    for (const key of ['tool', 'action']) {
      const value = fields[key];
      if (
        typeof value === 'string' &&
        (key === 'action' ? actions : tools).has(value) &&
        clean(value)
      ) {
        out[key] = value;
      }
    }
    const list = fields.tools;
    if (Array.isArray(list)) {
      const safeTools: string[] = [];
      for (let index = 0; index < Math.min(list.length, 32); index++) {
        const value: unknown = list[index];
        if (typeof value === 'string' && tools.has(value) && clean(value)) {
          safeTools.push(value);
        }
      }
      out.tools = safeTools;
    }
  } catch {
    /* 恶意getter和Proxy一律不记录。 */
  }
  return out;
}

export function withLogContext<T>(
  fields: Record<string, unknown>,
  fn: () => T,
): T {
  return context.run(
    { ...context.getStore(), ...sanitizeLogFields(fields) },
    fn,
  );
}

/** 只返回脱敏后的trace元数据，绝不暴露任意async-local字段。 */
export function getLogContext(): Record<string, unknown> {
  return sanitizeLogFields(context.getStore() ?? {});
}

export function newTraceId(prefix: 't' | 'c' = 't'): string {
  return `${prefix === 'c' ? 'c' : 't'}_${randomBytes(8).toString('hex')}`;
}

/** 接受已解析的JSONL记录或单行JSONL字符串，格式化为控制台可读的一行；非法输入返回undefined。 */
export function formatLogLine(raw: unknown): string | undefined {
  try {
    if (typeof raw === 'string') {
      if (Buffer.byteLength(raw) > 4096) {
        return;
      }
      raw = JSON.parse(raw);
    }
    if (!raw || typeof raw !== 'object') {
      return;
    }
    const record = raw as Record<string, unknown>;
    const event = record.event;
    const level = record.level;
    const time = record.time;
    if (
      !validEvent(event) ||
      !levels.includes(level as LogLevel) ||
      typeof time !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(time)
    ) {
      return;
    }
    const fields = sanitizeLogFields(record);
    const tail = Object.entries(fields)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(' ');
    return `${time} ${String(level).toUpperCase().padEnd(5)} ${event}${tail ? ` ${tail}` : ''}`;
  } catch {
    return;
  }
}

export function log(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  try {
    if (!current || !levels.includes(level) || !validEvent(event)) {
      return;
    }
    const safe = {
      ...sanitizeLogFields(context.getStore() ?? {}),
      ...sanitizeLogFields(fields),
    };
    for (const observer of observers) {
      try {
        observer({
          level,
          event,
          observedAt: Date.now(),
          fields: structuredClone(safe),
        });
      } catch {
        /* 诊断sink出错绝不打断日志或bot的正常工作。 */
      }
    }
    current.emit(level, event, safe);
  } catch {
    warn();
  }
}

/**
 * 有界异步日志管线：pino输出先进内存队列（条数、字节数有上限，超出即丢弃并告警），
 * 再串行写入按天/大小轮转的JSONL文件和控制台。任一输出出错只禁用该输出，不抛给调用方。
 */
function createLogger(config: LoggingConfig) {
  const queue: string[] = [];
  let queuedBytes = 0;
  let running: Promise<void> | undefined;
  let accepting = true;
  let fileEnabled = config.file;
  let consoleEnabled = config.console;
  let consoleStalled = false;
  let consolePending = false;
  let handle: FileHandle | undefined;
  let activeName = '';
  let activeDay = '';
  let size = 0;
  let initialized = false;
  let closing = false;
  const fileLimit = Math.floor(config.maxFileMb * 1024 * 1024);
  const totalLimit = Math.floor(config.maxTotalMb * 1024 * 1024);
  let files: { name: string; size: number; day: string }[] = [];
  async function closeFile() {
    const old = handle;
    handle = undefined;
    if (old) {
      await old.close().catch(() => warn());
    }
  }
  async function prepare() {
    await mkdir(config.directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(config.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('unsafe');
    }
    await chmod(config.directory, 0o700);
    const entries = await readdir(config.directory, { withFileTypes: true });
    files = [];
    for (const entry of entries) {
      const match = owned.exec(entry.name);
      if (!match || !entry.isFile() || entry.isSymbolicLink()) {
        continue;
      }
      const info = await lstat(join(config.directory, entry.name));
      if (info.isFile() && !info.isSymbolicLink()) {
        files.push({ name: entry.name, size: info.size, day: match[1]! });
      }
    }
    files.sort((a, b) => a.name.localeCompare(b.name));
    initialized = true;
  }
  async function prune(incoming: number, day: string) {
    const cutoff =
      Date.parse(`${day}T00:00:00.000Z`) -
      (config.retentionDays - 1) * 86400_000;
    let total = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of [...files]) {
      if (file.name === activeName) {
        continue;
      }
      if (
        Date.parse(`${file.day}T00:00:00.000Z`) >= cutoff &&
        total + incoming <= totalLimit
      ) {
        continue;
      }
      const path = join(config.directory, file.name);
      const info = await lstat(path).catch(() => undefined);
      if (info?.isFile() && !info.isSymbolicLink()) {
        await unlink(path);
      }
      total -= file.size;
      files = files.filter((item) => item !== file);
    }
    if (total + incoming > totalLimit) {
      throw new Error('capacity');
    }
  }
  async function append(line: string) {
    if (!fileEnabled) {
      return;
    }
    try {
      if (!initialized) {
        await prepare();
      }
      const day = new Date().toISOString().slice(0, 10);
      const bytes = Buffer.byteLength(line);
      if (handle && (day !== activeDay || size + bytes > fileLimit)) {
        await closeFile();
        activeName = '';
      }
      await prune(bytes, day);
      if (!handle) {
        // 每次轮转都重新检查目录本身；O_EXCL保证绝不打开已存在的日志文件。
        const directoryStat = await lstat(config.directory);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
          throw new Error('unsafe');
        }
        activeName = `listener-${day}-T${new Date().toISOString().slice(11, 23).replace(/[:.]/g, '')}-${randomBytes(12).toString('hex')}.jsonl`;
        handle = await open(
          join(config.directory, activeName),
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_APPEND |
            constants.O_NOFOLLOW,
          0o600,
        );
        activeDay = day;
        size = 0;
        files.push({ name: activeName, size: 0, day });
      }
      await handle.writeFile(line);
      size += bytes;
      files.find((file) => file.name === activeName)!.size = size;
    } catch {
      fileEnabled = false;
      await closeFile();
      warn();
    }
  }
  async function consoleWrite(line: string) {
    if (!consoleEnabled || process.stdout.destroyed) {
      return;
    }
    const readable = formatLogLine(line);
    if (!readable) {
      return;
    }
    try {
      // stdout已被其他写入方堵塞时，不再往后追加写入。
      if (process.stdout.writableLength > 65536) {
        consoleEnabled = false;
        warn();
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          consoleEnabled = false;
          consoleStalled = true;
          warn();
          resolve();
        }, 250);
        try {
          consolePending = true;
          process.stdout.write(`${readable}\n`, (error) => {
            consolePending = false;
            clearTimeout(timer);
            if (error) {
              consoleEnabled = false;
              warn();
            }
            resolve();
          });
        } catch {
          clearTimeout(timer);
          consolePending = false;
          consoleEnabled = false;
          warn();
          resolve();
        }
      });
    } catch {
      consoleEnabled = false;
      warn();
    }
  }
  async function drain() {
    while (queue.length) {
      const line = queue.shift()!;
      queuedBytes -= Buffer.byteLength(line);
      await append(line);
      await consoleWrite(line);
    }
    if (closing) {
      await closeFile();
    }
  }
  function kick() {
    if (running) {
      return;
    }
    running = drain()
      .catch(() => warn())
      .finally(() => {
        running = undefined;
        if (queue.length) {
          kick();
        }
      });
  }
  const logger = pino(
    {
      level: config.level,
      base: undefined,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    {
      write(line: string) {
        if (!accepting) {
          return;
        }
        const bytes = Buffer.byteLength(line);
        if (
          bytes > 4096 ||
          queue.length >= 1024 ||
          queuedBytes + bytes > 1024 * 1024
        ) {
          warn();
          return;
        }
        queue.push(line);
        queuedBytes += bytes;
        kick();
      },
    },
  );
  async function flush() {
    // 设备卡住时也不能无限期拖住bot关闭；只用一个超时，不用轮询定时器。
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => {
          while (running) {
            await running;
          }
        })(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2000);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
  return {
    emit(level: LogLevel, event: string, fields: Record<string, unknown>) {
      logger[level]({ event, ...fields });
    },
    flush,
    async close() {
      accepting = false;
      closing = true;
      if (!running) {
        kick();
      }
      await flush();
      // 不销毁应用共享的stdout：Node公开的stdio destroy是空操作，unref也取消不了挂起的libuv写入。
      // CLI入口必须在全部关闭工作完成后显式退出进程。
      if (consoleStalled && consolePending) {
        try {
          (
            process.stdout as typeof process.stdout & { unref?: () => void }
          ).unref?.();
        } catch {
          /* 尽力而为。 */
        }
      }
    },
  };
}

export function configureLogging(
  config: LoggingConfig,
  configuredSecrets: string[] = [],
): { flush(): Promise<void>; close(): Promise<void> } {
  if (
    !config ||
    !levels.includes(config.level) ||
    typeof config.console !== 'boolean' ||
    typeof config.file !== 'boolean' ||
    typeof config.directory !== 'string' ||
    !config.directory ||
    !Number.isInteger(config.retentionDays) ||
    config.retentionDays < 1 ||
    !Number.isFinite(config.maxFileMb) ||
    config.maxFileMb < 1 ||
    !Number.isFinite(config.maxTotalMb) ||
    config.maxTotalMb < config.maxFileMb
  ) {
    throw new Error('Invalid logging configuration');
  }
  if (!stdoutGuarded) {
    process.stdout.on('error', warn);
    stdoutGuarded = true;
  }
  const previous = current;
  if (previous) {
    void previous.close().catch(() => warn());
  }
  secrets = configuredSecrets.filter(
    (value) => typeof value === 'string' && value.length > 0,
  );
  current = createLogger({ ...config });
  return current;
}
