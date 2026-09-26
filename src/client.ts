import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { Config } from './config.js';
import { log } from './logger.js';

const ERROR_MESSAGES = {
  api_failed:'OneBot API failed', unavailable:'OneBot unavailable', busy:'OneBot busy',
  timeout:'OneBot API timeout; delivery unknown',send_failed:'OneBot send failed; delivery unknown',
  disconnected:'OneBot disconnected',stopped:'OneBot stopped',
} as const;
export class OneBotError extends Error {
  constructor(readonly code:keyof typeof ERROR_MESSAGES,readonly retcode?:number){super(ERROR_MESSAGES[code]);this.name='OneBotError';}
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
export type ClientOptions = Pick<Config, 'url' | 'token' | 'apiTimeoutMs' | 'reconnectBaseMs' | 'reconnectMaxMs' | 'heartbeatMs'>;

// Never relay remote error text: it may contain message bodies or credentials.
export class OneBotClient extends EventEmitter {
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private pending = new Map<string, Pending>();
  private stopped = true;
  private attempt = 0;
  private awaitingPong = false;
  constructor(private readonly options: ClientOptions) { super(); }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    log('info','onebot.connecting',{attempt:this.attempt+1});
    const ws = new WebSocket(this.options.url, {
      headers: { Authorization: `Bearer ${this.options.token}` },
      handshakeTimeout: this.options.apiTimeoutMs,
      maxPayload: 1024 * 1024,
      followRedirects: false,
      perMessageDeflate: false,
    });
    this.socket = ws;
    ws.on('error', () => { log('warn','onebot.connection_failed',{reason:'transport_error'}); });
    ws.on('open', () => {
      if (this.stopped || this.socket !== ws) return;
      this.awaitingPong = false;
      this.heartbeatTimer = setInterval(() => {
        if (this.awaitingPong) { log('warn','onebot.heartbeat_timeout');ws.terminate(); return; }
        this.awaitingPong = true;
        ws.ping();
      }, this.options.heartbeatMs);
      void this.call('get_login_info').then(data => {
        if (this.socket !== ws || this.stopped) return;
        const userId = data && typeof data === 'object' && !Array.isArray(data) && 'user_id' in data ? data.user_id : undefined;
        const validIdentity = (typeof userId === 'number' && Number.isSafeInteger(userId) && userId > 0) ||
          (typeof userId === 'string' && /^[1-9]\d*$/.test(userId));
        // Do not reset backoff or announce readiness for a malformed login response.
        if (!validIdentity) { log('warn','onebot.identity_failed',{reason:'invalid_identity'});ws.terminate(); return; }
        this.attempt = 0;
        this.emit('ready', data);
      }).catch(() => { if (this.socket === ws) ws.terminate(); });
    });
    ws.on('pong', () => { if (this.socket === ws) this.awaitingPong = false; });
    ws.on('message', (raw, binary) => {
      if (binary || this.socket !== ws || this.stopped) return;
      let packet: any;
      try { packet = JSON.parse(raw.toString()); } catch { return; }
      if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return;
      if (typeof packet.echo === 'string') {
        const pending = this.pending.get(packet.echo);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(packet.echo);
        if (packet.status === 'ok' && packet.retcode === 0) pending.resolve(packet.data);
        else pending.reject(new OneBotError('api_failed',Number.isSafeInteger(packet.retcode)?packet.retcode:undefined));
      } else if (packet.post_type === 'message') this.emit('message', packet);
      else if (packet.post_type === 'notice' && packet.notice_type === 'group_msg_emoji_like') this.emit('notice', packet);
    });
    ws.on('close', () => {
      if (this.socket !== ws) return;
      this.socket = undefined;
      clearInterval(this.heartbeatTimer);
      this.rejectPending('disconnected');
      this.emit('disconnected');
      if (this.stopped) return;
      const cap = Math.min(this.options.reconnectMaxMs, this.options.reconnectBaseMs * 2 ** Math.min(this.attempt++, 30));
      const delay = Math.max(1, Math.floor(cap * (0.5 + Math.random() * 0.5)));
      log('info','onebot.reconnect_scheduled',{attempt:this.attempt,wait_ms:delay});
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });
  }

  async call(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const started=Date.now();
    try {
    const ws = this.socket;
    if (this.stopped || !ws || ws.readyState !== WebSocket.OPEN) throw new OneBotError('unavailable');
    // No offline queue, no retries, bounded in-flight requests and buffered bytes.
    if (this.pending.size >= 64 || ws.bufferedAmount > 1024 * 1024) throw new OneBotError('busy');
    const echo = randomUUID();
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new OneBotError('timeout'));
      }, this.options.apiTimeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      const fail = () => {
        const pending = this.pending.get(echo);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(echo);
        pending.reject(new OneBotError('send_failed'));
      };
      try { ws.send(JSON.stringify({ action, params, echo }), error => { if (error) fail(); }); }
      catch { fail(); }
    });
    } catch(error) {
      const known = error instanceof OneBotError;
      log('warn','onebot.api_failed',{action,reason:known?error.code:'operation_failed',retcode:known?error.retcode:undefined,duration_ms:Date.now()-started});
      throw error;
    }
  }

  private rejectPending(reason: 'disconnected' | 'stopped'): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new OneBotError(reason));
    }
    this.pending.clear();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    this.rejectPending('stopped');
    const ws = this.socket;
    if (!ws) return;
    if (ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => ws.terminate(), 1000);
      ws.once('close', () => { clearTimeout(timer); resolve(); });
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else ws.close(1000, 'shutdown');
    });
  }
}
