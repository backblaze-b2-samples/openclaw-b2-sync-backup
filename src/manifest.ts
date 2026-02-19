import crypto from "node:crypto";
import fs from "node:fs";
import type { BackupManifest, GatheredFile } from "./types.js";

export async function computeManifest(files: GatheredFile[]): Promise<BackupManifest> {
  const fileEntries: BackupManifest["files"] = {};
  for (const file of files) {
    const hash = await hashFile(file.absolutePath);
    fileEntries[file.relativePath] = { hash, size: file.size };
  }
  return {
    version: 1,
    timestamp: new Date().toISOString(),
    files: fileEntries,
  };
}

export type ManifestDiff = {
  added: string[];
  changed: string[];
  deleted: string[];
};

export function diffManifests(
  local: BackupManifest | null,
  current: BackupManifest,
): ManifestDiff {
  const added: string[] = [];
  const changed: string[] = [];
  const deleted: string[] = [];

  const prevFiles = local?.files ?? {};

  for (const [path, entry] of Object.entries(current.files)) {
    const prev = prevFiles[path];
    if (!prev) {
      added.push(path);
    } else if (prev.hash !== entry.hash) {
      changed.push(path);
    }
  }

  for (const path of Object.keys(prevFiles)) {
    if (!(path in current.files)) {
      deleted.push(path);
    }
  }

  return { added, changed, deleted };
}

export function serializeManifest(manifest: BackupManifest): string {
  return JSON.stringify(manifest, null, 2);
}

export function deserializeManifest(data: string): BackupManifest {
  return JSON.parse(data) as BackupManifest;
}

async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

export { hashFile as _hashFile };
