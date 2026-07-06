import crypto from "node:crypto";

const USER_AGENT = "b2ai-openclaw-b2-sync-backup (backblaze-b2-samples)";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_RETRY_MAX_DELAY_MS = 15_000;
const DEFAULT_RETRY_JITTER_RATIO = 0.25;
const S3_ERROR_CODE_READ_LIMIT_BYTES = 4_096;
const B2_ERROR_BODY_READ_LIMIT_BYTES = 64 * 1_024;

export type B2Client = {
  putObject(bucket: string, key: string, body: Uint8Array, contentType: string): Promise<void>;
  getObject(bucket: string, key: string): Promise<Buffer>;
  listObjects(bucket: string, prefix: string): Promise<B2ObjectEntry[]>;
  deleteObject(bucket: string, key: string): Promise<void>;
  headBucket(bucket: string): Promise<void>;
};

export type B2ClientWithPrefixes = B2Client & {
  listPrefixes(bucket: string, prefix: string): Promise<string[]>;
};

export type B2ObjectEntry = {
  key: string;
  size: number;
  lastModified: string;
};

export type B2ClientLogger = {
  debug?: (msg: string) => void;
  warn?: (msg: string) => void;
};

export type B2ClientOptions = {
  endpoint?: string;
  logger?: B2ClientLogger;
  requestTimeoutMs?: number;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  /** Absolute additive jitter in milliseconds. Mutually exclusive with retryJitterRatio. */
  retryJitterMs?: number;
  /**
   * Fractional jitter around local retry delays.
   * Retry-After jitter is additive only. Mutually exclusive with retryJitterMs.
   */
  retryJitterRatio?: number;
  signal?: AbortSignal;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export class B2ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "B2ConfigError";
  }
}

export class B2RequestError extends Error {
  constructor(
    public readonly operation: string,
    public readonly status: number,
    public readonly body: string,
    public readonly code?: string,
  ) {
    super(`b2 ${operation} failed (${status})${body ? `: ${body}` : ""}`);
    this.name = "B2RequestError";
  }
}

type NormalizedB2ClientOptions = Required<
  Pick<
    B2ClientOptions,
    "requestTimeoutMs" | "maxRetries" | "retryBaseDelayMs" | "retryMaxDelayMs" | "retryJitterRatio"
  >
> &
  Pick<B2ClientOptions, "endpoint" | "logger" | "signal" | "random" | "retryJitterMs" | "sleep">;

type RequestContext = {
  operation: string;
  bucket: string;
  key?: string;
  prefix?: string;
  retryResponse?: (resp: Response) => Promise<RetryDecision | undefined>;
};

type RetryDecision = {
  status: string;
  retryAfterMs?: number;
};

type S3SignParams = {
  method: string;
  path: string;
  query?: Record<string, string>;
  headers: Record<string, string>;
  body: Uint8Array | "";
  payloadHash?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  service?: string;
};

function hmacSha256(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data: Uint8Array | ""): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function getSignatureKey(
  secretKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmacSha256(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

function signRequest(params: S3SignParams): Record<string, string> {
  const { method, path, query, headers, body, region, accessKeyId, secretAccessKey } = params;
  const service = params.service ?? "s3";
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = params.payloadHash ?? sha256Hex(body);

  const signedHeaders = { ...headers };
  signedHeaders["x-amz-date"] = amzDate;
  signedHeaders["x-amz-content-sha256"] = payloadHash;

  const sortedHeaderKeys = Object.keys(signedHeaders).sort();
  const canonicalHeaders = sortedHeaderKeys
    .map((k) => `${k.toLowerCase()}:${signedHeaders[k]!.trim()}`)
    .join("\n");
  const signedHeadersList = sortedHeaderKeys.map((k) => k.toLowerCase()).join(";");

  const queryStr = query
    ? Object.keys(query)
        .sort()
        .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k]!)}`)
        .join("&")
    : "";

  const canonicalRequest = [
    method,
    path,
    queryStr,
    `${canonicalHeaders}\n`,
    signedHeadersList,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(Buffer.from(canonicalRequest, "utf8")),
  ].join("\n");

  const signingKey = getSignatureKey(secretAccessKey, dateStamp, region, service);
  const signature = crypto
    .createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeadersList}, Signature=${signature}`;

  return {
    ...signedHeaders,
    authorization,
  };
}

export {
  signRequest as _signRequest,
  parseListObjectsResponse as _parseListObjectsResponse,
  resolveEndpoint as _resolveEndpoint,
};

export async function createB2Client(
  keyId: string,
  applicationKey: string,
  region?: string,
  endpointOrOptions?: string | B2ClientOptions,
  options?: B2ClientOptions,
): Promise<B2Client> {
  const clientOptions = normalizeClientOptions(endpointOrOptions, options);
  const resolvedRegion = resolveRegion(region);
  const resolvedEndpoint = resolveEndpoint(resolvedRegion, clientOptions.endpoint);
  const endpointHost = new URL(resolvedEndpoint).host;

  const sign = (
    method: string,
    path: string,
    headers: Record<string, string>,
    body: Uint8Array | "" = "",
    query?: Record<string, string>,
    payloadHash?: string,
  ) =>
    signRequest({
      method,
      path,
      query,
      headers: { ...headers, "user-agent": USER_AGENT },
      body,
      payloadHash,
      region: resolvedRegion,
      accessKeyId: keyId,
      secretAccessKey: applicationKey,
    });

  const client: B2ClientWithPrefixes = {
    async putObject(bucket, key, body, contentType) {
      const path = `/${bucket}/${key}`;
      const bodyBytes = body;
      const bodySha256 = sha256Hex(bodyBytes);
      const headers = sign(
        "PUT",
        path,
        {
          host: endpointHost,
          "content-type": contentType,
          "if-none-match": "*",
          "x-amz-meta-sha256": bodySha256,
        },
        bodyBytes,
        undefined,
        bodySha256,
      );
      const resp = await fetchWithRetry(
        `${resolvedEndpoint}${path}`,
        {
          method: "PUT",
          headers,
          body: bodyBytes as BodyInit,
        },
        { operation: "putObject", bucket, key, retryResponse: retryPutObjectResponse },
        clientOptions,
      );
      if (!resp.ok) {
        if (
          resp.status === 412 &&
          (await headObjectMatchesExpected(bucket, key, bodyBytes.byteLength, bodySha256))
        ) {
          await resp.body?.cancel().catch(() => undefined);
          return;
        }
        await throwB2RequestError(resp, "putObject");
      }
    },

    async getObject(bucket, key) {
      const path = `/${bucket}/${key}`;
      const headers = sign("GET", path, { host: endpointHost });
      const resp = await fetchWithRetry(
        `${resolvedEndpoint}${path}`,
        {
          method: "GET",
          headers,
        },
        { operation: "getObject", bucket, key },
        clientOptions,
      );
      if (!resp.ok) {
        await throwB2RequestError(resp, "getObject");
      }
      return Buffer.from(await resp.arrayBuffer());
    },

    async listObjects(bucket, prefix) {
      const all: B2ObjectEntry[] = [];
      let continuationToken: string | undefined;

      do {
        const query: Record<string, string> = {
          "list-type": "2",
          prefix,
          "max-keys": "1000",
        };
        if (continuationToken) {
          query["continuation-token"] = continuationToken;
        }
        const reqPath = `/${bucket}`;
        const headers = sign("GET", reqPath, { host: endpointHost }, "", query);
        const qs = Object.entries(query)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&");
        const resp = await fetchWithRetry(
          `${resolvedEndpoint}${reqPath}?${qs}`,
          {
            method: "GET",
            headers,
          },
          { operation: "listObjects", bucket, prefix },
          clientOptions,
        );
        if (!resp.ok) {
          await throwB2RequestError(resp, "listObjects");
        }
        const xml = await resp.text();
        const page = parseListObjectsResponse(xml);
        all.push(...page.entries);
        continuationToken = page.nextToken;
      } while (continuationToken);

      return all;
    },

    async listPrefixes(bucket, prefix) {
      const all: string[] = [];
      let continuationToken: string | undefined;

      do {
        const query: Record<string, string> = {
          "list-type": "2",
          prefix,
          delimiter: "/",
          "max-keys": "1000",
        };
        if (continuationToken) {
          query["continuation-token"] = continuationToken;
        }
        const reqPath = `/${bucket}`;
        const headers = sign("GET", reqPath, { host: endpointHost }, "", query);
        const qs = Object.entries(query)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join("&");
        const resp = await fetchWithRetry(
          `${resolvedEndpoint}${reqPath}?${qs}`,
          {
            method: "GET",
            headers,
          },
          { operation: "listPrefixes", bucket, prefix },
          clientOptions,
        );
        if (!resp.ok) {
          await throwB2RequestError(resp, "listPrefixes");
        }
        const xml = await resp.text();
        const page = parseListObjectsResponse(xml);
        all.push(...page.prefixes);
        continuationToken = page.nextToken;
      } while (continuationToken);

      return all;
    },

    async deleteObject(bucket, key) {
      const path = `/${bucket}/${key}`;
      const headers = sign("DELETE", path, { host: endpointHost });
      const resp = await fetchWithRetry(
        `${resolvedEndpoint}${path}`,
        {
          method: "DELETE",
          headers,
        },
        { operation: "deleteObject", bucket, key },
        clientOptions,
      );
      if (!resp.ok) {
        await throwB2RequestError(resp, "deleteObject");
      }
    },

    async headBucket(bucket) {
      const path = `/${bucket}`;
      const headers = sign("HEAD", path, { host: endpointHost });
      const resp = await fetchWithRetry(
        `${resolvedEndpoint}${path}`,
        {
          method: "HEAD",
          headers,
        },
        { operation: "headBucket", bucket },
        clientOptions,
      );
      if (!resp.ok) {
        await throwB2RequestError(resp, "headBucket");
      }
    },
  };

  async function headObjectMatchesExpected(
    bucket: string,
    key: string,
    expectedSize: number,
    expectedSha256: string,
  ): Promise<boolean> {
    const path = `/${bucket}/${key}`;
    const headers = sign("HEAD", path, { host: endpointHost });
    const resp = await fetchWithRetry(
      `${resolvedEndpoint}${path}`,
      {
        method: "HEAD",
        headers,
      },
      { operation: "headObject", bucket, key },
      clientOptions,
    );
    await resp.body?.cancel().catch(() => undefined);
    if (!resp.ok) {
      return false;
    }

    const contentLengthHeader = resp.headers.get("content-length");
    if (contentLengthHeader === null) {
      return false;
    }
    const contentLength = Number(contentLengthHeader);
    return (
      Number.isFinite(contentLength) &&
      contentLength === expectedSize &&
      resp.headers.get("x-amz-meta-sha256") === expectedSha256
    );
  }

  return client;
}

async function throwB2RequestError(resp: Response, operation: string): Promise<never> {
  const { text, truncated } = await readResponseTextPrefix(resp, B2_ERROR_BODY_READ_LIMIT_BYTES);
  const body = truncated ? `${text}\n[truncated]` : text;
  throw new B2RequestError(operation, resp.status, body, parseS3ErrorCode(text));
}

function parseS3ErrorCode(body: string): string | undefined {
  return body.match(/<Code>\s*([^<]+?)\s*<\/Code>/i)?.[1]?.trim();
}

function normalizeClientOptions(
  endpointOrOptions?: string | B2ClientOptions,
  options?: B2ClientOptions,
): NormalizedB2ClientOptions {
  const endpoint =
    typeof endpointOrOptions === "string" ? endpointOrOptions : endpointOrOptions?.endpoint;
  const merged = {
    ...(typeof endpointOrOptions === "string" ? undefined : endpointOrOptions),
    ...options,
    endpoint: options?.endpoint ?? endpoint,
  };

  if (merged.retryJitterMs !== undefined && merged.retryJitterRatio !== undefined) {
    throw new B2ConfigError("b2: retryJitterMs and retryJitterRatio are mutually exclusive");
  }

  return {
    endpoint: merged.endpoint,
    logger: merged.logger,
    signal: merged.signal,
    random: merged.random,
    sleep: merged.sleep,
    requestTimeoutMs: positiveNumber(
      merged.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    ),
    maxRetries: nonNegativeInteger(merged.maxRetries, DEFAULT_MAX_RETRIES, "maxRetries"),
    retryBaseDelayMs: nonNegativeNumber(
      merged.retryBaseDelayMs,
      DEFAULT_RETRY_BASE_DELAY_MS,
      "retryBaseDelayMs",
    ),
    retryMaxDelayMs: nonNegativeNumber(
      merged.retryMaxDelayMs,
      DEFAULT_RETRY_MAX_DELAY_MS,
      "retryMaxDelayMs",
    ),
    retryJitterMs: optionalNonNegativeNumber(merged.retryJitterMs, "retryJitterMs"),
    retryJitterRatio: ratioNumber(
      merged.retryJitterRatio,
      DEFAULT_RETRY_JITTER_RATIO,
      "retryJitterRatio",
    ),
  };
}

function positiveNumber(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new B2ConfigError(`b2: ${name} must be a positive finite number`);
  }
  return resolved;
}

function nonNegativeNumber(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new B2ConfigError(`b2: ${name} must be a non-negative finite number`);
  }
  return resolved;
}

function optionalNonNegativeNumber(value: number | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new B2ConfigError(`b2: ${name} must be a non-negative finite number`);
  }
  return value;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new B2ConfigError(`b2: ${name} must be a non-negative finite integer`);
  }
  return resolved;
}

function ratioNumber(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
    throw new B2ConfigError(`b2: ${name} must be a finite number between 0 and 1`);
  }
  return resolved;
}

function resolveRegion(region: string | undefined): string {
  const resolvedRegion = region?.trim().toLowerCase();
  if (!resolvedRegion) {
    throw new B2ConfigError(
      "b2: region is required; set region in plugin config or B2_REGION. " +
        "Native B2 region discovery was removed so storage requests stay on the S3-compatible API.",
    );
  }
  return resolvedRegion;
}

function resolveEndpoint(region: string, endpoint?: string): string {
  const expectedHost = `s3.${region}.backblazeb2.com`;
  const rawEndpoint = endpoint?.trim() || `https://${expectedHost}`;
  let url: URL;
  try {
    url = new URL(rawEndpoint);
  } catch {
    throw new B2ConfigError("b2: endpoint must be a valid URL");
  }

  if (url.protocol !== "https:") {
    throw new B2ConfigError("b2: endpoint must use https");
  }
  if (url.username || url.password) {
    throw new B2ConfigError("b2: endpoint must not contain credentials");
  }
  if (url.hostname !== expectedHost) {
    throw new B2ConfigError(`b2: endpoint host must be ${expectedHost}`);
  }
  if (url.port) {
    throw new B2ConfigError("b2: endpoint must not include a custom port");
  }
  if (url.pathname && url.pathname !== "/") {
    throw new B2ConfigError("b2: endpoint must not include a path");
  }

  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.origin;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  context: RequestContext,
  options: NormalizedB2ClientOptions,
): Promise<Response> {
  const maxAttempts = options.maxRetries + 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = Date.now();
    const { signal, cleanup } = createAttemptSignal(options.signal, options.requestTimeoutMs);
    try {
      const resp = await fetch(url, { ...init, signal });
      const elapsedMs = Date.now() - startedAt;
      const retryDecision = await retryableResponseDecision(resp, context);
      const status = retryDecision?.status ?? String(resp.status);
      logAttempt(options, context, attempt, maxAttempts, status, elapsedMs);

      if (!retryDecision || attempt === maxAttempts) {
        return resp;
      }

      await resp.body?.cancel().catch(() => undefined);
      await waitBeforeRetry(options, context, attempt, maxAttempts, retryDecision, elapsedMs);
    } catch (err) {
      const elapsedMs = Date.now() - startedAt;
      const status = options.signal?.aborted ? "aborted" : signal.aborted ? "timeout" : "network-error";
      lastError = err;
      logAttempt(options, context, attempt, maxAttempts, status, elapsedMs);

      if (attempt === maxAttempts || options.signal?.aborted) {
        throw err;
      }

      await waitBeforeRetry(options, context, attempt, maxAttempts, { status }, elapsedMs);
    } finally {
      cleanup();
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function createAttemptSignal(parentSignal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  const timeout = setTimeout(
    () => controller.abort(new Error(`b2 request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  timeout.unref?.();

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

async function waitBeforeRetry(
  options: NormalizedB2ClientOptions,
  context: RequestContext,
  attempt: number,
  maxAttempts: number,
  retryDecision: RetryDecision,
  elapsedMs: number,
): Promise<void> {
  if (options.signal?.aborted) {
    throw abortReason(options.signal);
  }
  const delayMs = retryDelayMs(options, attempt, retryDecision.retryAfterMs);
  options.logger?.warn?.(
    `b2 ${context.operation}: retrying ${formatTarget(context)} attempt=${attempt}/${maxAttempts} status=${retryDecision.status} elapsedMs=${elapsedMs} nextDelayMs=${delayMs}`,
  );
  await sleepWithSignal(delayMs, options.signal, options.sleep);
}

function retryDelayMs(
  options: NormalizedB2ClientOptions,
  attempt: number,
  retryAfterMs?: number,
): number {
  const selectedDelay = retryAfterMs ?? options.retryBaseDelayMs * 2 ** (attempt - 1);
  const random = options.random ?? Math.random;
  const jitteredDelay =
    retryAfterMs === undefined
      ? applyRetryJitter(selectedDelay, options, random)
      : applyRetryAfterJitter(selectedDelay, options, random);
  return Math.min(options.retryMaxDelayMs, Math.max(0, Math.floor(jitteredDelay)));
}

function applyRetryJitter(
  delayMs: number,
  options: NormalizedB2ClientOptions,
  random: () => number,
): number {
  return options.retryJitterMs === undefined
    ? applyRatioJitter(delayMs, options.retryJitterRatio, random)
    : delayMs + Math.floor(random() * options.retryJitterMs);
}

function applyRetryAfterJitter(
  delayMs: number,
  options: NormalizedB2ClientOptions,
  random: () => number,
): number {
  if (options.retryJitterMs !== undefined) {
    return delayMs + Math.floor(random() * options.retryJitterMs);
  }
  return delayMs + random() * delayMs * options.retryJitterRatio;
}

function applyRatioJitter(delayMs: number, ratio: number, random: () => number): number {
  if (delayMs === 0 || ratio === 0) {
    return delayMs;
  }
  const jitterRange = delayMs * ratio;
  return delayMs - jitterRange + random() * jitterRange * 2;
}

async function sleepWithSignal(
  ms: number,
  signal: AbortSignal | undefined,
  customSleep: ((ms: number) => Promise<void>) | undefined,
): Promise<void> {
  if (!signal && customSleep) {
    await customSleep(ms);
    return;
  }
  if (!signal) {
    await sleep(ms);
    return;
  }
  if (signal.aborted) {
    throw abortReason(signal);
  }
  if (!customSleep) {
    await sleep(ms, signal);
    return;
  }

  let onAbort!: () => void;
  const aborted = new Promise<void>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([customSleep(ms), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise((resolve, reject) => {
    let onAbort: (() => void) | undefined;
    const timeout = setTimeout(() => {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timeout.unref?.();
    if (signal) {
      onAbort = () => {
        clearTimeout(timeout);
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("b2 request aborted");
}

async function retryableResponseDecision(
  resp: Response,
  context: RequestContext,
): Promise<RetryDecision | undefined> {
  if (resp.status === 408 || resp.status === 429 || resp.status >= 500) {
    return {
      status: String(resp.status),
      retryAfterMs: retryAfterDelayMs(resp),
    };
  }

  return context.retryResponse?.(resp);
}

async function retryPutObjectResponse(resp: Response): Promise<RetryDecision | undefined> {
  if (resp.status !== 400) {
    return undefined;
  }

  const code = await readS3ErrorCode(resp.clone(), S3_ERROR_CODE_READ_LIMIT_BYTES);
  return code === "IncompleteBody" ? { status: "400 IncompleteBody" } : undefined;
}

async function readS3ErrorCode(resp: Response, maxBytes: number): Promise<string | undefined> {
  const { text } = await readResponseTextPrefix(resp, maxBytes, (bodyPrefix) =>
    parseS3ErrorCode(bodyPrefix) !== undefined,
  );
  return parseS3ErrorCode(text);
}

async function readResponseTextPrefix(
  resp: Response,
  maxBytes: number,
  shouldStop?: (text: string) => boolean,
): Promise<{ text: string; truncated: boolean }> {
  if (!resp.body || maxBytes <= 0) {
    return { text: "", truncated: false };
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytesRead = 0;
  let doneReading = false;
  let truncated = false;

  try {
    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done) {
        doneReading = true;
        break;
      }

      const remainingBytes = maxBytes - bytesRead;
      const chunk = value.subarray(0, remainingBytes);
      bytesRead += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });

      if (shouldStop?.(text)) {
        truncated = true;
        break;
      }
      if (chunk.byteLength < value.byteLength) {
        truncated = true;
        break;
      }
    }
  } catch {
    return { text, truncated: true };
  } finally {
    if (!doneReading) {
      truncated = true;
      void reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }

  text += decoder.decode();
  return { text, truncated };
}

function retryAfterDelayMs(resp: Response): number | undefined {
  if (resp.status !== 429 && resp.status !== 503) {
    return undefined;
  }

  const value = resp.headers.get("retry-after")?.trim();
  if (!value) {
    return undefined;
  }

  if (/^\d+$/.test(value)) {
    return Number(value) * 1_000;
  }

  const retryAtMs = Date.parse(value);
  if (!Number.isFinite(retryAtMs)) {
    return undefined;
  }

  return Math.max(0, retryAtMs - Date.now());
}

function logAttempt(
  options: NormalizedB2ClientOptions,
  context: RequestContext,
  attempt: number,
  maxAttempts: number,
  status: string,
  elapsedMs: number,
): void {
  options.logger?.debug?.(
    `b2 ${context.operation}: ${formatTarget(context)} attempt=${attempt}/${maxAttempts} status=${status} elapsedMs=${elapsedMs}`,
  );
}

function formatTarget(context: RequestContext): string {
  const parts = [`bucket=${context.bucket}`];
  if (context.key) {
    parts.push(`key=${context.key}`);
  }
  if (context.prefix) {
    parts.push(`prefix=${context.prefix}`);
  }
  return parts.join(" ");
}

type ListObjectsPage = {
  entries: B2ObjectEntry[];
  prefixes: string[];
  nextToken: string | undefined;
};

function parseListObjectsResponse(xml: string): ListObjectsPage {
  const entries: B2ObjectEntry[] = [];
  const contentRegex = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match: RegExpExecArray | null;
  while ((match = contentRegex.exec(xml)) !== null) {
    const block = match[1]!;
    const key = block.match(/<Key>(.*?)<\/Key>/)?.[1] ?? "";
    const size = Number(block.match(/<Size>(.*?)<\/Size>/)?.[1] ?? "0");
    const lastModified = block.match(/<LastModified>(.*?)<\/LastModified>/)?.[1] ?? "";
    entries.push({ key, size, lastModified });
  }

  const prefixes: string[] = [];
  const commonPrefixRegex = /<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g;
  while ((match = commonPrefixRegex.exec(xml)) !== null) {
    const block = match[1]!;
    const prefix = normalizeXmlText(block.match(/<Prefix>([\s\S]*?)<\/Prefix>/)?.[1] ?? "");
    if (prefix) {
      prefixes.push(prefix);
    }
  }

  const isTruncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const nextToken = isTruncated
    ? xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/)?.[1]
    : undefined;

  return { entries, prefixes, nextToken };
}

function normalizeXmlText(text: string): string {
  return text
    .replace(/\r\n|\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("");
}
