import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeManifest,
  deserializeManifest,
  diffManifests,
  serializeManifest,
} from "./manifest.js";
import type { BackupManifest, GatheredFile } from "./types.js";

describe("manifest", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-manifest-test-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  describe("computeManifest", () => {
    it("computes SHA-256 hashes for files", async () => {
      const filePath = path.join(tmpDir, "test.txt");
      await fs.promises.writeFile(filePath, "hello world");
      const expectedHash = crypto.createHash("sha256").update("hello world").digest("hex");

      const files: GatheredFile[] = [
        { relativePath: "test.txt", absolutePath: filePath, size: 11 },
      ];
      const manifest = await computeManifest(files);

      expect(manifest.version).toBe(1);
      expect(manifest.timestamp).toBeTruthy();
      expect(manifest.files["test.txt"]).toEqual({
        hash: expectedHash,
        size: 11,
      });
    });

    it("handles multiple files", async () => {
      const file1 = path.join(tmpDir, "a.txt");
      const file2 = path.join(tmpDir, "b.txt");
      await fs.promises.writeFile(file1, "aaa");
      await fs.promises.writeFile(file2, "bbb");

      const files: GatheredFile[] = [
        { relativePath: "a.txt", absolutePath: file1, size: 3 },
        { relativePath: "b.txt", absolutePath: file2, size: 3 },
      ];
      const manifest = await computeManifest(files);

      expect(Object.keys(manifest.files)).toHaveLength(2);
      expect(manifest.files["a.txt"]!.hash).not.toBe(manifest.files["b.txt"]!.hash);
    });
  });

  describe("diffManifests", () => {
    const base: BackupManifest = {
      version: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      files: {
        "a.txt": { hash: "aaa", size: 3 },
        "b.txt": { hash: "bbb", size: 3 },
        "c.txt": { hash: "ccc", size: 3 },
      },
    };

    it("detects added files", () => {
      const current: BackupManifest = {
        ...base,
        files: {
          ...base.files,
          "d.txt": { hash: "ddd", size: 3 },
        },
      };
      const diff = diffManifests(base, current);
      expect(diff.added).toEqual(["d.txt"]);
      expect(diff.changed).toEqual([]);
      expect(diff.deleted).toEqual([]);
    });

    it("detects changed files", () => {
      const current: BackupManifest = {
        ...base,
        files: {
          ...base.files,
          "b.txt": { hash: "bbb-changed", size: 5 },
        },
      };
      const diff = diffManifests(base, current);
      expect(diff.added).toEqual([]);
      expect(diff.changed).toEqual(["b.txt"]);
      expect(diff.deleted).toEqual([]);
    });

    it("detects deleted files", () => {
      const { "c.txt": _, ...remaining } = base.files;
      const current: BackupManifest = {
        ...base,
        files: remaining,
      };
      const diff = diffManifests(base, current);
      expect(diff.added).toEqual([]);
      expect(diff.changed).toEqual([]);
      expect(diff.deleted).toEqual(["c.txt"]);
    });

    it("handles null previous manifest (first push)", () => {
      const diff = diffManifests(null, base);
      expect(diff.added).toEqual(["a.txt", "b.txt", "c.txt"]);
      expect(diff.changed).toEqual([]);
      expect(diff.deleted).toEqual([]);
    });
  });

  describe("serialize/deserialize", () => {
    it("round-trips a manifest", () => {
      const manifest: BackupManifest = {
        version: 1,
        timestamp: "2026-02-09T00:00:00.000Z",
        files: {
          "test.txt": { hash: "abc123", size: 42 },
        },
      };
      const serialized = serializeManifest(manifest);
      const deserialized = deserializeManifest(serialized);
      expect(deserialized).toEqual(manifest);
    });
  });
});
