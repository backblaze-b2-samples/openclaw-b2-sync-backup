import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "openclaw/plugin-sdk";
import type { B2Client } from "./b2-client.js";
import { encrypt } from "./encryption.js";
import { gatherFiles } from "./gatherer.js";
import { computeManifest, diffManifests, serializeManifest } from "./manifest.js";
import { pruneSafetySnapshots, pruneSnapshots } from "./snapshots.js";
import { snapshotSqlite } from "./sqlite-snapshot.js";
import type { B2BackupConfig, BackupManifest } from "./types.js";

type PushLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  debug?: (msg: string) => void;
};

const PUSH_LOCK_DIRNAME = ".b2-backup-push.lock";
const PUSH_LOCK_OWNER_FILENAME = "owner.json";
const STALE_OWNERLESS_LOCK_GRACE_MS = 30_000;

export type PushOptions = {
  /** Override the complete snapshot root (used for safety snapshots). */
  prefixOverride?: string;
  /** Skip snapshot retention pruning. */
  skipPrune?: boolean;
};

export class PushLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushLockError";
  }
}

export async function push(
  config: B2BackupConfig,
  stateDir: string,
  b2: B2Client,
  logger: PushLogger,
  options?: PushOptions,
): Promise<void> {
  const lock = await acquirePushLock(stateDir);
  let pushError: unknown;
  try {
    await pushWithLock(config, stateDir, b2, logger, options);
  } catch (err) {
    pushError = err;
    throw err;
  } finally {
    try {
      await lock.release();
    } catch (err) {
      logger.warn(`b2-backup: failed to release push lock: ${String(err)}`);
      if (!pushError) throw err;
    }
  }
}

async function pushWithLock(
  config: B2BackupConfig,
  stateDir: string,
  b2: B2Client,
  logger: PushLogger,
  options?: PushOptions,
): Promise<void> {
  const prefix = config.prefix ?? "openclaw-backup";
  const keepSnapshots = config.keepSnapshots ?? 10;
  const keepSafetySnapshots = config.keepSafetySnapshots ?? keepSnapshots;
  const shouldEncrypt = config.encrypt !== false; // default true
  const manifestCachePath = path.join(stateDir, ".b2-backup-manifest.json");

  async function pruneRetention(): Promise<void> {
    if (options?.skipPrune || options?.prefixOverride) return;

    const pruned = await pruneSnapshots(b2, config.bucket, prefix, keepSnapshots);
    if (pruned.length > 0) {
      logger.info(`b2-backup: pruned ${pruned.length} old snapshots`);
    }

    const prunedSafety = await pruneSafetySnapshots(
      b2,
      config.bucket,
      prefix,
      keepSafetySnapshots,
    );
    if (prunedSafety.length > 0) {
      logger.info(`b2-backup: pruned ${prunedSafety.length} old safety snapshots`);
    }
  }

  // 1. Gather files
  const files = await gatherFiles(stateDir);
  if (files.length === 0) {
    logger.info("b2-backup: no files to sync");
    return;
  }

  // 2. Snapshot SQLite files to temp dir
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-backup-"));
  try {
    const sqliteFiles = files.filter((f) => f.relativePath.endsWith(".sqlite"));
    for (const sqliteFile of sqliteFiles) {
      const dest = path.join(tmpDir, sqliteFile.relativePath);
      await snapshotSqlite(sqliteFile.absolutePath, dest);
      sqliteFile.absolutePath = dest;
    }

    // 3. Compute manifest (always on plaintext)
    const manifest = await computeManifest(files);
    const snapshotId = createSnapshotId(manifest.timestamp);
    // prefixOverride is already the full snapshot root used by safety snapshots.
    const snapshotRoot = options?.prefixOverride ?? `${prefix}/${snapshotId}`;

    // 4. Load previous manifest (skip for safety snapshots)
    let prevManifest: BackupManifest | null = null;
    if (!options?.prefixOverride) {
      const result = await readJsonFileWithFallback<BackupManifest | null>(manifestCachePath, null);
      prevManifest = result.value;
    }

    // 5. Diff
    const diff = diffManifests(prevManifest, manifest);
    const toUpload = [...diff.added, ...diff.changed];

    if (toUpload.length === 0 && diff.deleted.length === 0) {
      logger.info("b2-backup: no changes since last push");
      await pruneRetention();
      return;
    }

    logger.info(
      `b2-backup: pushing ${toUpload.length} files (${diff.added.length} added, ${diff.changed.length} changed, ${diff.deleted.length} deleted)`,
    );

    // 6. Upload changed files (parallel, up to 8 concurrent uploads)
    const CONCURRENCY = 8;
    for (let i = 0; i < toUpload.length; i += CONCURRENCY) {
      const batch = toUpload.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (relativePath) => {
          const file = files.find((f) => f.relativePath === relativePath);
          if (!file) return;
          const fileBody = await fs.promises.readFile(file.absolutePath);
          const body = shouldEncrypt ? encrypt(fileBody, config.applicationKey) : fileBody;
          const key = `${snapshotRoot}/${relativePath}`;
          await b2.putObject(config.bucket, key, body, "application/octet-stream");
          logger.debug?.(`b2-backup: uploaded ${relativePath}`);
        }),
      );
    }

    // 7. Upload manifest (always unencrypted)
    const manifestKey = `${snapshotRoot}/manifest.json`;
    await b2.putObject(
      config.bucket,
      manifestKey,
      Buffer.from(serializeManifest(manifest), "utf-8"),
      "application/json",
    );

    // 8. Save manifest locally (skip for safety snapshots)
    if (!options?.prefixOverride) {
      await writeJsonFileAtomically(manifestCachePath, manifest);
    }

    // 9. Prune old snapshots and safety snapshot prefixes.
    await pruneRetention();

    logger.info(`b2-backup: push complete (snapshot ${options?.prefixOverride ?? snapshotId})`);
  } finally {
    await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function createSnapshotId(timestamp: string): string {
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  return `${safeTimestamp}-${crypto.randomUUID().slice(0, 8)}`;
}

export { createSnapshotId as _createSnapshotId };

async function acquirePushLock(stateDir: string): Promise<{ release: () => Promise<void> }> {
  const lockDir = path.join(stateDir, PUSH_LOCK_DIRNAME);
  await fs.promises.mkdir(stateDir, { recursive: true });

  if (!(await tryCreateLockDir(lockDir))) {
    const removedStaleLock = await removeDeadProcessLock(lockDir);
    if (!removedStaleLock || !(await tryCreateLockDir(lockDir))) {
      throw new PushLockError(`another push is already running (lock: ${lockDir})`);
    }
  }

  try {
    await writeLockOwner(lockDir);
  } catch (err) {
    await fs.promises.rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  return {
    async release() {
      await fs.promises.rm(lockDir, { recursive: true, force: true });
    },
  };
}

async function tryCreateLockDir(lockDir: string): Promise<boolean> {
  try {
    await fs.promises.mkdir(lockDir);
    return true;
  } catch (err) {
    if (isNodeError(err, "EEXIST")) return false;
    throw err;
  }
}

async function writeLockOwner(lockDir: string): Promise<void> {
  const owner = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  await fs.promises.writeFile(
    path.join(lockDir, PUSH_LOCK_OWNER_FILENAME),
    JSON.stringify(owner, null, 2),
    "utf8",
  );
}

async function removeDeadProcessLock(lockDir: string): Promise<boolean> {
  const ownerPath = path.join(lockDir, PUSH_LOCK_OWNER_FILENAME);
  let owner: { pid?: unknown };
  try {
    owner = JSON.parse(await fs.promises.readFile(ownerPath, "utf8")) as { pid?: unknown };
  } catch {
    return removeAgedOwnerlessLock(lockDir);
  }

  if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    return removeAgedOwnerlessLock(lockDir);
  }
  if (isProcessRunning(owner.pid)) return false;

  await fs.promises.rm(lockDir, { recursive: true, force: true });
  return true;
}

async function removeAgedOwnerlessLock(lockDir: string): Promise<boolean> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(lockDir);
  } catch {
    return false;
  }

  if (Date.now() - stat.mtimeMs < STALE_OWNERLESS_LOCK_GRACE_MS) {
    return false;
  }

  await fs.promises.rm(lockDir, { recursive: true, force: true });
  return true;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !isNodeError(err, "ESRCH");
  }
}

function isNodeError(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && err.code === code;
}
