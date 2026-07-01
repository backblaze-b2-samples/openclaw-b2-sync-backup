import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { B2Client } from "./b2-client.js";
import { _createSnapshotId as createSnapshotId, PushLockError, push } from "./push.js";
import type { ResolvedB2BackupConfig } from "./types.js";

function mockB2(overrides: Partial<B2Client> = {}): B2Client {
  return {
    putObject: vi.fn(async () => undefined),
    getObject: vi.fn(async () => Buffer.alloc(0)),
    listObjects: vi.fn(async () => []),
    deleteObject: vi.fn(async () => undefined),
    headBucket: vi.fn(async () => undefined),
    ...overrides,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void } {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("push", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("cleans temporary SQLite snapshot directories when upload fails", async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-state-"));
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-temp-root-"));
    vi.spyOn(os, "tmpdir").mockReturnValue(tempRoot);
    await fs.promises.mkdir(path.join(stateDir, "agents", "agent-a", "memory"), {
      recursive: true,
    });
    await fs.promises.writeFile(
      path.join(stateDir, "agents", "agent-a", "memory", "memory.sqlite"),
      "not a real sqlite database",
    );
    const config: ResolvedB2BackupConfig = {
      keyId: "test-key",
      applicationKey: "test-secret",
      bucket: "test-bucket",
      region: "test-region",
      encrypt: false,
    };
    const b2 = mockB2({
      putObject: vi.fn(async () => {
        throw new Error("upload failed");
      }),
    });
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

    await expect(push(config, stateDir, b2, logger)).rejects.toThrow("upload failed");

    expect(await fs.promises.readdir(tempRoot)).toEqual([]);
    await expect(
      fs.promises.access(path.join(stateDir, ".b2-backup-push.lock")),
    ).rejects.toThrow();
    await fs.promises.rm(stateDir, { recursive: true, force: true });
    await fs.promises.rm(tempRoot, { recursive: true, force: true });
  });

  it("rejects overlapping pushes with a lock diagnostic", async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-state-"));
    await fs.promises.writeFile(path.join(stateDir, "openclaw.json"), "{}");
    const config: ResolvedB2BackupConfig = {
      keyId: "test-key",
      applicationKey: "test-secret",
      bucket: "test-bucket",
      region: "test-region",
      encrypt: false,
    };
    const uploadStarted = deferred();
    const releaseUpload = deferred();
    const putObject = vi.fn(async () => {
      uploadStarted.resolve();
      await releaseUpload.promise;
    });
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

    const firstPush = push(config, stateDir, mockB2({ putObject }), logger);
    await uploadStarted.promise;

    await expect(push(config, stateDir, mockB2(), logger)).rejects.toThrow(PushLockError);
    await expect(push(config, stateDir, mockB2(), logger)).rejects.toThrow(
      "another push is already running",
    );

    releaseUpload.resolve();
    await firstPush;
    await fs.promises.rm(stateDir, { recursive: true, force: true });
  });

  it("adds a random suffix to snapshot IDs", () => {
    const snapshotId = createSnapshotId("2026-02-19T12:00:00.000Z");

    expect(snapshotId).toMatch(/^2026-02-19T12-00-00-000Z-[a-f0-9-]{8}$/);
  });

  it("uses prefixOverride as the complete snapshot root", async () => {
    const stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-state-"));
    await fs.promises.writeFile(path.join(stateDir, "openclaw.json"), "{}");
    const putObject = vi.fn(async () => undefined);
    const config: ResolvedB2BackupConfig = {
      keyId: "test-key",
      applicationKey: "test-secret",
      bucket: "test-bucket",
      region: "test-region",
      encrypt: false,
    };
    const b2 = mockB2({ putObject });
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const safetyRoot = "openclaw-backup/safety-2026-06-26T01-42-00Z";

    await push(config, stateDir, b2, logger, {
      prefixOverride: safetyRoot,
      skipPrune: true,
    });

    const uploadedKeys = putObject.mock.calls.map((call) => call[1]);
    const nestedUnderSafetyRoot = uploadedKeys.filter(
      (key) => key.startsWith(`${safetyRoot}/`) && key.slice(safetyRoot.length + 1).includes("/"),
    );
    expect(uploadedKeys).toContain(`${safetyRoot}/openclaw.json`);
    expect(uploadedKeys).toContain(`${safetyRoot}/manifest.json`);
    expect(nestedUnderSafetyRoot).toEqual([]);
    await fs.promises.rm(stateDir, { recursive: true, force: true });
  });
});
