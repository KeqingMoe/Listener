export interface Config {
  url: string;
  token: string;
  apiTimeoutMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  heartbeatMs: number;
}
