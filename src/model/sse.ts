export class SseError extends Error {
  constructor(readonly code: 'invalid_response' | 'response_too_large') { super(code); }
}
export interface SseOptions {
  maxBytes: number;
  signal?: AbortSignal;
  onBytes?: (bytes: Uint8Array) => void;
}
/** Bounded UTF-8 SSE framing. Events completed in one read share its arrival timestamp.
 * Protocol-specific completion belongs to the caller; EOF without it is an error.
 */
export async function readSse(body: ReadableStream<Uint8Array>, onEvent: (data: string, at: number) => boolean | void, options: SseOptions): Promise<void> {
  const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let line = '', data: string[] = [], size = 0, skipLf = false;
  const consumeLine = (at: number): boolean => {
    const current = line; line = '';
    if (!current) {
      if (!data.length) return false;
      const payload = data.join('\n'); data = [];
      return onEvent(payload, at) === true;
    }
    const colon = current.indexOf(':');
    const field = colon < 0 ? current : current.slice(0, colon);
    if (field === 'data') data.push(colon < 0 ? '' : current.slice(colon + 1).replace(/^ /, ''));
    // Comments, event/id/retry and unknown fields do not contribute data.
    return false;
  };
  const abort = () => { void reader.cancel().catch(() => {}); };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (options.signal?.aborted) throw new SseError('invalid_response');
      const part = await reader.read(), at = performance.now();
      if (options.signal?.aborted || part.done) throw new SseError('invalid_response');
      const remaining = Math.max(0, options.maxBytes - size);
      options.onBytes?.(part.value.subarray(0, remaining));
      size += part.value.byteLength;
      if (size > options.maxBytes) throw new SseError('response_too_large');
      let text: string;
      try { text = decoder.decode(part.value, { stream: true }); }
      catch { throw new SseError('invalid_response'); }
      for (const char of text) {
        if (skipLf) { skipLf = false; if (char === '\n') continue; }
        if (char === '\r' || char === '\n') {
          skipLf = char === '\r';
          if (consumeLine(at)) return;
        } else line += char;
      }
    }
  } finally {
    options.signal?.removeEventListener('abort', abort);
    try { await reader.cancel(); } catch { /* Original stream failure wins. */ }
    reader.releaseLock();
  }
}
