export type B2BackupConfig = {
  keyId: string;
  applicationKey: string;
  bucket: string;
  region?: string;
  endpoint?: string;
  prefix?: string;
  schedule?: string;
  encrypt?: boolean;
  keepSnapshots?: number;
  keepSafetySnapshots?: number;
};

export type ResolvedB2BackupConfig = B2BackupConfig & {
  region: string;
};

export type BackupManifest = {
  version: 1;
  timestamp: string;
  files: Record<string, { hash: string; size: number }>;
};

export type GatheredFile = {
  relativePath: string;
  absolutePath: string;
  size: number;
};

export const SAFETY_PREFIX = "safety";
