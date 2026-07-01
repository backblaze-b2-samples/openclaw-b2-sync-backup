import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXIT_CODES, isDirectRun, parseArgs, runCli } from "./cli.js";
import type { B2Client } from "./b2-client.js";
import type { CliJsonFailure, CliJsonOutput, CliJsonSuccess } from "./cli.js";

function createMockB2(overrides: Partial<B2Client> = {}): B2Client {
  return {
    putObject: vi.fn(),
    getObject: vi.fn(),
    listObjects: vi.fn(),
    deleteObject: vi.fn(),
    headBucket: vi.fn(),
    ...overrides,
  } as unknown as B2Client;
}

async function makeStateDir(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-cli-state-"));
}

async function writeConfig(stateDir: string, value: unknown): Promise<string> {
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.promises.writeFile(configPath, JSON.stringify(value), "utf8");
  return configPath;
}

async function writeConfigText(stateDir: string, value: string): Promise<string> {
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.promises.writeFile(configPath, value, "utf8");
  return configPath;
}

function configArgs(configPath: string, stateDir: string, ...extra: string[]): string[] {
  return ["--config", configPath, "--state-dir", stateDir, ...extra];
}

function parseJsonOutput<T extends CliJsonOutput>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void } {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("openclaw-b2-backup-push CLI", () => {
  const createdDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      createdDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })),
    );
  });

  it("parses supported options", () => {
    const parsed = parseArgs([
      "--config",
      "/tmp/openclaw.json",
      "--state-dir",
      "/tmp/openclaw-state",
      "--dry-run",
      "--allow-empty-state",
      "--json",
      "--quiet",
    ]);

    expect(parsed).toEqual({
      ok: true,
      options: {
        configPath: "/tmp/openclaw.json",
        stateDir: "/tmp/openclaw-state",
        dryRun: true,
        allowEmptyState: true,
        help: false,
        json: true,
        quiet: true,
      },
    });
  });

  it("returns usage error for unknown options", async () => {
    const result = await runCli(["--nope"]);

    expect(result.exitCode).toBe(EXIT_CODES.usage);
    expect(result.stderr).toContain("unknown option");
  });

  it("recognizes symlinked package-manager bin paths as direct runs", () => {
    const symlinkPath = path.join(os.tmpdir(), "node_modules", ".bin", "openclaw-b2-backup-push");
    const modulePath = path.join(os.tmpdir(), "package", "dist", "src", "cli.mjs");
    const realpathSync = vi.spyOn(fs, "realpathSync").mockImplementation((filePath) => {
      const value = String(filePath);
      if (value === symlinkPath || value === modulePath) return modulePath;
      return path.resolve(value);
    });

    expect(isDirectRun(symlinkPath, modulePath)).toBe(true);
    expect(realpathSync).toHaveBeenCalledWith(symlinkPath);
    expect(realpathSync).toHaveBeenCalledWith(modulePath);
  });

  it("honors json output for usage errors after the failing option", async () => {
    const parsed = parseArgs(["--config", "--json"]);
    expect(parsed).toEqual({
      ok: false,
      message: "--config requires a path",
      options: {
        allowEmptyState: false,
        dryRun: false,
        help: false,
        json: true,
        quiet: false,
      },
    });

    const result = await runCli(["--config", "--json"]);

    expect(result.exitCode).toBe(EXIT_CODES.usage);
    expect(result.stderr).toBe("");
    expect(parseJsonOutput<CliJsonFailure>(result.stdout)).toEqual({
      ok: false,
      code: "usage",
      error: "--config requires a path",
    });
  });

  it("rejects equals-form config values that look like options", () => {
    expect(parseArgs(["--config=--json"])).toEqual({
      ok: false,
      message: "--config requires a path",
      options: {
        allowEmptyState: false,
        dryRun: false,
        help: false,
        json: false,
        quiet: false,
      },
    });
  });

  it("rejects equals-form state-dir values that look like options", () => {
    expect(parseArgs(["--state-dir=--json"])).toEqual({
      ok: false,
      message: "--state-dir requires a path",
      options: {
        allowEmptyState: false,
        dryRun: false,
        help: false,
        json: false,
        quiet: false,
      },
    });
  });

  it("pushes using modern OpenClaw plugin config", async () => {
    const stateDir = await makeStateDir();
    createdDirs.push(stateDir);
    const configPath = await writeConfig(stateDir, {
      plugins: {
        entries: {
          "openclaw-b2-backup": {
            enabled: true,
            config: {
              keyId: "key-id",
              applicationKey: "app-key",
              bucket: "bucket-name",
              region: "us-west-004",
              prefix: "custom-prefix",
            },
          },
        },
      },
    });
    const b2 = createMockB2();
    const createB2 = vi.fn(async () => b2);
    const push = vi.fn(async () => undefined);

    const result = await runCli(configArgs(configPath, stateDir, "--quiet"), {
      createB2Client: createB2,
      push,
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(createB2).toHaveBeenCalledWith("key-id", "app-key", "us-west-004", {
      endpoint: undefined,
      logger: expect.any(Object),
    });
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: "bucket-name", prefix: "custom-prefix" }),
      stateDir,
      b2,
      expect.any(Object),
    );
  });

  it("uses OPENCLAW_CONFIG and B2 env vars when plugin config is absent", async () => {
    const stateDir = await makeStateDir();
    createdDirs.push(stateDir);
    const configPath = await writeConfig(stateDir, {});
    const b2 = createMockB2();
    const createB2 = vi.fn(async () => b2);
    const push = vi.fn(async () => undefined);

    const result = await runCli(["--quiet"], {
      env: {
        OPENCLAW_CONFIG: configPath,
        OPENCLAW_STATE_DIR: stateDir,
        B2_APPLICATION_KEY_ID: "env-key",
        B2_APPLICATION_KEY: "env-secret",
        B2_BUCKET_NAME: "env-bucket",
        B2_REGION: "env-region",
      },
      createB2Client: createB2,
      push,
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(createB2).toHaveBeenCalledWith("env-key", "env-secret", "env-region", {
      endpoint: undefined,
      logger: expect.any(Object),
    });
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: "env-bucket" }),
      stateDir,
      b2,
      expect.any(Object),
    );
  });

  it("dry-run checks bucket access without pushing", async () => {
    const stateDir = await makeStateDir();
    createdDirs.push(stateDir);
    const configPath = await writeConfig(stateDir, {
      "openclaw-b2-backup": {
        enabled: true,
        config: {
          keyId: "key-id",
          applicationKey: "app-key",
          bucket: "bucket-name",
          region: "us-west-004",
        },
      },
    });
    const headBucket = vi.fn(async () => undefined);
    const b2 = createMockB2({ headBucket });
    const createB2 = vi.fn(async () => b2);
    const push = vi.fn(async () => undefined);

    const result = await runCli(configArgs(configPath, stateDir, "--dry-run", "--json"), {
      createB2Client: createB2,
      push,
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(parseJsonOutput<CliJsonSuccess>(result.stdout)).toEqual({
      ok: true,
      mode: "dry-run",
      configPath,
      stateDir,
      bucket: "bucket-name",
      prefix: "openclaw-backup",
    });
    expect(headBucket).toHaveBeenCalledWith("bucket-name");
    expect(push).not.toHaveBeenCalled();
  });

  it("parses JSON5 OpenClaw configs with comments and trailing commas", async () => {
    const stateDir = await makeStateDir();
    createdDirs.push(stateDir);
    const configPath = await writeConfigText(
      stateDir,
      `{
        // OpenClaw config files are JSON5.
        plugins: {
          entries: {
            "openclaw-b2-backup": {
              config: {
                keyId: "key-id",
                applicationKey: "app-key",
                bucket: "bucket-name",
                region: "us-west-004",
              },
            },
          },
        },
      }`,
    );
    const headBucket = vi.fn(async () => undefined);
    const b2 = createMockB2({ headBucket });

    const result = await runCli(configArgs(configPath, stateDir, "--dry-run", "--json"), {
      createB2Client: vi.fn(async () => b2),
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(parseJsonOutput<CliJsonSuccess>(result.stdout)).toEqual(
      expect.objectContaining({
        ok: true,
        mode: "dry-run",
        bucket: "bucket-name",
      }),
    );
    expect(headBucket).toHaveBeenCalledWith("bucket-name");
  });

  it("rejects external config paths without an explicit state directory", async () => {
    const configDir = await makeStateDir();
    createdDirs.push(configDir);
    const configPath = await writeConfig(configDir, {
      plugins: {
        entries: {
          "openclaw-b2-backup": {
            config: {
              keyId: "key-id",
              applicationKey: "app-key",
              bucket: "bucket-name",
              region: "us-west-004",
            },
          },
        },
      },
    });

    const result = await runCli(["--config", configPath, "--json"], {
      env: { HOME: path.join(configDir, "home") },
    });

    expect(result.exitCode).toBe(EXIT_CODES.configMalformed);
    expect(parseJsonOutput<CliJsonFailure>(result.stdout)).toEqual({
      ok: false,
      code: "config_malformed",
      error: expect.stringContaining("set --state-dir"),
    });
  });

  it("rejects empty state directories unless acknowledged", async () => {
    const configDir = await makeStateDir();
    const stateDir = await makeStateDir();
    createdDirs.push(configDir, stateDir);
    const configPath = await writeConfig(configDir, {
      plugins: {
        entries: {
          "openclaw-b2-backup": {
            config: {
              keyId: "key-id",
              applicationKey: "app-key",
              bucket: "bucket-name",
              region: "us-west-004",
            },
          },
        },
      },
    });
    const createB2 = vi.fn(async () => createMockB2());
    const push = vi.fn(async () => undefined);

    const result = await runCli(configArgs(configPath, stateDir, "--json"), {
      createB2Client: createB2,
      push,
    });

    expect(result.exitCode).toBe(EXIT_CODES.configMalformed);
    expect(parseJsonOutput<CliJsonFailure>(result.stdout)).toEqual({
      ok: false,
      code: "config_malformed",
      error: expect.stringContaining("contains no syncable OpenClaw state files"),
    });
    expect(createB2).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();

    const acknowledged = await runCli(
      configArgs(configPath, stateDir, "--allow-empty-state", "--quiet"),
      {
        createB2Client: createB2,
        push,
      },
    );
    expect(acknowledged.exitCode).toBe(EXIT_CODES.success);
    expect(push).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: "bucket-name" }),
      stateDir,
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("reports unreadable state directory errors before gathering files", async () => {
    const configDir = await makeStateDir();
    const stateDir = path.join(configDir, "missing-state");
    createdDirs.push(configDir);
    const configPath = await writeConfig(configDir, {
      plugins: {
        entries: {
          "openclaw-b2-backup": {
            config: {
              keyId: "key-id",
              applicationKey: "app-key",
              bucket: "bucket-name",
              region: "us-west-004",
            },
          },
        },
      },
    });
    const gatherFiles = vi.fn(async () => []);

    const result = await runCli(configArgs(configPath, stateDir, "--json"), { gatherFiles });

    expect(result.exitCode).toBe(EXIT_CODES.configMalformed);
    expect(parseJsonOutput<CliJsonFailure>(result.stdout)).toEqual({
      ok: false,
      code: "config_malformed",
      error: expect.stringContaining(`cannot read state directory ${stateDir}`),
    });
    expect(gatherFiles).not.toHaveBeenCalled();
  });

  it("returns config malformed when required config is missing", async () => {
    const stateDir = await makeStateDir();
    createdDirs.push(stateDir);
    const configPath = await writeConfig(stateDir, {});

    const result = await runCli(configArgs(configPath, stateDir, "--json"));

    expect(result.exitCode).toBe(EXIT_CODES.configMalformed);
    expect(parseJsonOutput<CliJsonFailure>(result.stdout)).toEqual({
      ok: false,
      code: "config_malformed",
      error: expect.stringContaining("missing required config"),
    });
  });

  it("returns config malformed when plugin config is not an object", async () => {
    const stateDir = await makeStateDir();
    createdDirs.push(stateDir);
    const configPath = await writeConfig(stateDir, {
      plugins: {
        entries: {
          "openclaw-b2-backup": {
            config: "bad",
          },
        },
      },
    });

    const result = await runCli(configArgs(configPath, stateDir, "--json"));

    expect(result.exitCode).toBe(EXIT_CODES.configMalformed);
    expect(parseJsonOutput<CliJsonFailure>(result.stdout)).toEqual({
      ok: false,
      code: "config_malformed",
      error: "plugins.entries.openclaw-b2-backup.config must be an object",
    });
  });

  it("returns config malformed for endpoint validation errors", async () => {
    const stateDir = await makeStateDir();
    createdDirs.push(stateDir);
    const configPath = await writeConfig(stateDir, {
      plugins: {
        entries: {
          "openclaw-b2-backup": {
            config: {
              keyId: "key-id",
              applicationKey: "app-key",
              bucket: "bucket-name",
              region: "us-west-004",
              endpoint: "https://example.com",
            },
          },
        },
      },
    });

    const result = await runCli(configArgs(configPath, stateDir, "--json"));

    expect(result.exitCode).toBe(EXIT_CODES.configMalformed);
    expect(parseJsonOutput<CliJsonFailure>(result.stdout)).toEqual({
      ok: false,
      code: "config_malformed",
      error: "b2: endpoint host must be s3.us-west-004.backblazeb2.com",
    });
  });

  it("returns push failure when push throws", async () => {
    const stateDir = await makeStateDir();
    createdDirs.push(stateDir);
    const configPath = await writeConfig(stateDir, {
      plugins: {
        entries: {
          "openclaw-b2-backup": {
            config: {
              keyId: "key-id",
              applicationKey: "app-key",
              bucket: "bucket-name",
              region: "us-west-004",
            },
          },
        },
      },
    });
    const b2 = createMockB2();
    const push = vi.fn(async () => {
      throw new Error("upload failed");
    });

    const result = await runCli(configArgs(configPath, stateDir, "--json"), {
      createB2Client: vi.fn(async () => b2),
      push,
    });

    expect(result.exitCode).toBe(EXIT_CODES.pushFailure);
    expect(parseJsonOutput<CliJsonFailure>(result.stdout)).toEqual({
      ok: false,
      code: "push_failure",
      error: "upload failed",
    });
  });

  it("prints concise quiet failure diagnostics to stderr", async () => {
    const stateDir = await makeStateDir();
    createdDirs.push(stateDir);
    const configPath = await writeConfig(stateDir, {
      plugins: {
        entries: {
          "openclaw-b2-backup": {
            config: {
              keyId: "key-id",
              applicationKey: "app-key",
              bucket: "bucket-name",
              region: "us-west-004",
            },
          },
        },
      },
    });
    const b2 = createMockB2();

    const result = await runCli(configArgs(configPath, stateDir, "--quiet"), {
      createB2Client: vi.fn(async () => b2),
      push: vi.fn(async () => {
        throw new Error("upload failed");
      }),
    });

    expect(result.exitCode).toBe(EXIT_CODES.pushFailure);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("b2-backup: upload failed\n");
  });

  it("streams progress logs to the injected stderr writer", async () => {
    const stateDir = await makeStateDir();
    createdDirs.push(stateDir);
    const configPath = await writeConfig(stateDir, {
      plugins: {
        entries: {
          "openclaw-b2-backup": {
            config: {
              keyId: "key-id",
              applicationKey: "app-key",
              bucket: "bucket-name",
              region: "us-west-004",
            },
          },
        },
      },
    });
    const b2 = createMockB2();
    const logWritten = deferred();
    const releasePush = deferred();
    const chunks: string[] = [];
    const run = runCli(configArgs(configPath, stateDir), {
      createB2Client: vi.fn(async () => b2),
      writeStderr: (chunk) => {
        chunks.push(chunk);
        logWritten.resolve();
      },
      push: vi.fn(async (_config, _stateDir, _b2, logger) => {
        logger.info("b2-backup: pushing 1 files");
        await releasePush.promise;
      }),
    });

    await logWritten.promise;
    expect(chunks).toEqual(["b2-backup: pushing 1 files\n"]);

    releasePush.resolve();
    const result = await run;
    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(result.stderr).toBe("");
  });
});
