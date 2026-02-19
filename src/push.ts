import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk";
import type { B2Client } from "./b2-client.js";
import { gatherFiles } from "./gatherer.js";
import { computeManifest, diffManifests, serializeManifest } from "./manifest.js";
import { pruneSnapshots } from "./snapshots.js";
import { snapshotSqlite } from "./sqlite-snapshot.js";
import type { B2BackupConfig, BackupManifest } from "./types.js";

type PushLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  debug?: (msg: string) => void;
};

export async function push(
  config: B2BackupConfig,
  stateDir: string,
  b2: B2Client,
  logger: PushLogger,
): Promise<void> {
  const prefix = config.prefix ?? "openclaw-backup";
  const keepSnapshots = config.keepSnapshots ?? 10;
  const manifestCachePath = path.join(stateDir, ".b2-backup-manifest.json");

  // 1. Gather files
  const files = await gatherFiles(stateDir);
  if (files.length === 0) {
    logger.info("b2-backup: no files to sync");
    return;
  }

  // 2. Snapshot SQLite files to temp dir
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-backup-"));
  const sqliteFiles = files.filter((f) => f.relativePath.endsWith(".sqlite"));
  for (const sqliteFile of sqliteFiles) {
    const dest = path.join(tmpDir, sqliteFile.relativePath);
    await snapshotSqlite(sqliteFile.absolutePath, dest);
    sqliteFile.absolutePath = dest;
  }

  // 3. Compute manifest
  const manifest = await computeManifest(files);
  const timestamp = manifest.timestamp.replace(/:/g, "-").replace(/\.\d+Z$/, "Z");

  // 4. Load previous manifest
  const { value: prevManifest } = await readJsonFileWithFallback<BackupManifest | null>(
    manifestCachePath,
    null,
  );

  // 5. Diff
  const diff = diffManifests(prevManifest, manifest);
  const toUpload = [...diff.added, ...diff.changed];

  if (toUpload.length === 0 && diff.deleted.length === 0) {
    logger.info("b2-backup: no changes since last push");
    return;
  }

  logger.info(
    `b2-backup: pushing ${toUpload.length} files (${diff.added.length} added, ${diff.changed.length} changed, ${diff.deleted.length} deleted)`,
  );

  // 6. Upload changed files
  for (const relativePath of toUpload) {
    const file = files.find((f) => f.relativePath === relativePath);
    if (!file) continue;
    const body = await fs.promises.readFile(file.absolutePath);
    const key = `${prefix}/${timestamp}/${relativePath}`;
    await b2.putObject(config.bucket, key, body, "application/octet-stream");
    logger.debug?.(`b2-backup: uploaded ${relativePath}`);
  }

  // 7. Upload manifest
  const manifestKey = `${prefix}/${timestamp}/manifest.json`;
  await b2.putObject(
    config.bucket,
    manifestKey,
    Buffer.from(serializeManifest(manifest), "utf-8"),
    "application/json",
  );

  // 8. Save manifest locally
  await writeJsonFileAtomically(manifestCachePath, manifest);

  // 9. Prune old snapshots
  const pruned = await pruneSnapshots(b2, config.bucket, prefix, keepSnapshots);
  if (pruned.length > 0) {
    logger.info(`b2-backup: pruned ${pruned.length} old snapshots`);
  }

  // 10. Cleanup temp dir
  await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);

  logger.info(`b2-backup: push complete (snapshot ${timestamp})`);
}
