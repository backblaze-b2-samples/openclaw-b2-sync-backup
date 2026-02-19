import fs from "node:fs";
import path from "node:path";
import type { GatheredFile } from "./types.js";

const INCLUDE_PATTERNS = [
  /^openclaw\.json$/,
  /^openclaw\.json\.bak/,
  /^agents\/[^/]+\/sessions\/[^/]+\.jsonl$/,
  /^agents\/[^/]+\/sessions\/sessions\.json$/,
  /^agents\/[^/]+\/memory\/[^/]+\.sqlite$/,
  /^workspace\//,
  /^cron\//,
  /^hooks\//,
];

const EXCLUDE_PATTERNS = [
  /^credentials\//,
  /agents\/[^/]+\/agent\/auth-profiles\.json$/,
  /^media\//,
  /^extensions\//,
  /\.lock$/,
  /\.tmp$/,
  /-wal$/,
  /-shm$/,
  /(^|\/)\.DS_Store$/,
];

function matchesAny(relativePath: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(relativePath));
}

export function shouldInclude(relativePath: string): boolean {
  if (matchesAny(relativePath, EXCLUDE_PATTERNS)) return false;
  return matchesAny(relativePath, INCLUDE_PATTERNS);
}

export async function gatherFiles(stateDir: string): Promise<GatheredFile[]> {
  const results: GatheredFile[] = [];
  await walkDir(stateDir, stateDir, results);
  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function walkDir(base: string, dir: string, results: GatheredFile[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const rel = path.relative(base, fullPath);
      // Skip excluded directories early
      if (/^(credentials|media|extensions|node_modules)$/.test(rel.split(path.sep)[0] ?? "")) {
        continue;
      }
      await walkDir(base, fullPath, results);
    } else if (entry.isFile()) {
      const relativePath = path.relative(base, fullPath).split(path.sep).join("/");
      if (shouldInclude(relativePath)) {
        const stat = await fs.promises.stat(fullPath);
        results.push({
          relativePath,
          absolutePath: fullPath,
          size: stat.size,
        });
      }
    }
  }
}
