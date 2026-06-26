import type { B2Client } from "./b2-client.js";
import { SAFETY_PREFIX } from "./types.js";

export async function listSnapshots(
  b2: B2Client,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const objects = await b2.listObjects(bucket, `${prefix}/`);
  const snapshotIds = new Set<string>();
  for (const obj of objects) {
    // Keys look like: prefix/<snapshot-id>/file.json; safety snapshots are excluded.
    const afterPrefix = obj.key.slice(prefix.length + 1);
    const snapshotId = afterPrefix.split("/")[0];
    if (snapshotId && snapshotId !== "manifest.json" && !snapshotId.startsWith(`${SAFETY_PREFIX}-`)) {
      snapshotIds.add(snapshotId);
    }
  }
  return [...snapshotIds].sort();
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
  for (const snapshotId of toDelete) {
    const objects = await b2.listObjects(bucket, `${prefix}/${snapshotId}/`);
    for (const obj of objects) {
      await b2.deleteObject(bucket, obj.key);
    }
  }
  return toDelete;
}
