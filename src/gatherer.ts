import fs from "node:fs";
import path from "node:path";
import type { GatheredFile } from "./types.js";

const INCLUDE_PATTERNS = [
  /^openclaw\.json$/,
  /^openclaw\.json\.bak/,
  /^agents\/[^/]+\/sessions\/[^/]+\.jsonl$/,
  /^agents\/[^/]+\/sessions\/sessions\.json$/,
  /^agents\/[^/]+\/memory\/[^/]+\.sqlite$/,
  /^agents\/[^/]+\/agent\//,
  /^workspace\//,
  /^workspace-[^/]+\//,
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

/**
 * B2 rejects object keys that contain ASCII control characters (codepoints
 * <32) with `400 InvalidRequest — File names must not contain unicode
 * characters with codes less than 32`. We've seen this in the wild for
 * filenames produced by upstream document/email pipelines that didn't strip
 * trailing CR/LF from attachment names.
 *
 * If we sent such a file to B2 the entire push would abort. Filter those at
 * gather time instead — they're a tiny fraction of any real workload, and the
 * underlying issue belongs upstream.
 */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 32) return true;
  }
  return false;
}

export function shouldInclude(relativePath: string): boolean {
  if (hasControlChar(relativePath)) return false;
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
