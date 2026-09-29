// Fetching web pages from links people post (listing previews). The URLs are
// user-supplied, so guard against SSRF: http(s) on standard ports only, no
// credentials, no internal hostnames, no private/loopback/link-local IPs,
// checked on every redirect and again at connect time (defeats DNS rebinding),
// with a timeout and a size cap.

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** Injected in tests; production uses undici with a connect-time address check. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

const BLOCKED_HOSTS = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number, number, number];
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return (
      lower === "::" || lower === "::1" ||
      /^f[cd]/.test(lower) || // fc00::/7 unique local
      /^fe[89ab]/.test(lower) || // fe80::/10 link local
      /^ff/.test(lower) || // multicast
      lower.startsWith("64:ff9b:") // NAT64
    );
  }
  return true; // not an IP at all: treat as unsafe
}

/** Validates a URL before any request. Throws a short, safe message. */
export function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("that isn't a valid link");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http and https links can be read");
  if (url.username || url.password) throw new Error("links with credentials can't be read");
  if (url.port && url.port !== "80" && url.port !== "443") throw new Error("links on unusual ports can't be read");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTS.test(host) || !host.includes(".") && !isIP(host)) throw new Error("that address is not allowed");
  if (isIP(host) && isPrivateAddress(host)) throw new Error("that address is not allowed");
  return url;
}

type Resolver = (host: string) => Promise<Array<{ address: string; family: number }>>;
type LookupCallback = (err: Error | null, address?: string | Array<{ address: string; family: number }>, family?: number) => void;

/** A `net` lookup that refuses names resolving to any private address. Used at connect time. */
export function safeLookup(resolve: Resolver = (host) => dnsLookup(host, { all: true, verbatim: true })) {
  return (hostname: string, options: { all?: boolean } | number | undefined, callback: LookupCallback) => {
    resolve(hostname).then(
      (addresses) => {
        if (!addresses.length) return callback(new Error(`could not resolve ${hostname}`));
        if (addresses.some((a) => isPrivateAddress(a.address))) return callback(new Error("that link points to a private address"));
        if (typeof options === "object" && options?.all) return callback(null, addresses);
        callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (err: Error) => callback(err),
    );
  };
}

let guardedFetch: SafeFetchOptions["fetch"] | undefined;

async function defaultFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!guardedFetch) {
    const { Agent, fetch } = await import("undici");
    const dispatcher = new Agent({ connect: { lookup: safeLookup() as never } });
    guardedFetch = (u, i) => fetch(u, { ...(i as object), dispatcher } as never) as unknown as Promise<Response>;
  }
  return guardedFetch(url, init);
}

/** Fetches an HTML page, following up to a few redirects, each re-checked. */
export async function safeFetchText(raw: string, opts: SafeFetchOptions = {}): Promise<{ url: string; text: string }> {
  const fetchFn = opts.fetch ?? defaultFetch;
  const maxBytes = opts.maxBytes ?? 1_500_000;
  const timeoutMs = opts.timeoutMs ?? 6000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let url = checkUrl(raw);
    for (let hop = 0; ; hop++) {
      let res: Response;
      try {
        res = await fetchFn(url.toString(), {
          redirect: "manual",
          signal: controller.signal,
          headers: {
            "user-agent": "NodLinkPreview/1.0 (+https://nod.example/bot)",
            accept: "text/html,application/xhtml+xml",
            "accept-language": "en-US,en;q=0.8",
          },
        });
      } catch (err) {
        if (controller.signal.aborted) throw new Error("the page timed out");
        throw err;
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        if (hop >= (opts.maxRedirects ?? 4)) throw new Error("too many redirects");
        url = checkUrl(new URL(res.headers.get("location")!, url).toString());
        continue;
      }
      if (!res.ok) throw new Error(`the page returned ${res.status}`);
      const type = res.headers.get("content-type") ?? "";
      if (!/text\/html|application\/xhtml/i.test(type)) throw new Error("that link is not a web page");
      return { url: url.toString(), text: await readCapped(res, maxBytes, controller) };
    }
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res: Response, maxBytes: number, controller: AbortController): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } catch (err) {
    if (controller.signal.aborted) throw new Error("the page timed out");
    throw err;
  } finally {
    reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(Math.min(size, maxBytes));
  let offset = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, all.length - offset);
    all.set(c.subarray(0, take), offset);
    offset += take;
    if (offset >= all.length) break;
  }
  return new TextDecoder().decode(all);
}
