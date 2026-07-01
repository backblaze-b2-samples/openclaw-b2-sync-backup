import type { B2BackupConfig, ResolvedB2BackupConfig } from "./types.js";

const PLUGIN_ID = "openclaw-b2-backup";

type Env = Record<string, string | undefined>;

export class B2BackupConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "B2BackupConfigError";
  }
}

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

export function resolveB2BackupConfigFromOpenClawConfig(
  rawConfig: unknown,
  env: Env = process.env,
): ResolvedB2BackupConfig {
  const pluginConfig = extractB2BackupPluginConfig(rawConfig);
  const config = resolveB2BackupConfig(pluginConfig, env);
  if (!config) {
    throw new B2BackupConfigError(
      "missing required config (keyId, applicationKey, bucket, region). " +
        "Set them in plugins.entries.openclaw-b2-backup.config or B2_* environment variables.",
    );
  }
  return config;
}

export function extractB2BackupPluginConfig(
  rawConfig: unknown,
): Partial<B2BackupConfig> | undefined {
  if (!isRecord(rawConfig)) {
    throw new B2BackupConfigError("config root must be a JSON object");
  }

  const modernEntry = getRecord(rawConfig, ["plugins", "entries", PLUGIN_ID]);
  if (modernEntry) return readEntryConfig(modernEntry, `plugins.entries.${PLUGIN_ID}`);

  const legacyPluginsEntry = getRecord(rawConfig, ["plugins", PLUGIN_ID]);
  if (legacyPluginsEntry) return readEntryConfig(legacyPluginsEntry, `plugins.${PLUGIN_ID}`);

  const topLevelEntry = rawConfig[PLUGIN_ID];
  if (topLevelEntry !== undefined) {
    if (!isRecord(topLevelEntry)) {
      throw new B2BackupConfigError(`${PLUGIN_ID} must be an object`);
    }
    return readEntryConfig(topLevelEntry, PLUGIN_ID);
  }

  return undefined;
}

function readEntryConfig(
  entry: Record<string, unknown>,
  pathLabel: string,
): Partial<B2BackupConfig> | undefined {
  if (Object.prototype.hasOwnProperty.call(entry, "config")) {
    if (!isRecord(entry.config)) {
      throw new B2BackupConfigError(`${pathLabel}.config must be an object`);
    }
    return entry.config as Partial<B2BackupConfig>;
  }
  return entry as Partial<B2BackupConfig>;
}

function getRecord(root: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
  let cursor: unknown = root;
  for (const key of keys) {
    if (!isRecord(cursor)) return null;
    cursor = cursor[key];
  }
  return isRecord(cursor) ? cursor : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
