import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _parseListObjectsResponse as parseListObjectsResponse,
  _resolveEndpoint as resolveEndpoint,
  _signRequest as signRequest,
  createB2Client,
} from "./b2-client.js";

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
          "user-agent": "b2ai-openclaw (backblaze-b2-samples)",
        },
        body: "",
        region: "test-region",
        accessKeyId: "004test",
        secretAccessKey: "K004secret",
      });

      expect(headers["user-agent"]).toBe("b2ai-openclaw (backblaze-b2-samples)");
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
    expect(page.entries[0]).toEqual({ key: "prefix/file1.txt", size: 100, lastModified: "2026-01-01" });
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
    expect(page.nextToken).toBeUndefined();
  });
});

describe("createB2Client", () => {
  it("rejects missing region before network requests", async () => {
    await expect(createB2Client("004test", "K004secret")).rejects.toThrow(
      "region is required",
    );
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
          "user-agent": "b2ai-openclaw (backblaze-b2-samples)",
        }),
      }),
    );
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
    expect(() => resolveEndpoint("test-region", endpoint)).toThrow();
  });
});
