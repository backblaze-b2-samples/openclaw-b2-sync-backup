import type { B2Client } from "./b2-client.js";
import { SAFETY_PREFIX } from "./types.js";

function snapshotDirFromPrefix(commonPrefix: string, prefix: string): string | null {
  const rootPrefix = `${prefix}/`;
  if (!commonPrefix.startsWith(rootPrefix)) {
    return null;
  }
  const afterPrefix = commonPrefix.slice(rootPrefix.length);
  return afterPrefix.split("/")[0] || null;
}

function isSafetySnapshotDir(dir: string): boolean {
  return dir.startsWith(`${SAFETY_PREFIX}-`);
}

async function listSnapshotDirs(
  b2: B2Client,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const prefixes = await b2.listPrefixes(bucket, `${prefix}/`);
  const timestamps = new Set<string>();
  for (const commonPrefix of prefixes) {
    const tsDir = snapshotDirFromPrefix(commonPrefix, prefix);
    if (tsDir) {
      timestamps.add(tsDir);
    }
  }
  return [...timestamps].sort();
}

export async function listRegularSnapshots(
  b2: B2Client,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const snapshotDirs = await listSnapshotDirs(b2, bucket, prefix);
  return snapshotDirs.filter((dir) => !isSafetySnapshotDir(dir));
}

export async function listSafetySnapshots(
  b2: B2Client,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const snapshotDirs = await listSnapshotDirs(b2, bucket, prefix);
  const safetySnapshots = new Set<string>();

  for (const safetyDir of snapshotDirs.filter(isSafetySnapshotDir)) {
    const nestedPrefixes = await b2.listPrefixes(bucket, `${prefix}/${safetyDir}/`);
    for (const nestedPrefix of nestedPrefixes) {
      const nestedDir = snapshotDirFromPrefix(nestedPrefix, `${prefix}/${safetyDir}`);
      if (nestedDir) {
        safetySnapshots.add(`${safetyDir}/${nestedDir}`);
      }
    }
  }

  return [...safetySnapshots].sort();
}

/** Lists regular snapshots only. Use listSafetySnapshots for safety snapshots. */
export async function listSnapshots(
  b2: B2Client,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  return listRegularSnapshots(b2, bucket, prefix);
}

export async function getLatestSnapshot(
  b2: B2Client,
  bucket: string,
  prefix: string,
): Promise<string | null> {
  const snapshots = await listRegularSnapshots(b2, bucket, prefix);
  return snapshots.length > 0 ? snapshots[snapshots.length - 1]! : null;
}

export async function pruneSnapshots(
  b2: B2Client,
  bucket: string,
  prefix: string,
  keep: number,
): Promise<string[]> {
  const snapshots = await listRegularSnapshots(b2, bucket, prefix);
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
