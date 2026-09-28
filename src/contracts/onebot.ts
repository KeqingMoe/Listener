import type { JsonObject } from './json.js';

export interface Api { call(action: string, params?: JsonObject): Promise<unknown> }
