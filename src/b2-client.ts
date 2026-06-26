import crypto from "node:crypto";

const USER_AGENT = "b2ai-openclaw (backblaze-b2-samples)";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_RETRY_JITTER_MS = 250;

export type B2Client = {
  putObject(bucket: string, key: string, body: Uint8Array, contentType: string): Promise<void>;
  getObject(bucket: string, key: string): Promise<Buffer>;
  listObjects(bucket: string, prefix: string): Promise<B2ObjectEntry[]>;
  deleteObject(bucket: string, key: string): Promise<void>;
  headBucket(bucket: string): Promise<void>;
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
  retryJitterMs?: number;
  signal?: AbortSignal;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

type NormalizedB2ClientOptions = Required<
  Pick<B2ClientOptions, "requestTimeoutMs" | "maxRetries" | "retryBaseDelayMs" | "retryJitterMs">
> &
  Pick<B2ClientOptions, "endpoint" | "logger" | "signal" | "random" | "sleep">;

type RequestContext = {
  operation: string;
  bucket: string;
  key?: string;
  prefix?: string;
};

type S3SignParams = {
  method: string;
  path: string;
  query?: Record<string, string>;
  headers: Record<string, string>;
  body: Uint8Array | "";
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
  const payloadHash = sha256Hex(body);

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
  ) =>
    signRequest({
      method,
      path,
      query,
      headers: { ...headers, "user-agent": USER_AGENT },
      body,
      region: resolvedRegion,
      accessKeyId: keyId,
      secretAccessKey: applicationKey,
    });

  return {
    async putObject(bucket, key, body, contentType) {
      const path = `/${bucket}/${key}`;
      const headers = sign("PUT", path, { host: endpointHost, "content-type": contentType }, body);
      const resp = await fetchWithRetry(
        `${resolvedEndpoint}${path}`,
        {
          method: "PUT",
          headers,
          body: new Uint8Array(body),
        },
        { operation: "putObject", bucket, key },
        clientOptions,
      );
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`b2 putObject failed (${resp.status}): ${text}`);
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
        const text = await resp.text().catch(() => "");
        throw new Error(`b2 getObject failed (${resp.status}): ${text}`);
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
          const text = await resp.text().catch(() => "");
          throw new Error(`b2 listObjects failed (${resp.status}): ${text}`);
        }
        const xml = await resp.text();
        const page = parseListObjectsResponse(xml);
        all.push(...page.entries);
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
        const text = await resp.text().catch(() => "");
        throw new Error(`b2 deleteObject failed (${resp.status}): ${text}`);
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
        throw new Error(`b2 headBucket failed (${resp.status})`);
      }
    },
  };
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
    retryJitterMs: nonNegativeNumber(
      merged.retryJitterMs,
      DEFAULT_RETRY_JITTER_MS,
      "retryJitterMs",
    ),
  };
}

function positiveNumber(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(`b2: ${name} must be a positive finite number`);
  }
  return resolved;
}

function nonNegativeNumber(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new Error(`b2: ${name} must be a non-negative finite number`);
  }
  return resolved;
}

function nonNegativeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0) {
    throw new Error(`b2: ${name} must be a non-negative finite integer`);
  }
  return resolved;
}

function resolveRegion(region: string | undefined): string {
  const resolvedRegion = region?.trim().toLowerCase();
  if (!resolvedRegion) {
    throw new Error(
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
    throw new Error("b2: endpoint must be a valid URL");
  }

  if (url.protocol !== "https:") {
    throw new Error("b2: endpoint must use https");
  }
  if (url.username || url.password) {
    throw new Error("b2: endpoint must not contain credentials");
  }
  if (url.hostname !== expectedHost) {
    throw new Error(`b2: endpoint host must be ${expectedHost}`);
  }
  if (url.port) {
    throw new Error("b2: endpoint must not include a custom port");
  }
  if (url.pathname && url.pathname !== "/") {
    throw new Error("b2: endpoint must not include a path");
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
      logAttempt(options, context, attempt, maxAttempts, String(resp.status), elapsedMs);

      if (!isRetryableStatus(resp.status) || attempt === maxAttempts) {
        return resp;
      }

      await resp.body?.cancel().catch(() => undefined);
      await waitBeforeRetry(options, context, attempt, maxAttempts, String(resp.status), elapsedMs);
    } catch (err) {
      const elapsedMs = Date.now() - startedAt;
      const status = options.signal?.aborted ? "aborted" : signal.aborted ? "timeout" : "network-error";
      lastError = err;
      logAttempt(options, context, attempt, maxAttempts, status, elapsedMs);

      if (attempt === maxAttempts || options.signal?.aborted) {
        throw err;
      }

      await waitBeforeRetry(options, context, attempt, maxAttempts, status, elapsedMs);
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
  status: string,
  elapsedMs: number,
): Promise<void> {
  if (options.signal?.aborted) {
    throw abortReason(options.signal);
  }
  const delayMs = retryDelayMs(options, attempt);
  options.logger?.warn?.(
    `b2 ${context.operation}: retrying ${formatTarget(context)} attempt=${attempt}/${maxAttempts} status=${status} elapsedMs=${elapsedMs} nextDelayMs=${delayMs}`,
  );
  await sleepWithSignal(delayMs, options.signal, options.sleep);
}

function retryDelayMs(options: NormalizedB2ClientOptions, attempt: number): number {
  const jitter =
    options.retryJitterMs > 0
      ? Math.floor((options.random ?? Math.random)() * options.retryJitterMs)
      : 0;
  return options.retryBaseDelayMs * 2 ** (attempt - 1) + jitter;
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

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
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

  const isTruncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const nextToken = isTruncated
    ? xml.match(/<NextContinuationToken>(.*?)<\/NextContinuationToken>/)?.[1]
    : undefined;

  return { entries, nextToken };
}
