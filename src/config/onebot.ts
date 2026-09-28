export interface Config {
  url: string;
  token: string;
  allowedGroups: Set<string>;
  allowedUsers: Set<string>;
  adminUsers: Set<string>;
  allowPrivate: boolean;
  apiTimeoutMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  heartbeatMs: number;
  rateLimitMs: number;
  dedupTtlMs: number;
  dedupMax: number;
  conversationMax: number;
}
