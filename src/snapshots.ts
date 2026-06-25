import type { B2Client, B2ClientWithPrefixes } from "./b2-client.js";
import { SAFETY_PREFIX } from "./types.js";

function supportsPrefixListing(b2: B2Client): b2 is B2ClientWithPrefixes {
  return typeof (b2 as Partial<B2ClientWithPrefixes>).listPrefixes === "function";
}

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
  if (!supportsPrefixListing(b2)) {
    const objects = await b2.listObjects(bucket, `${prefix}/`);
    const timestamps = new Set<string>();
    for (const obj of objects) {
      const afterPrefix = obj.key.slice(prefix.length + 1);
      const tsDir = afterPrefix.split("/")[0];
      if (tsDir && tsDir !== "manifest.json") {
        timestamps.add(tsDir);
      }
    }
    return [...timestamps].sort();
  }

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

/** Lists regular snapshots only, excluding safety-* prefixes. */
export async function listRegularSnapshots(
  b2: B2Client,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const snapshotDirs = await listSnapshotDirs(b2, bucket, prefix);
  return snapshotDirs.filter((dir) => !isSafetySnapshotDir(dir));
}

/** Lists restorable safety snapshots as safety-{timestamp}/{snapshot-timestamp}. */
export async function listSafetySnapshots(
  b2: B2Client,
  bucket: string,
  prefix: string,
): Promise<string[]> {
  const safetySnapshots = new Set<string>();

  if (!supportsPrefixListing(b2)) {
    const objects = await b2.listObjects(bucket, `${prefix}/`);
    for (const obj of objects) {
      const afterPrefix = obj.key.slice(prefix.length + 1);
      const parts = afterPrefix.split("/");
      const safetyDir = parts[0];
      const nestedDir = parts[1];
      if (safetyDir && nestedDir && isSafetySnapshotDir(safetyDir)) {
        safetySnapshots.add(`${safetyDir}/${nestedDir}`);
      }
    }
    return [...safetySnapshots].sort();
  }

  const snapshotDirs = await listSnapshotDirs(b2, bucket, prefix);
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

/** Prunes whole safety-* prefixes separately from regular snapshot retention. */
export async function pruneSafetySnapshots(
  b2: B2Client,
  bucket: string,
  prefix: string,
  keep: number,
): Promise<string[]> {
  const snapshotDirs = await listSnapshotDirs(b2, bucket, prefix);
  const safetyDirs = snapshotDirs.filter(isSafetySnapshotDir);
  if (safetyDirs.length <= keep) return [];

  const toDelete = safetyDirs.slice(0, safetyDirs.length - keep);
  for (const safetyDir of toDelete) {
    const objects = await b2.listObjects(bucket, `${prefix}/${safetyDir}/`);
    for (const obj of objects) {
      await b2.deleteObject(bucket, obj.key);
    }
  }
  return toDelete;
}
