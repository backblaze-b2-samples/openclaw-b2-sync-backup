import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { B2BackupConfig, ResolvedB2BackupConfig } from "./types.js";

const require = createRequire(import.meta.url);
const { parse: parseJson5 } = require("json5") as { parse: (data: string) => unknown };

const PLUGIN_ID = "openclaw-b2-backup";
const CONFIG_FILENAME = "openclaw.json";

type Env = Record<string, string | undefined>;

export type OpenClawConfigFileOptions = {
  configPath?: string;
  stateDir?: string;
  env?: Env;
  cwd?: string;
  homedir?: () => string;
  readFile?: (filePath: string, encoding: BufferEncoding) => Promise<string>;
};

export type OpenClawB2BackupConfigContext = {
  config: ResolvedB2BackupConfig;
  configPath: string;
  stateDir: string;
};

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

export async function loadB2BackupConfigFromOpenClawFile(
  options: OpenClawConfigFileOptions = {},
): Promise<OpenClawB2BackupConfigContext> {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const homedir = options.homedir ?? os.homedir;
  const paths = resolveOpenClawConfigPaths({
    configPath: options.configPath,
    stateDir: options.stateDir,
    env,
    cwd,
    homedir,
  });
  const readFile = options.readFile ?? fs.promises.readFile;
  let data: string;

  try {
    data = await readFile(paths.configPath, "utf8");
  } catch (err) {
    throw new B2BackupConfigError(`cannot read config ${paths.configPath}: ${errorMessage(err)}`);
  }

  const rawConfig = parseOpenClawConfig(data, paths.configPath);
  const config = resolveB2BackupConfigFromOpenClawConfig(rawConfig, env);

  return { config, configPath: paths.configPath, stateDir: paths.stateDir };
}

export function resolveOpenClawConfigPaths(options: {
  configPath?: string;
  stateDir?: string;
  env?: Env;
  cwd?: string;
  homedir?: () => string;
}): { configPath: string; stateDir: string } {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const homedir = options.homedir ?? os.homedir;
  const explicitStateDir = readExplicitStateDir(options.stateDir, env);
  const stateDir = explicitStateDir
    ? resolveUserPath(explicitStateDir, env, cwd, homedir)
    : path.join(resolveHomeDir(env, cwd, homedir), ".openclaw");
  const explicitConfigPath = readExplicitConfigPath(options.configPath, env);
  const configPath = explicitConfigPath
    ? resolveUserPath(explicitConfigPath, env, cwd, homedir)
    : path.join(stateDir, CONFIG_FILENAME);

  if (explicitConfigPath && !explicitStateDir && !isPathInside(configPath, stateDir)) {
    throw new B2BackupConfigError(
      `config ${configPath} is outside the default OpenClaw state directory ${stateDir}; ` +
        "set --state-dir, OPENCLAW_STATE_DIR, or CLAWDBOT_STATE_DIR.",
    );
  }

  return { configPath, stateDir };
}

export function parseOpenClawConfig(data: string, configPath = CONFIG_FILENAME): unknown {
  try {
    return parseJson5(data);
  } catch (err) {
    throw new B2BackupConfigError(`config ${configPath} is not valid JSON5: ${errorMessage(err)}`);
  }
}

export function extractB2BackupPluginConfig(
  rawConfig: unknown,
): Partial<B2BackupConfig> | undefined {
  if (!isRecord(rawConfig)) {
    throw new B2BackupConfigError("config root must be a JSON object");
  }

  const modernEntry = getOptionalRecordAtPath(
    rawConfig,
    ["plugins", "entries", PLUGIN_ID],
    `plugins.entries.${PLUGIN_ID}`,
  );
  if (modernEntry) return readEntryConfig(modernEntry, `plugins.entries.${PLUGIN_ID}`);

  const legacyPluginsEntry = getOptionalRecordAtPath(
    rawConfig,
    ["plugins", PLUGIN_ID],
    `plugins.${PLUGIN_ID}`,
  );
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

function getOptionalRecordAtPath(
  root: Record<string, unknown>,
  keys: string[],
  pathLabel: string,
): Record<string, unknown> | undefined {
  let cursor: unknown = root;
  const pathParts: string[] = [];
  for (const key of keys) {
    if (!isRecord(cursor)) {
      throw new B2BackupConfigError(`${pathParts.join(".")} must be an object`);
    }
    if (!Object.prototype.hasOwnProperty.call(cursor, key)) return undefined;
    cursor = cursor[key];
    pathParts.push(key);
  }
  if (!isRecord(cursor)) {
    throw new B2BackupConfigError(`${pathLabel} must be an object`);
  }
  return cursor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readExplicitConfigPath(cliConfigPath: string | undefined, env: Env): string | undefined {
  return cliConfigPath?.trim() || env.OPENCLAW_CONFIG?.trim() || env.OPENCLAW_CONFIG_PATH?.trim();
}

function readExplicitStateDir(cliStateDir: string | undefined, env: Env): string | undefined {
  return cliStateDir?.trim() || env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
}

function resolveUserPath(input: string, env: Env, cwd: string, homedir: () => string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("~")) {
    return path.resolve(trimmed.replace(/^~(?=$|[\\/])/, resolveHomeDir(env, cwd, homedir)));
  }
  if (path.isAbsolute(trimmed)) return path.resolve(trimmed);
  return path.resolve(cwd, trimmed);
}

function resolveHomeDir(env: Env, cwd: string, homedir: () => string): string {
  const openclawHome = env.OPENCLAW_HOME?.trim();
  if (openclawHome) {
    return resolveUserPath(openclawHome, { ...env, OPENCLAW_HOME: undefined }, cwd, homedir);
  }
  const envHome = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (envHome) return path.resolve(envHome);
  try {
    return path.resolve(homedir());
  } catch {
    return cwd;
  }
}

function isPathInside(childPath: string, parentPath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return (
    relative === "" ||
    (!!relative &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
