import { describe, expect, it } from "vitest";
import {
  _parseListObjectsResponse as parseListObjectsResponse,
  _signRequest as signRequest,
  s3EncodePath,
} from "./b2-client.js";

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
        headers: { host: "s3.us-west-004.backblazeb2.com" },
        body: "",
        region: "us-west-004",
        accessKeyId: "004test",
        secretAccessKey: "K004secret",
      });

      expect(headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
      expect(headers.authorization).toContain("004test");
      expect(headers.authorization).toContain("20260219/us-west-004/s3/aws4_request");
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
          host: "s3.us-west-004.backblazeb2.com",
          "content-type": "application/octet-stream",
        },
        body,
        region: "us-west-004",
        accessKeyId: "004test",
        secretAccessKey: "K004secret",
      });

      expect(headers["x-amz-content-sha256"]).toBeTruthy();
      // Non-empty body should produce different hash than empty
      const emptyHeaders = signRequest({
        method: "PUT",
        path: "/my-bucket/upload",
        headers: {
          host: "s3.us-west-004.backblazeb2.com",
          "content-type": "application/octet-stream",
        },
        body: "",
        region: "us-west-004",
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
          host: "s3.us-west-004.backblazeb2.com",
          "content-type": "text/plain",
        },
        body: "",
        region: "us-west-004",
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
          host: "s3.us-west-004.backblazeb2.com",
          "user-agent": "b2ai-openclaw",
        },
        body: "",
        region: "us-west-004",
        accessKeyId: "004test",
        secretAccessKey: "K004secret",
      });

      expect(headers["user-agent"]).toBe("b2ai-openclaw");
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
        headers: { host: "s3.us-west-004.backblazeb2.com" },
        body: "",
        region: "us-west-004",
        accessKeyId: "004test",
        secretAccessKey: "K004secret",
      });

      expect(headers.authorization).toBeTruthy();
    } finally {
      globalThis.Date = originalDate;
    }
  });
});

describe("s3EncodePath", () => {
  it("encodes spaces as %20", () => {
    expect(s3EncodePath("my file.png")).toBe("my%20file.png");
  });

  it("preserves slashes between path segments", () => {
    expect(s3EncodePath("workspace/foo/bar.txt")).toBe("workspace/foo/bar.txt");
  });

  it("encodes spaces but keeps slashes in mixed paths", () => {
    expect(s3EncodePath("workspace/Marketing Image 1.png")).toBe(
      "workspace/Marketing%20Image%201.png",
    );
  });

  it("encodes plus signs", () => {
    expect(s3EncodePath("a+b.txt")).toBe("a%2Bb.txt");
  });

  it("encodes the AWS-extended set: ' ( ) * !", () => {
    expect(s3EncodePath("a'b.txt")).toBe("a%27b.txt");
    expect(s3EncodePath("a(b).txt")).toBe("a%28b%29.txt");
    expect(s3EncodePath("a*b.txt")).toBe("a%2Ab.txt");
    expect(s3EncodePath("a!b.txt")).toBe("a%21b.txt");
  });

  it("preserves unreserved characters", () => {
    expect(s3EncodePath("a-b_c.d~e/f.png")).toBe("a-b_c.d~e/f.png");
  });

  it("encodes unicode characters", () => {
    expect(s3EncodePath("café.txt")).toBe("caf%C3%A9.txt");
  });

  it("handles empty path", () => {
    expect(s3EncodePath("")).toBe("");
  });

  it("handles single segment", () => {
    expect(s3EncodePath("file.txt")).toBe("file.txt");
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
