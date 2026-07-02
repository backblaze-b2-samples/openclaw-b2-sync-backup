import fs from "node:fs";
import path from "node:path";
import type { GatheredFile } from "./types.js";

type GatherLogger = {
  warn?: (msg: string) => void;
};

export type GatherOptions = {
  logger?: GatherLogger;
};

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

function hasAsciiControlChar(relativePath: string): boolean {
  for (let i = 0; i < relativePath.length; i += 1) {
    const code = relativePath.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function escapePathForDiagnostic(relativePath: string): string {
  return relativePath.replace(/[\x00-\x1f\x7f]/g, (char) => {
    return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
}

export function shouldInclude(relativePath: string): boolean {
  if (hasAsciiControlChar(relativePath)) return false;
  if (matchesAny(relativePath, EXCLUDE_PATTERNS)) return false;
  return matchesAny(relativePath, INCLUDE_PATTERNS);
}

export async function gatherFiles(
  stateDir: string,
  options: GatherOptions = {},
): Promise<GatheredFile[]> {
  const results: GatheredFile[] = [];
  await walkDir(stateDir, stateDir, results, options);
  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function walkDir(
  base: string,
  dir: string,
  results: GatheredFile[],
  options: GatherOptions,
): Promise<void> {
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
      await walkDir(base, fullPath, results, options);
    } else if (entry.isFile()) {
      const relativePath = path.relative(base, fullPath).split(path.sep).join("/");
      if (hasAsciiControlChar(relativePath)) {
        options.logger?.warn?.(
          `b2-backup: skipped path with ASCII control character: ${escapePathForDiagnostic(relativePath)}`,
        );
        continue;
      }
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
