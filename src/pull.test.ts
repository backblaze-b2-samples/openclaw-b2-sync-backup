import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { B2Client } from "./b2-client.js";
import { pullSnapshot } from "./pull.js";
import type { BackupManifest, ResolvedB2BackupConfig } from "./types.js";

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

function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

describe("pullSnapshot", () => {
  it("skips manifest paths that would restore outside the state directory", async () => {
    const tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-pull-"));
    const stateDir = path.join(tempRoot, "state");
    const outsidePath = path.join(tempRoot, "outside");
    const absoluteOutsidePath = path.join(tempRoot, "absolute-outside");
    await fs.promises.mkdir(stateDir, { recursive: true });
    await fs.promises.writeFile(outsidePath, "original");
    await fs.promises.writeFile(absoluteOutsidePath, "original");

    const payload = Buffer.from("malicious overwrite");
    const unsafePaths = [
      "../outside",
      "sub/../../outside",
      absoluteOutsidePath,
      "C:\\tmp\\outside",
    ];
    const manifest: BackupManifest = {
      version: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      files: Object.fromEntries(
        unsafePaths.map((unsafePath) => [
          unsafePath,
          { hash: sha256(payload), size: payload.byteLength },
        ]),
      ),
    };
    const getObject = vi.fn(async (_bucket: string, key: string) => {
      if (key === "openclaw-backup/snapshot-1/manifest.json") {
        return Buffer.from(JSON.stringify(manifest), "utf-8");
      }
      throw new Error(`unexpected payload download: ${key}`);
    });
    const config: ResolvedB2BackupConfig = {
      keyId: "test-key",
      applicationKey: "test-secret",
      bucket: "test-bucket",
      region: "test-region",
      encrypt: false,
    };
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

    try {
      await pullSnapshot(config, stateDir, mockB2({ getObject }), logger, "snapshot-1", {
        skipSafety: true,
      });

      expect(getObject).toHaveBeenCalledTimes(1);
      expect(await fs.promises.readFile(outsidePath, "utf-8")).toBe("original");
      expect(await fs.promises.readFile(absoluteOutsidePath, "utf-8")).toBe("original");
      await expect(
        fs.promises.access(path.join(stateDir, "C:\\tmp\\outside")),
      ).rejects.toThrow();
      for (const unsafePath of unsafePaths) {
        expect(logger.warn).toHaveBeenCalledWith(
          `b2-backup: skipped unsafe manifest path: ${JSON.stringify(unsafePath)}`,
        );
      }
    } finally {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });
});
