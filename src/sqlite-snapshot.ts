import fs from "node:fs";
import path from "node:path";

export async function snapshotSqlite(dbPath: string, destPath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  try {
    // Try using node:sqlite .backup() API (Node 22+)
    const { DatabaseSync } = await import("node:sqlite" as string);
    const src = new DatabaseSync(dbPath, { open: true, readOnly: true });
    try {
      src.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // WAL checkpoint may not be relevant for all databases
    }
    const dest = new DatabaseSync(destPath);
    (src as unknown as { backup(dest: unknown): void }).backup(dest);
    dest.close();
    src.close();
  } catch {
    // Fallback: plain copy
    await fs.promises.copyFile(dbPath, destPath);
    // Also copy WAL/SHM if present
    for (const suffix of ["-wal", "-shm"]) {
      try {
        await fs.promises.copyFile(`${dbPath}${suffix}`, `${destPath}${suffix}`);
      } catch {
        // WAL/SHM may not exist
      }
    }
  }
}
