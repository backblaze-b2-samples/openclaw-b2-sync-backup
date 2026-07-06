import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _parseListObjectsResponse as parseListObjectsResponse,
  _resolveEndpoint as resolveEndpoint,
  _signRequest as signRequest,
  B2ConfigError,
  B2RequestError,
  createB2Client,
} from "./b2-client.js";

const USER_AGENT = "b2ai-openclaw-b2-sync-backup (backblaze-b2-samples)";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("b2-client Sig V4 signing", () => {
  // Use fixed time for deterministic test vectors
  const fixedDate = new Date("2026-02-19T12:00:00.000Z");

  it("produces correct authorization header structure", () => {
    const originalDate = globalThis.Date;
    globalThis.Date = class extends originalDate {
      constructor() {
        super();
        return fixedDate;
      }
      static now() {
        return fixedDate.getTime();
      }
    } as typeof Date;

    try {
      const headers = signRequest({
        method: "GET",
        path: "/my-bucket/test-key",
        headers: { host: "s3.test-region.backblazeb2.com" },
        body: "",
        region: "test-region",
        accessKeyId: "004test",
        secretAccessKey: "K004secret",
      });

      expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
      expect(headers.authorization).toContain("004test");
      expect(headers.authorization).toContain("20260219/test-region/s3/aws4_request");
      expect(headers.authorization).toContain("SignedHeaders=");
      expect(headers.authorization).toContain("Signature=");
      expect(headers["x-amz-date"]).toBe("20260219T120000Z");
      expect(headers["x-amz-content-sha256"]).toBeTruthy();
    } finally {
      globalThis.Date = originalDate;
    }
  });

  it("includes content hash for non-empty body", () => {
    const originalDate = globalThis.Date;
    globalThis.Date = class extends originalDate {
      constructor() {
        super();
        return fixedDate;
      }
      static now() {
        return fixedDate.getTime();
      }
    } as typeof Date;

    try {
      const body = Buffer.from("test content");
      const headers = signRequest({
        method: "PUT",
        path: "/my-bucket/upload",
        headers: {
          host: "s3.test-region.backblazeb2.com",
          "content-type": "application/octet-stream",
        },
        body,
        region: "test-region",
        accessKeyId: "004test",
        secretAccessKey: "K004secret",
      });

      expect(headers["x-amz-content-sha256"]).toBeTruthy();
      // Non-empty body should produce different hash than empty
      const emptyHeaders = signRequest({
        method: "PUT",
        path: "/my-bucket/upload",
        headers: {
          host: "s3.test-region.backblazeb2.com",
          "content-type": "application/octet-stream",
        },
        body: "",
        region: "test-region",
        accessKeyId: "004test",
        secretAccessKey: "K004secret",
      });
      expect(headers["x-amz-content-sha256"]).not.toBe(
        emptyHeaders["x-amz-content-sha256"],
      );
    } finally {
      globalThis.Date = originalDate;
    }
  });

  it("uses a precomputed payload hash when provided", () => {
    const payloadHash = "a".repeat(64);
    const headers = signRequest({
      method: "PUT",
      path: "/my-bucket/upload",
      headers: {
        host: "s3.test-region.backblazeb2.com",
        "content-type": "application/octet-stream",
      },
      body: Buffer.from("hash would differ"),
      payloadHash,
      region: "test-region",
      accessKeyId: "004test",
      secretAccessKey: "K004secret",
    });

    expect(headers["x-amz-content-sha256"]).toBe(payloadHash);
  });

  it("sorts headers for canonical request", () => {
    const originalDate = globalThis.Date;
    globalThis.Date = class extends originalDate {
      constructor() {
        super();
        return fixedDate;
      }
      static now() {
        return fixedDate.getTime();
      }
    } as typeof Date;

    try {
      const headers = signRequest({
        method: "GET",
        path: "/bucket/key",
        headers: {
          host: "s3.test-region.backblazeb2.com",
          "content-type": "text/plain",
        },
        body: "",
        region: "test-region",
        accessKeyId: "004test",
        secretAccessKey: "K004secret",
      });

      // SignedHeaders should be alphabetically sorted
      const signedHeadersMatch = headers.authorization.match(/SignedHeaders=([^,]+)/);
      expect(signedHeadersMatch).toBeTruthy();
      const headerList = signedHeadersMatch![1]!.split(";");
      const sorted = [...headerList].sort();
      expect(headerList).toEqual(sorted);
    } finally {
      globalThis.Date = originalDate;
    }
  });

  it("includes user-agent in signed headers when provided", () => {
    const originalDate = globalThis.Date;
    globalThis.Date = class extends originalDate {
      constructor() {
        super();
        return fixedDate;
      }
      static now() {
        return fixedDate.getTime();
      }
    } as typeof Date;

    try {
      const headers = signRequest({
        method: "GET",
        path: "/bucket/key",
        headers: {
          host: "s3.test-region.backblazeb2.com",
          "user-agent": USER_AGENT,
        },
        body: "",
        region: "test-region",
        accessKeyId: "004test",
        secretAccessKey: "K004secret",
      });

      expect(headers["user-agent"]).toBe(USER_AGENT);
      expect(headers.authorization).toContain("user-agent");
    } finally {
      globalThis.Date = originalDate;
    }
  });

  it("handles query parameters", () => {
    const originalDate = globalThis.Date;
    globalThis.Date = class extends originalDate {
      constructor() {
        super();
        return fixedDate;
      }
      static now() {
        return fixedDate.getTime();
      }
    } as typeof Date;

    try {
      const headers = signRequest({
        method: "GET",
        path: "/bucket",
        query: { "list-type": "2", prefix: "my-prefix", "max-keys": "100" },
        headers: { host: "s3.test-region.backblazeb2.com" },
        body: "",
        region: "test-region",
        accessKeyId: "004test",
        secretAccessKey: "K004secret",
      });

      expect(headers.authorization).toBeTruthy();
    } finally {
      globalThis.Date = originalDate;
    }
  });
});

describe("parseListObjectsResponse", () => {
  it("parses entries from XML", () => {
    const xml = `<ListBucketResult>
      <IsTruncated>false</IsTruncated>
      <Contents><Key>prefix/file1.txt</Key><Size>100</Size><LastModified>2026-01-01</LastModified></Contents>
      <Contents><Key>prefix/file2.txt</Key><Size>200</Size><LastModified>2026-01-02</LastModified></Contents>
    </ListBucketResult>`;
    const page = parseListObjectsResponse(xml);
    expect(page.entries).toHaveLength(2);
    expect(page.entries[0]).toEqual({
      key: "prefix/file1.txt",
      size: 100,
      lastModified: "2026-01-01",
    });
    expect(page.nextToken).toBeUndefined();
  });

  it("returns nextToken when truncated", () => {
    const xml = `<ListBucketResult>
      <IsTruncated>true</IsTruncated>
      <NextContinuationToken>abc123</NextContinuationToken>
      <Contents><Key>prefix/file1.txt</Key><Size>100</Size><LastModified>2026-01-01</LastModified></Contents>
    </ListBucketResult>`;
    const page = parseListObjectsResponse(xml);
    expect(page.entries).toHaveLength(1);
    expect(page.nextToken).toBe("abc123");
  });

  it("returns no nextToken when not truncated", () => {
    const xml = `<ListBucketResult>
      <IsTruncated>false</IsTruncated>
      <Contents><Key>prefix/file1.txt</Key><Size>50</Size><LastModified>2026-01-01</LastModified></Contents>
    </ListBucketResult>`;
    const page = parseListObjectsResponse(xml);
    expect(page.nextToken).toBeUndefined();
  });

  it("handles empty result", () => {
    const xml = `<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>`;
    const page = parseListObjectsResponse(xml);
    expect(page.entries).toEqual([]);
    expect(page.prefixes).toEqual([]);
    expect(page.nextToken).toBeUndefined();
  });

  it("parses common prefixes from delimiter listings", () => {
    const xml = `<ListBucketResult>
      <IsTruncated>false</IsTruncated>
      <CommonPrefixes><Prefix>openclaw-backup/2026-01-01T00-00-00Z/</Prefix></CommonPrefixes>
      <CommonPrefixes><Prefix>openclaw-backup/safety-2026-01-02T00-00-00Z/</Prefix></CommonPrefixes>
    </ListBucketResult>`;
    const page = parseListObjectsResponse(xml);
    expect(page.entries).toEqual([]);
    expect(page.prefixes).toEqual([
      "openclaw-backup/2026-01-01T00-00-00Z/",
      "openclaw-backup/safety-2026-01-02T00-00-00Z/",
    ]);
  });

  it("parses common prefixes whose text spans newlines", () => {
    const xml = `<ListBucketResult>
      <IsTruncated>false</IsTruncated>
      <CommonPrefixes>
        <Prefix>openclaw-backup/safety-2026-01-02T00-
00-00Z/</Prefix>
      </CommonPrefixes>
    </ListBucketResult>`;
    const page = parseListObjectsResponse(xml);
    expect(page.prefixes).toEqual(["openclaw-backup/safety-2026-01-02T00-00-00Z/"]);
  });
});

describe("createB2Client", () => {
  it("rejects missing region before network requests", async () => {
    await expect(createB2Client("004test", "K004secret")).rejects.toThrow(B2ConfigError);
    await expect(createB2Client("004test", "K004secret")).rejects.toThrow(
      "region is required",
    );
  });

  it.each([
    ["requestTimeoutMs", { requestTimeoutMs: 0 }],
    ["maxRetries", { maxRetries: -1 }],
    ["maxRetries", { maxRetries: Number.NaN }],
    ["retryMaxDelayMs", { retryMaxDelayMs: -1 }],
    ["retryJitterMs", { retryJitterMs: -1 }],
    ["retryJitterRatio", { retryJitterRatio: 1.1 }],
  ])("rejects invalid %s option", async (name, options) => {
    await expect(createB2Client("004test", "K004secret", "test-region", options)).rejects.toThrow(
      B2ConfigError,
    );
    await expect(createB2Client("004test", "K004secret", "test-region", options)).rejects.toThrow(
      `b2: ${name}`,
    );
  });

  it("rejects ambiguous retry jitter options", async () => {
    await expect(
      createB2Client("004test", "K004secret", "test-region", {
        retryJitterMs: 10,
        retryJitterRatio: 0.1,
      }),
    ).rejects.toThrow("retryJitterMs and retryJitterRatio are mutually exclusive");
  });

  it("rejects invalid endpoint options with a typed config error", async () => {
    await expect(
      createB2Client("004test", "K004secret", "test-region", {
        endpoint: "https://example.com",
      }),
    ).rejects.toThrow(B2ConfigError);
  });

  it("adds the B2 samples user-agent to S3 requests", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const b2 = await createB2Client(
      "004test",
      "K004secret",
      "test-region",
      "https://s3.test-region.backblazeb2.com/",
    );

    await b2.headBucket("bucket");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://s3.test-region.backblazeb2.com/bucket",
      expect.objectContaining({
        method: "HEAD",
        headers: expect.objectContaining({
          "user-agent": USER_AGENT,
        }),
      }),
    );
  });

  it("throws structured request errors with S3 error codes", async () => {
    const body = "<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 404 })));
    const b2 = await createB2Client(
      "004test",
      "K004secret",
      "test-region",
      "https://s3.test-region.backblazeb2.com/",
    );

    await expect(b2.deleteObject("bucket", "missing.txt")).rejects.toMatchObject({
      name: "B2RequestError",
      operation: "deleteObject",
      status: 404,
      body,
      code: "NoSuchKey",
    });
    await expect(b2.deleteObject("bucket", "missing.txt")).rejects.toThrow(B2RequestError);
  });

  it("retries transient B2 responses with attempt logging", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("try again", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const sleep = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);
    const b2 = await createB2Client("004test", "K004secret", "test-region", {
      logger,
      maxRetries: 1,
      retryBaseDelayMs: 1,
      retryJitterMs: 0,
      sleep,
    });

    await b2.headBucket("bucket");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining("b2 headBucket: bucket=bucket attempt=1/2 status=503"),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("retrying bucket=bucket attempt=1/2 status=503"),
    );
  });

  it("honors Retry-After before local exponential backoff, jitter, and cap", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("slow down", { status: 429, headers: { "retry-after": "2" } }),
      )
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    const sleep = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);
    const b2 = await createB2Client("004test", "K004secret", "test-region", {
      maxRetries: 1,
      retryBaseDelayMs: 1,
      retryJitterRatio: 0.25,
      retryMaxDelayMs: 2_400,
      random: () => 1,
      sleep,
    });

    await b2.headBucket("bucket");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_400);
  });

  it("does not jitter Retry-After below the server delay", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("slow down", { status: 503, headers: { "retry-after": "2" } }),
      )
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    const sleep = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);
    const b2 = await createB2Client("004test", "K004secret", "test-region", {
      maxRetries: 1,
      retryBaseDelayMs: 1,
      retryJitterRatio: 0.25,
      random: () => 0,
      sleep,
    });

    await b2.headBucket("bucket");

    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("retries putObject transient failures with the default six attempts", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("try again", { status: 500 }))
      .mockResolvedValueOnce(new Response("try again", { status: 500 }))
      .mockResolvedValueOnce(new Response("try again", { status: 500 }))
      .mockResolvedValueOnce(new Response("try again", { status: 500 }))
      .mockResolvedValueOnce(new Response("try again", { status: 500 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    const sleep = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);
    const b2 = await createB2Client("004test", "K004secret", "test-region", {
      random: () => 0.5,
      sleep,
    });

    await b2.putObject(
      "bucket",
      "backup/file.bin",
      Buffer.from("body"),
      "application/octet-stream",
    );

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(sleep).toHaveBeenNthCalledWith(1, 500);
    expect(sleep).toHaveBeenNthCalledWith(2, 1000);
    expect(sleep).toHaveBeenNthCalledWith(3, 2000);
    expect(sleep).toHaveBeenNthCalledWith(4, 4000);
    expect(sleep).toHaveBeenNthCalledWith(5, 8000);
  });

  it("retries putObject 400 IncompleteBody responses", async () => {
    const body = "<Error><Code>IncompleteBody</Code><Message>short body</Message></Error>";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(body, { status: 400 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    const sleep = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);
    const b2 = await createB2Client("004test", "K004secret", "test-region", {
      maxRetries: 1,
      retryBaseDelayMs: 1,
      retryJitterRatio: 0,
      sleep,
    });

    await b2.putObject(
      "bucket",
      "backup/file.bin",
      Buffer.from("body"),
      "application/octet-stream",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1);
  });

  it("treats an already-committed conditional putObject retry as success", async () => {
    const storedVersions: Array<{ key: string; size: number; sha256: string }> = [];
    const fetchMock = vi.fn(async (url, init) => {
      const requestUrl = new URL(String(url));
      const headers = new Headers(init?.headers);
      if (init?.method === "PUT") {
        expect(headers.get("if-none-match")).toBe("*");
        const existing = storedVersions.find((version) => version.key === requestUrl.pathname);
        if (!existing) {
          storedVersions.push({
            key: requestUrl.pathname,
            size: (init.body as Uint8Array).byteLength,
            sha256: headers.get("x-amz-meta-sha256") ?? "",
          });
          throw new TypeError("fetch failed");
        }
        return new Response("<Error><Code>PreconditionFailed</Code></Error>", { status: 412 });
      }
      if (init?.method === "HEAD") {
        const existing = storedVersions.find((version) => version.key === requestUrl.pathname);
        return new Response("", {
          status: existing ? 200 : 404,
          headers: existing
            ? {
                "content-length": String(existing.size),
                "x-amz-meta-sha256": existing.sha256,
              }
            : undefined,
        });
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} request`);
    });
    const sleep = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);
    const b2 = await createB2Client("004test", "K004secret", "test-region", {
      maxRetries: 1,
      retryBaseDelayMs: 1,
      retryJitterRatio: 0,
      sleep,
    });

    await b2.putObject(
      "bucket",
      "backup/file.bin",
      Buffer.from("body"),
      "application/octet-stream",
    );

    expect(storedVersions).toHaveLength(1);
    expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(["PUT", "PUT", "HEAD"]);
  });

  it("does not accept committed putObject verification without content-length", async () => {
    let storedSha256 = "";
    const fetchMock = vi.fn(async (url, init) => {
      const requestUrl = new URL(String(url));
      const headers = new Headers(init?.headers);
      if (init?.method === "PUT" && !storedSha256) {
        storedSha256 = headers.get("x-amz-meta-sha256") ?? "";
        throw new TypeError("fetch failed");
      }
      if (init?.method === "PUT") {
        return new Response("<Error><Code>PreconditionFailed</Code></Error>", { status: 412 });
      }
      if (init?.method === "HEAD") {
        expect(requestUrl.pathname).toBe("/bucket/backup/empty.bin");
        return new Response("", {
          status: 200,
          headers: {
            "x-amz-meta-sha256": storedSha256,
          },
        });
      }
      throw new Error(`unexpected ${init?.method ?? "GET"} request`);
    });
    const sleep = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);
    const b2 = await createB2Client("004test", "K004secret", "test-region", {
      maxRetries: 1,
      retryBaseDelayMs: 1,
      retryJitterRatio: 0,
      sleep,
    });

    await expect(
      b2.putObject("bucket", "backup/empty.bin", Buffer.alloc(0), "application/octet-stream"),
    ).rejects.toMatchObject({
      name: "B2RequestError",
      operation: "putObject",
      status: 412,
      code: "PreconditionFailed",
    });
    expect(fetchMock.mock.calls.map((call) => call[1]?.method)).toEqual(["PUT", "PUT", "HEAD"]);
  });

  it("bounds 400 IncompleteBody classification for oversized bodies", async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    const cancel = vi.fn();
    const oversizedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(
            encoder.encode("<Error><Code>IncompleteBody</Code><Message>short</Message></Error>"),
          );
          return;
        }
        if (pulls <= 128) {
          controller.enqueue(encoder.encode("x".repeat(1024)));
          return;
        }
        controller.close();
      },
      cancel,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(oversizedBody, { status: 400 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    const sleep = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);
    const b2 = await createB2Client("004test", "K004secret", "test-region", {
      maxRetries: 1,
      retryBaseDelayMs: 1,
      retryJitterRatio: 0,
      sleep,
    });

    await b2.putObject(
      "bucket",
      "backup/file.bin",
      Buffer.from("body"),
      "application/octet-stream",
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pulls).toBeLessThan(8);
    expect(cancel).toHaveBeenCalled();
  });

  it("does not retry oversized 400 bodies with IncompleteBody outside the bounded prefix", async () => {
    const encoder = new TextEncoder();
    let pulls = 0;
    const cancel = vi.fn();
    const oversizedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 10) {
          controller.enqueue(
            encoder.encode("<Error><Code>IncompleteBody</Code><Message>late</Message></Error>"),
          );
          return;
        }
        if (pulls <= 256) {
          controller.enqueue(encoder.encode("x".repeat(1024)));
          return;
        }
        controller.close();
      },
      cancel,
    });
    const fetchMock = vi.fn(async () => new Response(oversizedBody, { status: 400 }));
    const sleep = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);
    const b2 = await createB2Client("004test", "K004secret", "test-region", {
      maxRetries: 1,
      retryBaseDelayMs: 1,
      retryJitterRatio: 0,
      sleep,
    });

    await expect(
      b2.putObject("bucket", "backup/file.bin", Buffer.from("body"), "application/octet-stream"),
    ).rejects.toThrow(B2RequestError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(pulls).toBeLessThan(128);
    expect(cancel).toHaveBeenCalled();
  });

  it("does not retry 400 IncompleteBody responses for non-upload operations", async () => {
    const body = "<Error><Code>IncompleteBody</Code><Message>short body</Message></Error>";
    const fetchMock = vi.fn(async () => new Response(body, { status: 400 }));
    const sleep = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);
    const b2 = await createB2Client("004test", "K004secret", "test-region", {
      maxRetries: 1,
      retryBaseDelayMs: 1,
      retryJitterRatio: 0,
      sleep,
    });

    await expect(b2.getObject("bucket", "backup/file.bin")).rejects.toMatchObject({
      name: "B2RequestError",
      operation: "getObject",
      status: 400,
      code: "IncompleteBody",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry putObject logical 400 errors", async () => {
    const body = "<Error><Code>InvalidRequest</Code><Message>bad request</Message></Error>";
    const fetchMock = vi.fn(async () => new Response(body, { status: 400 }));
    const sleep = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);
    const b2 = await createB2Client("004test", "K004secret", "test-region", {
      maxRetries: 1,
      retryBaseDelayMs: 1,
      retryJitterRatio: 0,
      sleep,
    });

    await expect(
      b2.putObject("bucket", "backup/file.bin", Buffer.from("body"), "application/octet-stream"),
    ).rejects.toMatchObject({
      name: "B2RequestError",
      operation: "putObject",
      status: 400,
      body,
      code: "InvalidRequest",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("caps retry backoff after jitter", async () => {
    const fetchMock = vi.fn(async () => new Response("try again", { status: 503 }));
    const sleep = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);
    const b2 = await createB2Client("004test", "K004secret", "test-region", {
      maxRetries: 6,
      retryBaseDelayMs: 500,
      retryJitterRatio: 0,
      sleep,
    });

    await expect(b2.headBucket("bucket")).rejects.toThrow(B2RequestError);

    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(sleep).toHaveBeenLastCalledWith(15_000);
  });

  it("does not sleep before retry when parent signal is aborted", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort(new Error("deadline"));
      return new Response("try again", { status: 503 });
    });
    const sleep = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);
    const b2 = await createB2Client("004test", "K004secret", "test-region", {
      signal: controller.signal,
      maxRetries: 1,
      retryBaseDelayMs: 1,
      retryJitterMs: 0,
      sleep,
    });

    await expect(b2.headBucket("bucket")).rejects.toThrow("deadline");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("aborts retry backoff when parent signal aborts during sleep", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => new Response("try again", { status: 503 }));
    const sleep = vi.fn(async () => {
      controller.abort(new Error("deadline"));
      return new Promise<void>(() => undefined);
    });
    vi.stubGlobal("fetch", fetchMock);
    const b2 = await createB2Client("004test", "K004secret", "test-region", {
      signal: controller.signal,
      maxRetries: 1,
      retryBaseDelayMs: 1,
      retryJitterMs: 0,
      sleep,
    });

    await expect(b2.headBucket("bucket")).rejects.toThrow("deadline");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("resolveEndpoint", () => {
  it("allows only the HTTPS Backblaze B2 S3 endpoint for the configured region", () => {
    expect(resolveEndpoint("test-region")).toBe("https://s3.test-region.backblazeb2.com");
    expect(resolveEndpoint("test-region", "https://s3.test-region.backblazeb2.com/")).toBe(
      "https://s3.test-region.backblazeb2.com",
    );
  });

  it("rejects invalid endpoint URLs with a clear config error", () => {
    expect(() => resolveEndpoint("test-region", "s3.test-region.backblazeb2.com")).toThrow(
      B2ConfigError,
    );
    expect(() => resolveEndpoint("test-region", "s3.test-region.backblazeb2.com")).toThrow(
      "b2: endpoint must be a valid URL",
    );
  });

  it.each([
    ["http endpoint", "http://s3.test-region.backblazeb2.com"],
    ["localhost endpoint", "https://localhost"],
    ["link-local endpoint", "https://169.254.169.254"],
    ["private-network endpoint", "https://10.0.0.1"],
    ["credentialed endpoint", "https://user:pass@s3.test-region.backblazeb2.com"],
    ["non-B2 endpoint", "https://example.com"],
    ["wrong-region endpoint", "https://s3.other-region.backblazeb2.com"],
  ])("rejects %s", (_label, endpoint) => {
    expect(() => resolveEndpoint("test-region", endpoint)).toThrow(B2ConfigError);
  });
});
