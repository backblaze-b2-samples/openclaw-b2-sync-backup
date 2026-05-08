import type { B2Client } from "./b2-client.js";

type RetryLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

/**
 * Decide whether a `b2.putObject` rejection is worth retrying. Network-level
 * failures and B2 transient errors return `true`; logical/permission errors
 * return `false` (retrying them just wastes time and hammers the bucket).
 */
export function isRetryablePutError(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err);

  // Node fetch failures: connection reset / DNS / TLS / etc.
  if (msg.includes("fetch failed")) return true;

  // The b2 client throws "b2 putObject failed (<status>): <body>".
  const m = msg.match(/b2 putObject failed \((\d+)\)/);
  if (!m) return false;
  const status = Number(m[1]);

  if (status >= 500) return true; // Backblaze server-side blip
  if (status === 408 || status === 429) return true; // timeout / rate limit

  // 400 IncompleteBody is what B2 returns when a PUT body arrives shorter
  // than the Content-Length header — i.e. the connection dropped mid-upload.
  // It looks like a 4xx but it's a transient transport failure, retryable.
  if (status === 400 && msg.includes("IncompleteBody")) return true;

  return false;
}

export type PutObjectWithRetryOptions = {
  /** Max attempts (default 6: initial + 5 retries). */
  maxAttempts?: number;
  /** Base delay before exponential backoff, in ms (default 500). */
  baseDelayMs?: number;
  /** Cap on per-attempt delay, in ms (default 15000). */
  maxDelayMs?: number;
  /** Override `setTimeout` (test seam). */
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Wrap `b2.putObject` with exponential-backoff-with-jitter retry on transient
 * failures (network drops, B2 5xx, B2 400 IncompleteBody). Non-retryable
 * errors propagate immediately.
 *
 * Without this wrapper, a 25k-file push that takes 15+ minutes can be aborted
 * by a single transient blip, since `Promise.all` rejects on first error.
 */
export async function putObjectWithRetry(
  b2: B2Client,
  bucket: string,
  key: string,
  body: Uint8Array,
  contentType: string,
  logger: RetryLogger,
  label: string = key,
  options?: PutObjectWithRetryOptions,
): Promise<void> {
  const maxAttempts = options?.maxAttempts ?? 6;
  const baseDelayMs = options?.baseDelayMs ?? 500;
  const maxDelayMs = options?.maxDelayMs ?? 15_000;
  const sleep =
    options?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await b2.putObject(bucket, key, body, contentType);
      if (attempt > 1) {
        logger.info(`b2-backup: putObject succeeded on attempt ${attempt} for ${label}`);
      }
      return;
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts || !isRetryablePutError(err)) throw err;
      const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jittered = Math.round(exp * (0.75 + Math.random() * 0.5));
      const reason = String((err as { message?: unknown })?.message ?? err)
        .split("\n")[0]!
        .slice(0, 160);
      logger.warn(
        `b2-backup: putObject attempt ${attempt}/${maxAttempts} failed for ${label}: ${reason} — retrying in ${jittered}ms`,
      );
      await sleep(jittered);
    }
  }
  throw lastErr;
}
