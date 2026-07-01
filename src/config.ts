import type { B2BackupConfig, ResolvedB2BackupConfig } from "./types.js";

type Env = Record<string, string | undefined>;

function readEnv(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function readConfigString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveB2BackupConfig(
  config: Partial<B2BackupConfig> | undefined,
  env: Env = process.env,
): ResolvedB2BackupConfig | null {
  const keyId = readConfigString(config?.keyId) ?? readEnv(env, "B2_APPLICATION_KEY_ID");
  const applicationKey =
    readConfigString(config?.applicationKey) ?? readEnv(env, "B2_APPLICATION_KEY");
  const bucket = readConfigString(config?.bucket) ?? readEnv(env, "B2_BUCKET_NAME");
  const region = readConfigString(config?.region) ?? readEnv(env, "B2_REGION");
  const endpoint = readConfigString(config?.endpoint) ?? readEnv(env, "B2_ENDPOINT");
  const prefix = readConfigString(config?.prefix);
  const schedule = readConfigString(config?.schedule);

  if (!keyId || !applicationKey || !bucket || !region) {
    return null;
  }

  const resolved: ResolvedB2BackupConfig = {
    keyId,
    applicationKey,
    bucket,
    region,
  };
  if (endpoint) resolved.endpoint = endpoint;
  if (prefix) resolved.prefix = prefix;
  if (schedule) resolved.schedule = schedule;
  if (typeof config?.encrypt === "boolean") resolved.encrypt = config.encrypt;
  if (
    typeof config?.keepSnapshots === "number" &&
    Number.isInteger(config.keepSnapshots) &&
    config.keepSnapshots >= 0
  ) {
    resolved.keepSnapshots = config.keepSnapshots;
  }
  if (
    typeof config?.keepSafetySnapshots === "number" &&
    Number.isInteger(config.keepSafetySnapshots) &&
    config.keepSafetySnapshots >= 0
  ) {
    resolved.keepSafetySnapshots = config.keepSafetySnapshots;
  }
  return resolved;
}
