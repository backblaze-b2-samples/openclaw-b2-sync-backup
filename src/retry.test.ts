import { describe, expect, it, vi } from "vitest";
import type { B2Client } from "./b2-client.js";
import { isRetryablePutError, putObjectWithRetry } from "./retry.js";

const silentLogger = {
  info: () => {},
  warn: () => {},
};

function makeB2(stub: Partial<B2Client>): B2Client {
  return {
    putObject: vi.fn(),
    getObject: vi.fn(),
    listObjects: vi.fn(),
    deleteObject: vi.fn(),
    headBucket: vi.fn(),
    ...stub,
  } as B2Client;
}

describe("isRetryablePutError", () => {
  it("retries on Node fetch failure", () => {
    expect(isRetryablePutError(new TypeError("fetch failed"))).toBe(true);
  });

  it("retries on B2 5xx", () => {
    expect(isRetryablePutError(new Error("b2 putObject failed (500): server"))).toBe(true);
    expect(isRetryablePutError(new Error("b2 putObject failed (503): server"))).toBe(true);
  });

  it("retries on rate limit / timeout", () => {
    expect(isRetryablePutError(new Error("b2 putObject failed (408): timeout"))).toBe(true);
    expect(isRetryablePutError(new Error("b2 putObject failed (429): slow down"))).toBe(true);
  });

  it("retries on 400 IncompleteBody (truncated upload)", () => {
    const err = new Error(
      "b2 putObject failed (400): <Error><Code>IncompleteBody</Code></Error>",
    );
    expect(isRetryablePutError(err)).toBe(true);
  });

  it("does not retry on 400 InvalidRequest (bad filename, etc.)", () => {
    const err = new Error(
      "b2 putObject failed (400): <Error><Code>InvalidRequest</Code></Error>",
    );
    expect(isRetryablePutError(err)).toBe(false);
  });

  it("does not retry on 401 / 403 / 404", () => {
    expect(isRetryablePutError(new Error("b2 putObject failed (401): bad key"))).toBe(false);
    expect(isRetryablePutError(new Error("b2 putObject failed (403): denied"))).toBe(false);
    expect(isRetryablePutError(new Error("b2 putObject failed (404): missing"))).toBe(false);
  });

  it("does not retry on errors that are not from b2 putObject", () => {
    expect(isRetryablePutError(new Error("ENOENT: no such file"))).toBe(false);
    expect(isRetryablePutError("plain string error")).toBe(false);
  });
});

describe("putObjectWithRetry", () => {
  const noSleep = () => Promise.resolve();
  const body = new Uint8Array([1, 2, 3]);

  it("succeeds without retry when underlying call works", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const b2 = makeB2({ putObject: put });
    await putObjectWithRetry(b2, "bucket", "key", body, "ct", silentLogger, "label", {
      sleep: noSleep,
    });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable error then succeeds", async () => {
    const put = vi
      .fn()
      .mockRejectedValueOnce(new Error("b2 putObject failed (500): blip"))
      .mockResolvedValueOnce(undefined);
    const b2 = makeB2({ putObject: put });
    await putObjectWithRetry(b2, "bucket", "key", body, "ct", silentLogger, "label", {
      sleep: noSleep,
    });
    expect(put).toHaveBeenCalledTimes(2);
  });

  it("propagates non-retryable error immediately", async () => {
    const err = new Error("b2 putObject failed (403): denied");
    const put = vi.fn().mockRejectedValue(err);
    const b2 = makeB2({ putObject: put });
    await expect(
      putObjectWithRetry(b2, "bucket", "key", body, "ct", silentLogger, "label", {
        sleep: noSleep,
      }),
    ).rejects.toThrow("403");
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts retryable failures", async () => {
    const put = vi.fn().mockRejectedValue(new Error("b2 putObject failed (500): perma"));
    const b2 = makeB2({ putObject: put });
    await expect(
      putObjectWithRetry(b2, "bucket", "key", body, "ct", silentLogger, "label", {
        maxAttempts: 3,
        sleep: noSleep,
      }),
    ).rejects.toThrow("500");
    expect(put).toHaveBeenCalledTimes(3);
  });

  it("retries on fetch failed (network drop)", async () => {
    const put = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(undefined);
    const b2 = makeB2({ putObject: put });
    await putObjectWithRetry(b2, "bucket", "key", body, "ct", silentLogger, "label", {
      sleep: noSleep,
    });
    expect(put).toHaveBeenCalledTimes(3);
  });

  it("retries on 400 IncompleteBody but not on 400 InvalidRequest", async () => {
    const incomplete = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("b2 putObject failed (400): <Code>IncompleteBody</Code>"),
      )
      .mockResolvedValueOnce(undefined);
    await putObjectWithRetry(makeB2({ putObject: incomplete }), "b", "k", body, "ct", silentLogger, "l", {
      sleep: noSleep,
    });
    expect(incomplete).toHaveBeenCalledTimes(2);

    const invalid = vi
      .fn()
      .mockRejectedValue(new Error("b2 putObject failed (400): <Code>InvalidRequest</Code>"));
    await expect(
      putObjectWithRetry(makeB2({ putObject: invalid }), "b", "k", body, "ct", silentLogger, "l", {
        sleep: noSleep,
      }),
    ).rejects.toThrow("400");
    expect(invalid).toHaveBeenCalledTimes(1);
  });
});
