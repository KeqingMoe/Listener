import { lookup as dnsLookup } from "node:dns/promises";
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import { isPublicAddress } from "../images/download.ts";

export type GroupTextDownloader = (
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
) => Promise<string>;
export interface GroupTextDownloadDependencies {
  lookup?: (
    hostname: string,
    options: { all: true; verbatim: true },
  ) => Promise<Array<{ address: string; family: number }>>;
  request?: (
    options: RequestOptions,
    callback: (response: IncomingMessage) => void,
  ) => ClientRequest;
  /** Test-only deadline override. The production singleton always uses 15 seconds. */
  timeoutMs?: number;
}
const MAX_BYTES = 262_144;
const failed = () => new Error("Group text download failed");
const aborted = () => new Error("Group text download aborted");

function validateUrl(value: string): URL {
  if (
    typeof value !== "string" ||
    value.length > 8192 ||
    !/^https?:\/\//i.test(value) ||
    /[\u0000-\u0020\u007f\\#]/.test(value)
  )
    throw failed();
  const url = new URL(value);
  // URL normalizes explicit default ports to empty strings. Reject even an empty
  // credentials marker, not just username/password values after normalization.
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    value.split("/")[2]?.includes("@") ||
    !url.hostname
  )
    throw failed();
  return url;
}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(aborted());
    };
    if (signal.aborted) {
      void work.catch(() => {});
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      () => {
        cleanup();
        reject(failed());
      },
    );
  });
}

/** Internal transport boundary, NOT a model URL tool. Its caller must first resolve
 * a current-group opaque handle through NapCat get_group_file_url. HTTP is needed
 * for native QQ ftn_handler links; every destination is nevertheless public/pinned.
 * Dependencies exist for offline transport tests, never as model-controlled input. */
export function createGroupTextDownloader(
  dependencies: GroupTextDownloadDependencies = {},
): GroupTextDownloader {
  const lookup =
    dependencies.lookup ??
    ((hostname, options) => dnsLookup(hostname, options));
  const request =
    dependencies.request ??
    ((options, callback) =>
      options.protocol === "http:"
        ? httpRequest(options, callback)
        : httpsRequest(options, callback));
  const deadline = dependencies.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 15_000)
    throw failed();
  return async (value, maxBytes, callerSignal) => {
    if (callerSignal?.aborted) throw aborted();
    let url: URL;
    try {
      url = validateUrl(value);
      if (
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > MAX_BYTES
      )
        throw failed();
    } catch {
      throw failed();
    }
    const controller = new AbortController(),
      signal = controller.signal;
    let timedOut = false;
    const cancel = () => controller.abort();
    callerSignal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, deadline);
    try {
      const hostname = url.hostname.startsWith("[")
        ? url.hostname.slice(1, -1)
        : url.hostname;
      const literalFamily = isIP(hostname);
      const addresses = literalFamily
        ? [{ address: hostname, family: literalFamily }]
        : await abortable(
            lookup(hostname, { all: true, verbatim: true }),
            signal,
          );
      if (
        !Array.isArray(addresses) ||
        !addresses.length ||
        addresses.some(
          (entry) =>
            !isPublicAddress(entry.address) ||
            isIP(entry.address) !== entry.family,
        )
      )
        throw failed();
      // Capture primitive values, not a mutable resolver-owned record.
      const { address, family } = addresses[0]!;
      if (signal.aborted) throw aborted();
      const bytes = await new Promise<Buffer>((resolve, reject) => {
        let req: ClientRequest | undefined,
          response: IncomingMessage | undefined,
          settled = false;
        const cleanup = () => signal.removeEventListener("abort", onAbort);
        const finish = (error?: Error, result?: Buffer) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error) {
            reject(error);
            response?.destroy();
            req?.destroy();
          } else resolve(result!);
        };
        const onAbort = () => finish(aborted());
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          return;
        }
        try {
          req = request(
            {
              protocol: url.protocol,
              hostname,
              port: url.protocol === "https:" ? 443 : 80,
              method: "GET",
              path: `${url.pathname}${url.search}`,
              ...(url.protocol === "https:"
                ? {
                    rejectUnauthorized: true,
                    ...(!literalFamily ? { servername: hostname } : {}),
                  }
                : {}),
              agent: false,
              family,
              maxHeaderSize: 16_384,
              // Pin connection DNS while retaining the original host for Host/SNI and
              // native certificate verification. No proxy agent or caller headers.
              lookup: (_hostname, options, callback) => {
                if (options.all) callback(null, [{ address: address, family }]);
                else callback(null, address, family);
              },
              headers: {
                Accept: "text/plain, application/octet-stream;q=0.5",
                "Accept-Encoding": "identity",
              },
            },
            (incoming) => {
              response = incoming;
              incoming.on("error", () => finish(failed()));
              if (settled) {
                incoming.destroy();
                return;
              }
              if (incoming.statusCode !== 200) {
                finish(failed());
                return;
              }
              const encoding = incoming.headers["content-encoding"];
              if (encoding !== undefined && encoding !== "identity") {
                finish(failed());
                return;
              }
              const declared = incoming.headers["content-length"];
              if (
                declared !== undefined &&
                (typeof declared !== "string" ||
                  !/^\d+$/.test(declared) ||
                  Number(declared) > maxBytes)
              ) {
                finish(failed());
                return;
              }
              const chunks: Buffer[] = [];
              let total = 0;
              incoming.on("data", (chunk: unknown) => {
                if (settled) return;
                if (!Buffer.isBuffer(chunk)) {
                  finish(failed());
                  return;
                }
                total += chunk.length;
                if (total > maxBytes) {
                  finish(failed());
                  return;
                }
                if (chunk.length) chunks.push(chunk);
              });
              incoming.on("aborted", () => finish(failed()));
              incoming.on("end", () => {
                if (
                  !incoming.complete ||
                  (declared !== undefined && total !== Number(declared))
                )
                  finish(failed());
                else finish(undefined, Buffer.concat(chunks, total));
              });
              incoming.on("close", () => {
                if (!settled) finish(failed());
              });
            },
          );
          req.on("error", () => finish(failed()));
          if (signal.aborted) onAbort();
          if (settled) req.destroy();
          else req.end();
        } catch {
          finish(failed());
        }
      });
      if (signal.aborted) throw aborted();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      // Permit normal text whitespace (TAB/LF/CR), never NUL/ESC or C1 controls.
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(text))
        throw failed();
      return text;
    } catch {
      throw timedOut
        ? new Error("Group text download timed out")
        : callerSignal?.aborted
          ? aborted()
          : failed();
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", cancel);
    }
  };
}
export const downloadGroupText: GroupTextDownloader =
  createGroupTextDownloader();
