#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createB2Client } from "./b2-client.js";
import { resolveB2BackupConfig } from "./config.js";
import { push } from "./push.js";
import type { B2Client } from "./b2-client.js";
import type { B2BackupConfig, ResolvedB2BackupConfig } from "./types.js";

const PLUGIN_ID = "openclaw-b2-backup";
const CONFIG_FILENAME = "openclaw.json";
const DEFAULT_PREFIX = "openclaw-backup";

export const EXIT_CODES = {
  success: 0,
  pushFailure: 1,
  usage: 64,
  configMalformed: 65,
} as const;

type Env = Record<string, string | undefined>;

type CliOptions = {
  configPath?: string;
  dryRun: boolean;
  json: boolean;
  quiet: boolean;
  help: boolean;
};

type CliContext = {
  config: ResolvedB2BackupConfig;
  configPath: string;
  stateDir: string;
};

type CliLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  debug?: (msg: string) => void;
};

type CliDeps = {
  env?: Env;
  cwd?: string;
  homedir?: () => string;
  readFile?: (filePath: string, encoding: BufferEncoding) => Promise<string>;
  createB2Client?: typeof createB2Client;
  push?: typeof push;
};

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

type ParsedArgs =
  | { ok: true; options: CliOptions }
  | { ok: false; message: string; options: CliOptions };

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const defaultOptions = (): CliOptions => ({
  dryRun: false,
  json: false,
  quiet: false,
  help: false,
});

function usage(): string {
  return [
    "Usage: openclaw-b2-backup-push [--config <path>] [--dry-run] [--json] [--quiet]",
    "",
    "Options:",
    "  --config <path>  OpenClaw config path (defaults to ~/.openclaw/openclaw.json)",
    "  --dry-run        Check B2 bucket access without uploading a snapshot",
    "  --json           Print machine-readable JSON",
    "  --quiet          Suppress human-readable success and progress output",
    "  -h, --help       Show this help",
  ].join("\n");
}

export function parseArgs(argv: string[]): ParsedArgs {
  const options = defaultOptions();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--quiet") {
      options.quiet = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }
    if (arg === "--config") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        return { ok: false, message: "--config requires a path", options };
      }
      options.configPath = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      const value = arg.slice("--config=".length);
      if (!value) {
        return { ok: false, message: "--config requires a path", options };
      }
      options.configPath = value;
      continue;
    }
    if (arg.startsWith("-")) {
      return { ok: false, message: `unknown option: ${arg}`, options };
    }

    return { ok: false, message: `unexpected argument: ${arg}`, options };
  }

  return { ok: true, options };
}

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<CliResult> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    return failure(parsed.options, EXIT_CODES.usage, "usage", parsed.message);
  }

  const options = parsed.options;
  if (options.help) {
    return { exitCode: EXIT_CODES.success, stdout: `${usage()}\n`, stderr: "" };
  }

  const stderr: string[] = [];
  const logger = createLogger(options, stderr);

  try {
    const context = await loadCliContext(options, deps);
    const createClient = deps.createB2Client ?? createB2Client;
    const runPush = deps.push ?? push;
    const b2 = await createClient(
      context.config.keyId,
      context.config.applicationKey,
      context.config.region,
      {
        endpoint: context.config.endpoint,
        logger,
      },
    );

    if (options.dryRun) {
      await b2.headBucket(context.config.bucket);
      return success(options, context, "dry-run", stderr);
    }

    await runPush(context.config, context.stateDir, b2, logger);
    return success(options, context, "push", stderr);
  } catch (err) {
    const message = errorMessage(err);
    if (err instanceof ConfigError || isB2ConfigError(message)) {
      return failure(options, EXIT_CODES.configMalformed, "config_malformed", message, stderr);
    }
    return failure(options, EXIT_CODES.pushFailure, "push_failure", message, stderr);
  }
}

async function loadCliContext(options: CliOptions, deps: CliDeps): Promise<CliContext> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const homedir = deps.homedir ?? os.homedir;
  const stateDir = resolveStateDir(env, cwd, homedir, options.configPath);
  const configPath = resolveConfigPath(options.configPath, env, cwd, homedir, stateDir);
  const readFile = deps.readFile ?? fs.promises.readFile;
  let data: string;

  try {
    data = await readFile(configPath, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read config ${configPath}: ${errorMessage(err)}`);
  }

  let rawConfig: unknown;
  try {
    rawConfig = JSON.parse(data);
  } catch (err) {
    throw new ConfigError(`config ${configPath} is not valid JSON: ${errorMessage(err)}`);
  }

  const pluginConfig = extractPluginConfig(rawConfig);
  const config = resolveB2BackupConfig(pluginConfig, env);
  if (!config) {
    throw new ConfigError(
      "missing required config (keyId, applicationKey, bucket, region). " +
        "Set them in plugins.entries.openclaw-b2-backup.config or B2_* environment variables.",
    );
  }

  return { config, configPath, stateDir };
}

function resolveConfigPath(
  explicitConfigPath: string | undefined,
  env: Env,
  cwd: string,
  homedir: () => string,
  stateDir: string,
): string {
  const rawConfigPath =
    explicitConfigPath?.trim() ||
    env.OPENCLAW_CONFIG?.trim() ||
    env.OPENCLAW_CONFIG_PATH?.trim();
  if (rawConfigPath) return resolveUserPath(rawConfigPath, env, cwd, homedir);
  return path.join(stateDir, CONFIG_FILENAME);
}

function resolveStateDir(
  env: Env,
  cwd: string,
  homedir: () => string,
  explicitConfigPath?: string,
): string {
  const rawStateDir = env.OPENCLAW_STATE_DIR?.trim() || env.CLAWDBOT_STATE_DIR?.trim();
  if (rawStateDir) return resolveUserPath(rawStateDir, env, cwd, homedir);

  const rawConfigPath =
    explicitConfigPath?.trim() ||
    env.OPENCLAW_CONFIG?.trim() ||
    env.OPENCLAW_CONFIG_PATH?.trim();
  if (rawConfigPath) {
    return path.dirname(resolveUserPath(rawConfigPath, env, cwd, homedir));
  }

  return path.join(resolveHomeDir(env, cwd, homedir), ".openclaw");
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
  if (openclawHome) return resolveUserPath(openclawHome, { ...env, OPENCLAW_HOME: undefined }, cwd, homedir);
  const envHome = env.HOME?.trim() || env.USERPROFILE?.trim();
  if (envHome) return path.resolve(envHome);
  try {
    return path.resolve(homedir());
  } catch {
    return cwd;
  }
}

function extractPluginConfig(rawConfig: unknown): Partial<B2BackupConfig> | undefined {
  if (!isRecord(rawConfig)) {
    throw new ConfigError("config root must be a JSON object");
  }

  const modernEntry = getRecord(rawConfig, ["plugins", "entries", PLUGIN_ID]);
  if (modernEntry) return readEntryConfig(modernEntry, `plugins.entries.${PLUGIN_ID}`);

  const legacyPluginsEntry = getRecord(rawConfig, ["plugins", PLUGIN_ID]);
  if (legacyPluginsEntry) return readEntryConfig(legacyPluginsEntry, `plugins.${PLUGIN_ID}`);

  const topLevelEntry = rawConfig[PLUGIN_ID];
  if (topLevelEntry !== undefined) {
    if (!isRecord(topLevelEntry)) {
      throw new ConfigError(`${PLUGIN_ID} must be an object`);
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
      throw new ConfigError(`${pathLabel}.config must be an object`);
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

function createLogger(options: CliOptions, stderr: string[]): CliLogger {
  const write = (msg: string) => {
    if (!options.quiet && !options.json) stderr.push(`${msg}\n`);
  };
  return {
    info: write,
    warn: write,
    debug: undefined,
  };
}

function success(
  options: CliOptions,
  context: CliContext,
  mode: "push" | "dry-run",
  stderr: string[],
): CliResult {
  const body = {
    ok: true,
    mode,
    configPath: context.configPath,
    stateDir: context.stateDir,
    bucket: context.config.bucket,
    prefix: context.config.prefix ?? DEFAULT_PREFIX,
  };

  if (options.json) {
    return {
      exitCode: EXIT_CODES.success,
      stdout: `${JSON.stringify(body)}\n`,
      stderr: stderr.join(""),
    };
  }
  if (options.quiet) {
    return { exitCode: EXIT_CODES.success, stdout: "", stderr: stderr.join("") };
  }

  const action = mode === "dry-run" ? "dry run succeeded" : "push complete";
  return {
    exitCode: EXIT_CODES.success,
    stdout: `b2-backup: ${action}\n`,
    stderr: stderr.join(""),
  };
}

function failure(
  options: CliOptions,
  exitCode: number,
  code: "usage" | "config_malformed" | "push_failure",
  message: string,
  stderr: string[] = [],
): CliResult {
  if (options.json) {
    return {
      exitCode,
      stdout: `${JSON.stringify({ ok: false, code, error: message })}\n`,
      stderr: stderr.join(""),
    };
  }
  if (options.quiet) {
    return { exitCode, stdout: "", stderr: stderr.join("") };
  }

  const suffix = code === "usage" ? `\n\n${usage()}` : "";
  return {
    exitCode,
    stdout: "",
    stderr: `${stderr.join("")}b2-backup: ${message}${suffix}\n`,
  };
}

function isB2ConfigError(message: string): boolean {
  return message.startsWith("b2: endpoint ") || message.includes("region is required");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const result = await runCli(argv);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
  return result.exitCode;
}

function isDirectRun(): boolean {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  void main();
}

export type { B2Client };
