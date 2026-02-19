import { describe, expect, it } from "vitest";
import { _signRequest as signRequest } from "./b2-client.js";

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
