import type { B2Client } from "./b2-client.js";

export async function listSnapshots(
  b2: B2Client,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const objects = await b2.listObjects(bucket, `${prefix}/`);
  const timestamps = new Set<string>();
  for (const obj of objects) {
    // Keys look like: prefix/2026-02-09T00-00-00Z/file.json
    const afterPrefix = obj.key.slice(prefix.length + 1);
    const tsDir = afterPrefix.split("/")[0];
    if (tsDir && tsDir !== "manifest.json") {
      timestamps.add(tsDir);
    }
  }
  return [...timestamps].sort();
}

export async function getLatestSnapshot(
  b2: B2Client,
  bucket: string,
  prefix: string,
): Promise<string | null> {
  const snapshots = await listSnapshots(b2, bucket, prefix);
  return snapshots.length > 0 ? snapshots[snapshots.length - 1]! : null;
}

export async function pruneSnapshots(
  b2: B2Client,
  bucket: string,
  prefix: string,
  keep: number,
): Promise<string[]> {
  const snapshots = await listSnapshots(b2, bucket, prefix);
  if (snapshots.length <= keep) return [];

  const toDelete = snapshots.slice(0, snapshots.length - keep);
  for (const ts of toDelete) {
    const objects = await b2.listObjects(bucket, `${prefix}/${ts}/`);
    for (const obj of objects) {
      await b2.deleteObject(bucket, obj.key);
    }
  }
  return toDelete;
}
