import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeJsonFileAtomically } from "openclaw/plugin-sdk";
import type { B2Client } from "./b2-client.js";
import { deserializeManifest } from "./manifest.js";
import { getLatestSnapshot } from "./snapshots.js";
import type { B2BackupConfig, BackupManifest } from "./types.js";

type PullLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  debug?: (msg: string) => void;
};

export async function pullLatest(
  config: B2BackupConfig,
  stateDir: string,
  b2: B2Client,
  logger: PullLogger,
): Promise<void> {
  const prefix = config.prefix ?? "openclaw-backup";
  const latest = await getLatestSnapshot(b2, config.bucket, prefix);
  if (!latest) {
    logger.info("b2-backup: no snapshots found in bucket");
    return;
  }
  await pullSnapshot(config, stateDir, b2, logger, latest);
}

export async function pullSnapshot(
  config: B2BackupConfig,
  stateDir: string,
  b2: B2Client,
  logger: PullLogger,
  timestamp: string,
): Promise<void> {
  const prefix = config.prefix ?? "openclaw-backup";
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

    // Download and write
    const key = `${prefix}/${timestamp}/${relativePath}`;
    const data = await b2.getObject(config.bucket, key);

    // Verify hash
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
