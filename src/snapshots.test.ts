import { describe, expect, it, vi } from "vitest";
import type { B2Client, B2ObjectEntry } from "./b2-client.js";
import { getLatestSnapshot, listSnapshots, pruneSnapshots } from "./snapshots.js";

function createMockB2(objects: B2ObjectEntry[]): B2Client {
  const deleted: string[] = [];
  return {
    putObject: vi.fn(),
    getObject: vi.fn(),
    listObjects: vi.fn(async (_bucket: string, prefix: string) =>
      objects.filter((o) => o.key.startsWith(prefix)),
    ),
    deleteObject: vi.fn(async (_bucket: string, key: string) => {
      deleted.push(key);
    }),
    headBucket: vi.fn(),
    _deleted: deleted,
  } as unknown as B2Client & { _deleted: string[] };
}

describe("snapshots", () => {
  const prefix = "openclaw-backup";
  const bucket = "test-bucket";

  describe("listSnapshots", () => {
    it("extracts unique timestamps from object keys", async () => {
      const b2 = createMockB2([
        { key: `${prefix}/2026-01-01T00-00-00Z/openclaw.json`, size: 10, lastModified: "" },
        { key: `${prefix}/2026-01-01T00-00-00Z/manifest.json`, size: 20, lastModified: "" },
        { key: `${prefix}/2026-01-02T00-00-00Z/openclaw.json`, size: 10, lastModified: "" },
        { key: `${prefix}/2026-01-03T00-00-00Z/openclaw.json`, size: 10, lastModified: "" },
      ]);

      const snapshots = await listSnapshots(b2, bucket, prefix);
      expect(snapshots).toEqual([
        "2026-01-01T00-00-00Z",
        "2026-01-02T00-00-00Z",
        "2026-01-03T00-00-00Z",
      ]);
    });

    it("returns empty array when no objects", async () => {
      const b2 = createMockB2([]);
      const snapshots = await listSnapshots(b2, bucket, prefix);
      expect(snapshots).toEqual([]);
    });

    it("returns sorted timestamps", async () => {
      const b2 = createMockB2([
        { key: `${prefix}/2026-01-03T00-00-00Z/file.txt`, size: 10, lastModified: "" },
        { key: `${prefix}/2026-01-01T00-00-00Z/file.txt`, size: 10, lastModified: "" },
        { key: `${prefix}/2026-01-02T00-00-00Z/file.txt`, size: 10, lastModified: "" },
      ]);

      const snapshots = await listSnapshots(b2, bucket, prefix);
      expect(snapshots[0]).toBe("2026-01-01T00-00-00Z");
      expect(snapshots[2]).toBe("2026-01-03T00-00-00Z");
    });
  });

  describe("getLatestSnapshot", () => {
    it("returns the latest timestamp", async () => {
      const b2 = createMockB2([
        { key: `${prefix}/2026-01-01T00-00-00Z/file.txt`, size: 10, lastModified: "" },
        { key: `${prefix}/2026-01-03T00-00-00Z/file.txt`, size: 10, lastModified: "" },
      ]);

      const latest = await getLatestSnapshot(b2, bucket, prefix);
      expect(latest).toBe("2026-01-03T00-00-00Z");
    });

    it("returns null when no snapshots", async () => {
      const b2 = createMockB2([]);
      const latest = await getLatestSnapshot(b2, bucket, prefix);
      expect(latest).toBeNull();
    });
  });

  describe("pruneSnapshots", () => {
    it("deletes oldest snapshots beyond keep count", async () => {
      const objects = [
        { key: `${prefix}/2026-01-01T00-00-00Z/file.txt`, size: 10, lastModified: "" },
        { key: `${prefix}/2026-01-02T00-00-00Z/file.txt`, size: 10, lastModified: "" },
        { key: `${prefix}/2026-01-03T00-00-00Z/file.txt`, size: 10, lastModified: "" },
      ];
      const b2 = createMockB2(objects);

      const pruned = await pruneSnapshots(b2, bucket, prefix, 2);
      expect(pruned).toEqual(["2026-01-01T00-00-00Z"]);
      expect(b2.deleteObject).toHaveBeenCalled();
    });

    it("does nothing when within keep count", async () => {
      const objects = [
        { key: `${prefix}/2026-01-01T00-00-00Z/file.txt`, size: 10, lastModified: "" },
        { key: `${prefix}/2026-01-02T00-00-00Z/file.txt`, size: 10, lastModified: "" },
      ];
      const b2 = createMockB2(objects);

      const pruned = await pruneSnapshots(b2, bucket, prefix, 5);
      expect(pruned).toEqual([]);
      expect(b2.deleteObject).not.toHaveBeenCalled();
    });
  });
});
