import type { JsonObject } from './json.ts';

export interface Api {
  call(action: string, params?: JsonObject): Promise<unknown>;
}
