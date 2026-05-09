import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import type { B2Client } from "./b2-client.js";
import { decrypt, isEncrypted } from "./encryption.js";
import { deserializeManifest } from "./manifest.js";
import { push } from "./push.js";
import { getLatestSnapshot } from "./snapshots.js";
import { SAFETY_PREFIX } from "./types.js";
import type { B2BackupConfig, BackupManifest } from "./types.js";

type PullLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  debug?: (msg: string) => void;
};

export type PullOptions = {
  /** Skip creating a safety snapshot before restoring. */
  skipSafety?: boolean;
};

export async function pullLatest(
  config: B2BackupConfig,
  stateDir: string,
  b2: B2Client,
  logger: PullLogger,
  options?: PullOptions,
): Promise<void> {
  const prefix = config.prefix ?? "openclaw-backup";
  const latest = await getLatestSnapshot(b2, config.bucket, prefix);
  if (!latest) {
    logger.info("b2-backup: no snapshots found in bucket");
    return;
  }
  await pullSnapshot(config, stateDir, b2, logger, latest, options);
}

export async function pullSnapshot(
  config: B2BackupConfig,
  stateDir: string,
  b2: B2Client,
  logger: PullLogger,
  timestamp: string,
  options?: PullOptions,
): Promise<void> {
  const prefix = config.prefix ?? "openclaw-backup";

  // Create safety snapshot before restoring (unless skipped)
  if (!options?.skipSafety) {
    const safetyTs = new Date().toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
    const safetyPrefix = `${prefix}/${SAFETY_PREFIX}-${safetyTs}`;
    logger.info(`b2-backup: creating safety snapshot at ${safetyPrefix}`);
    try {
      await push(config, stateDir, b2, logger, {
        prefixOverride: safetyPrefix,
        skipPrune: true,
      });
    } catch (err) {
      logger.warn(`b2-backup: safety snapshot failed: ${String(err)}, continuing with pull`);
    }
  }

  const manifestKey = `${prefix}/${timestamp}/manifest.json`;
  logger.info(`b2-backup: pulling snapshot ${timestamp}`);

  // Download manifest
  const manifestData = await b2.getObject(config.bucket, manifestKey);
  const manifest = deserializeManifest(manifestData.toString("utf-8"));

  let restored = 0;
  let skipped = 0;

  for (const [relativePath, entry] of Object.entries(manifest.files)) {
    const destPath = path.join(stateDir, relativePath);

    // Check if local file already matches
    try {
      const existing = await fs.promises.readFile(destPath);
      const existingHash = crypto.createHash("sha256").update(existing).digest("hex");
      if (existingHash === entry.hash) {
        skipped++;
        continue;
      }
    } catch {
      // File doesn't exist locally
    }

    // Download file
    const key = `${prefix}/${timestamp}/${relativePath}`;
    let data = await b2.getObject(config.bucket, key);

    // Decrypt if encrypted (backward-compatible with unencrypted snapshots)
    if (isEncrypted(data)) {
      data = decrypt(data, config.applicationKey);
    }

    // Verify hash against plaintext
    const downloadHash = crypto.createHash("sha256").update(data).digest("hex");
    if (downloadHash !== entry.hash) {
      logger.warn(`b2-backup: hash mismatch for ${relativePath}, skipping`);
      continue;
    }

    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    await fs.promises.writeFile(destPath, data);
    restored++;
    logger.debug?.(`b2-backup: restored ${relativePath}`);
  }

  // Save manifest locally
  const manifestCachePath = path.join(stateDir, ".b2-backup-manifest.json");
  await writeJsonFileAtomically(manifestCachePath, manifest);

  logger.info(`b2-backup: pull complete (${restored} restored, ${skipped} unchanged)`);
}
