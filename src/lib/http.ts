// Wrapper for every external HTTP call: timeout, bounded retries with backoff.
// Error messages never include request or response bodies (they can hold
// message contents or payment data).

export class HttpError extends Error {
  constructor(
    message: string,
    /** 0 for network errors and timeouts. */
    readonly status: number,
    /** Parsed response body, for callers to inspect. Never log it at info level. */
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface RequestOptions {
  retries?: number;
  timeoutMs?: number;
  baseDelayMs?: number;
  /**
   * Retry after a timeout. Off for non-idempotent calls where a slow success
   * would be repeated (e.g. sending a message twice).
   */
  retryOnTimeout?: boolean;
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export async function requestJson<T = unknown>(url: string, init: RequestInit, opts: RequestOptions = {}): Promise<T> {
  const {
    retries = 3,
    timeoutMs = 10_000,
    baseDelayMs = 250,
    retryOnTimeout = true,
    fetch = globalThis.fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;
  const target = new URL(url);
  const label = `${init.method ?? "GET"} ${target.origin}${target.pathname}`;

  for (let attempt = 0; ; attempt++) {
    const canRetry = attempt < retries;
    const backoff = () => sleep(baseDelayMs * 2 ** attempt * (0.5 + Math.random() / 2));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new HttpError(`${label} timed out after ${timeoutMs}ms`, 0)), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      const timedOut = controller.signal.aborted;
      if (canRetry && (!timedOut || retryOnTimeout)) {
        await backoff();
        continue;
      }
      if (timedOut) throw controller.signal.reason;
      throw new HttpError(`${label} failed: ${(err as Error).message}`, 0);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      // leave as text
    }
    if (res.ok) return body as T;
    if (canRetry && RETRYABLE_STATUS.has(res.status)) {
      await backoff();
      continue;
    }
    throw new HttpError(`${label} returned ${res.status}`, res.status, body);
  }
}
