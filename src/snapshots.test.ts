import { describe, expect, it, vi } from "vitest";
import { B2RequestError, type B2Client, type B2ObjectEntry } from "./b2-client.js";
import {
  getLatestSnapshot,
  listRegularSnapshots,
  listSafetySnapshots,
  listSnapshots,
  pruneSafetySnapshots,
  pruneSnapshots,
} from "./snapshots.js";

type MockB2Client = B2Client & {
  listPrefixes: ReturnType<typeof vi.fn>;
  _deleted: string[];
};

function createLegacyMockB2(objects: B2ObjectEntry[]): B2Client {
  return {
    putObject: vi.fn(),
    getObject: vi.fn(),
    listObjects: vi.fn(async (_bucket: string, prefix: string) =>
      objects.filter((o) => o.key.startsWith(prefix)),
    ),
    deleteObject: vi.fn(),
    headBucket: vi.fn(),
  };
}

function createMockB2(objects: B2ObjectEntry[]): MockB2Client {
  const deleted: string[] = [];
  return {
    putObject: vi.fn(),
    getObject: vi.fn(),
    listObjects: vi.fn(async (_bucket: string, prefix: string) =>
      objects.filter((o) => o.key.startsWith(prefix)),
    ),
    listPrefixes: vi.fn(async (_bucket: string, requestedPrefix: string) => {
      const prefixes = new Set<string>();
      for (const object of objects) {
        if (!object.key.startsWith(requestedPrefix)) continue;
        const afterPrefix = object.key.slice(requestedPrefix.length);
        const dir = afterPrefix.split("/")[0];
        if (dir) {
          prefixes.add(`${requestedPrefix}${dir}/`);
        }
      }
      return [...prefixes].sort();
    }),
    deleteObject: vi.fn(async (_bucket: string, key: string) => {
      deleted.push(key);
    }),
    headBucket: vi.fn(),
    _deleted: deleted,
  } as unknown as MockB2Client;
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

    it("excludes safety snapshots from regular snapshot listings", async () => {
      const b2 = createMockB2([
        { key: `${prefix}/2026-01-01T00-00-00Z/file.txt`, size: 10, lastModified: "" },
        {
          key: `${prefix}/safety-2026-01-02T00-00-00Z/2026-01-02T00-00-01Z/file.txt`,
          size: 10,
          lastModified: "",
        },
        { key: `${prefix}/2026-01-03T00-00-00Z/file.txt`, size: 10, lastModified: "" },
      ]);

      const snapshots = await listSnapshots(b2, bucket, prefix);
      expect(snapshots).toEqual(["2026-01-01T00-00-00Z", "2026-01-03T00-00-00Z"]);
    });

    it("is a compatibility alias for regular snapshots", async () => {
      const b2 = createMockB2([
        { key: `${prefix}/2026-01-01T00-00-00Z/file.txt`, size: 10, lastModified: "" },
        {
          key: `${prefix}/safety-2026-01-02T00-00-00Z/2026-01-02T00-00-01Z/file.txt`,
          size: 10,
          lastModified: "",
        },
      ]);

      const legacySnapshots = await listSnapshots(b2, bucket, prefix);
      const regularSnapshots = await listRegularSnapshots(b2, bucket, prefix);
      expect(legacySnapshots).toEqual(regularSnapshots);
    });

    it("supports B2 clients without prefix listing", async () => {
      const b2 = createLegacyMockB2([
        { key: `${prefix}/2026-01-01T00-00-00Z/file.txt`, size: 10, lastModified: "" },
        {
          key: `${prefix}/safety-2026-01-02T00-00-00Z/2026-01-02T00-00-01Z/file.txt`,
          size: 10,
          lastModified: "",
        },
      ]);

      await expect(listRegularSnapshots(b2, bucket, prefix)).resolves.toEqual([
        "2026-01-01T00-00-00Z",
      ]);
      await expect(listSafetySnapshots(b2, bucket, prefix)).resolves.toEqual([
        "safety-2026-01-02T00-00-00Z/2026-01-02T00-00-01Z",
      ]);
    });
  });

  describe("listSafetySnapshots", () => {
    it("returns nested safety snapshot identifiers for recovery", async () => {
      const b2 = createMockB2([
        { key: `${prefix}/2026-01-01T00-00-00Z/file.txt`, size: 10, lastModified: "" },
        {
          key: `${prefix}/safety-2026-01-02T00-00-00Z/2026-01-02T00-00-01Z/file.txt`,
          size: 10,
          lastModified: "",
        },
        {
          key: `${prefix}/safety-2026-01-04T00-00-00Z/2026-01-04T00-00-01Z/file.txt`,
          size: 10,
          lastModified: "",
        },
      ]);

      const snapshots = await listSafetySnapshots(b2, bucket, prefix);
      expect(snapshots).toEqual([
        "safety-2026-01-02T00-00-00Z/2026-01-02T00-00-01Z",
        "safety-2026-01-04T00-00-00Z/2026-01-04T00-00-01Z",
      ]);
      expect(b2.listObjects).not.toHaveBeenCalled();
      expect(b2.listPrefixes).toHaveBeenCalledWith(
        bucket,
        `${prefix}/safety-2026-01-02T00-00-00Z/`,
      );
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

    it("ignores safety snapshots when selecting latest", async () => {
      const b2 = createMockB2([
        { key: `${prefix}/2026-01-03T00-00-00Z/file.txt`, size: 10, lastModified: "" },
        { key: `${prefix}/safety-2026-01-04T00-00-00Z/file.txt`, size: 10, lastModified: "" },
      ]);

      const latest = await getLatestSnapshot(b2, bucket, prefix);
      expect(latest).toBe("2026-01-03T00-00-00Z");
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

    it("does not prune safety snapshots", async () => {
      const objects = [
        { key: `${prefix}/2026-01-01T00-00-00Z/file.txt`, size: 10, lastModified: "" },
        {
          key: `${prefix}/safety-2026-01-02T00-00-00Z/2026-01-02T00-00-01Z/file.txt`,
          size: 10,
          lastModified: "",
        },
        { key: `${prefix}/2026-01-03T00-00-00Z/file.txt`, size: 10, lastModified: "" },
      ];
      const b2 = createMockB2(objects);

      const pruned = await pruneSnapshots(b2, bucket, prefix, 1);
      expect(pruned).toEqual(["2026-01-01T00-00-00Z"]);
      expect(b2.deleteObject).toHaveBeenCalledTimes(1);
      expect(b2.deleteObject).toHaveBeenCalledWith(
        bucket,
        `${prefix}/2026-01-01T00-00-00Z/file.txt`,
      );
    });

    it("does not scan safety snapshot contents during regular pruning", async () => {
      const safetyObjects = Array.from({ length: 1000 }, (_, i) => ({
        key: `${prefix}/safety-2026-01-02T00-00-00Z/2026-01-02T00-00-01Z/file-${i}.txt`,
        size: 10,
        lastModified: "",
      }));
      const b2 = createMockB2([
        { key: `${prefix}/2026-01-01T00-00-00Z/file.txt`, size: 10, lastModified: "" },
        { key: `${prefix}/2026-01-03T00-00-00Z/file.txt`, size: 10, lastModified: "" },
        ...safetyObjects,
      ]);

      const pruned = await pruneSnapshots(b2, bucket, prefix, 1);
      expect(pruned).toEqual(["2026-01-01T00-00-00Z"]);
      expect(b2.listPrefixes).toHaveBeenCalledWith(bucket, `${prefix}/`);
      expect(b2.listObjects).not.toHaveBeenCalledWith(bucket, `${prefix}/`);
      expect(b2.listObjects).not.toHaveBeenCalledWith(
        bucket,
        `${prefix}/safety-2026-01-02T00-00-00Z/`,
      );
      expect(b2.listObjects).toHaveBeenCalledTimes(1);
    });

    it("tolerates objects already removed during pruning", async () => {
      const b2 = createMockB2([
        { key: `${prefix}/2026-01-01T00-00-00Z/file.txt`, size: 10, lastModified: "" },
        { key: `${prefix}/2026-01-02T00-00-00Z/file.txt`, size: 10, lastModified: "" },
      ]);
      b2.deleteObject.mockRejectedValueOnce(
        new B2RequestError(
          "deleteObject",
          404,
          "<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>",
          "NoSuchKey",
        ),
      );

      const pruned = await pruneSnapshots(b2, bucket, prefix, 1);

      expect(pruned).toEqual(["2026-01-01T00-00-00Z"]);
      expect(b2.deleteObject).toHaveBeenCalledTimes(1);
    });

    it("does not suppress generic 404 delete failures", async () => {
      const b2 = createMockB2([
        { key: `${prefix}/2026-01-01T00-00-00Z/file.txt`, size: 10, lastModified: "" },
        { key: `${prefix}/2026-01-02T00-00-00Z/file.txt`, size: 10, lastModified: "" },
      ]);
      b2.deleteObject.mockRejectedValueOnce(
        new B2RequestError(
          "deleteObject",
          404,
          "<Error><Code>NoSuchBucket</Code><Message>missing bucket</Message></Error>",
          "NoSuchBucket",
        ),
      );

      await expect(pruneSnapshots(b2, bucket, prefix, 1)).rejects.toThrow(B2RequestError);
    });
  });

  describe("pruneSafetySnapshots", () => {
    it("deletes oldest safety prefixes beyond keep count", async () => {
      const objects = [
        { key: `${prefix}/2026-01-01T00-00-00Z/file.txt`, size: 10, lastModified: "" },
        {
          key: `${prefix}/safety-2026-01-01T00-00-00Z/2026-01-01T00-00-01Z/file.txt`,
          size: 10,
          lastModified: "",
        },
        {
          key: `${prefix}/safety-2026-01-01T00-00-00Z/2026-01-01T00-00-01Z/partial.bin`,
          size: 10,
          lastModified: "",
        },
        {
          key: `${prefix}/safety-2026-01-02T00-00-00Z/2026-01-02T00-00-01Z/file.txt`,
          size: 10,
          lastModified: "",
        },
        {
          key: `${prefix}/safety-2026-01-03T00-00-00Z/2026-01-03T00-00-01Z/file.txt`,
          size: 10,
          lastModified: "",
        },
      ];
      const b2 = createMockB2(objects);

      const pruned = await pruneSafetySnapshots(b2, bucket, prefix, 2);
      expect(pruned).toEqual(["safety-2026-01-01T00-00-00Z"]);
      expect(b2.deleteObject).toHaveBeenCalledTimes(2);
      expect(b2.deleteObject).toHaveBeenCalledWith(
        bucket,
        `${prefix}/safety-2026-01-01T00-00-00Z/2026-01-01T00-00-01Z/file.txt`,
      );
      expect(b2.deleteObject).toHaveBeenCalledWith(
        bucket,
        `${prefix}/safety-2026-01-01T00-00-00Z/2026-01-01T00-00-01Z/partial.bin`,
      );
    });

    it("does nothing when safety snapshots are within keep count", async () => {
      const b2 = createMockB2([
        {
          key: `${prefix}/safety-2026-01-01T00-00-00Z/2026-01-01T00-00-01Z/file.txt`,
          size: 10,
          lastModified: "",
        },
      ]);

      const pruned = await pruneSafetySnapshots(b2, bucket, prefix, 2);
      expect(pruned).toEqual([]);
      expect(b2.deleteObject).not.toHaveBeenCalled();
    });

    it("tolerates safety objects already removed during pruning", async () => {
      const b2 = createMockB2([
        {
          key: `${prefix}/safety-2026-01-01T00-00-00Z/2026-01-01T00-00-01Z/file.txt`,
          size: 10,
          lastModified: "",
        },
        {
          key: `${prefix}/safety-2026-01-02T00-00-00Z/2026-01-02T00-00-01Z/file.txt`,
          size: 10,
          lastModified: "",
        },
      ]);
      b2.deleteObject.mockRejectedValueOnce(
        new B2RequestError(
          "deleteObject",
          404,
          "<Error><Code>NoSuchKey</Code><Message>missing</Message></Error>",
          "NoSuchKey",
        ),
      );

      const pruned = await pruneSafetySnapshots(b2, bucket, prefix, 1);

      expect(pruned).toEqual(["safety-2026-01-01T00-00-00Z"]);
      expect(b2.deleteObject).toHaveBeenCalledTimes(1);
    });
  });
});
