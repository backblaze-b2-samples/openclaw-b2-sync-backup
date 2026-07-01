import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXIT_CODES, parseArgs, runCli } from "./cli.js";
import type { B2Client } from "./b2-client.js";

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
      "--dry-run",
      "--json",
      "--quiet",
    ]);

    expect(parsed).toEqual({
      ok: true,
      options: {
        configPath: "/tmp/openclaw.json",
        dryRun: true,
        help: false,
        json: true,
        quiet: true,
      },
    });
  });

  it("returns usage error for unknown options", async () => {
    const result = await runCli(["--nope", "--json"]);

    expect(result.exitCode).toBe(EXIT_CODES.usage);
    expect(result.stderr).toContain("unknown option");
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

    const result = await runCli(["--config", configPath, "--quiet"], {
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

    const result = await runCli(["--config", configPath, "--dry-run", "--json"], {
      createB2Client: createB2,
      push,
    });

    expect(result.exitCode).toBe(EXIT_CODES.success);
    expect(JSON.parse(result.stdout)).toEqual({
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

  it("returns config malformed when required config is missing", async () => {
    const stateDir = await makeStateDir();
    createdDirs.push(stateDir);
    const configPath = await writeConfig(stateDir, {});

    const result = await runCli(["--config", configPath, "--json"]);

    expect(result.exitCode).toBe(EXIT_CODES.configMalformed);
    expect(JSON.parse(result.stdout)).toEqual({
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

    const result = await runCli(["--config", configPath, "--json"]);

    expect(result.exitCode).toBe(EXIT_CODES.configMalformed);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      code: "config_malformed",
      error: "plugins.entries.openclaw-b2-backup.config must be an object",
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

    const result = await runCli(["--config", configPath, "--json"], {
      createB2Client: vi.fn(async () => b2),
      push,
    });

    expect(result.exitCode).toBe(EXIT_CODES.pushFailure);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: false,
      code: "push_failure",
      error: "upload failed",
    });
  });
});
