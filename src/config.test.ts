import { describe, expect, it } from "vitest";
import {
  B2BackupConfigError,
  extractB2BackupPluginConfig,
  parseOpenClawConfig,
  resolveB2BackupConfigFromOpenClawConfig,
  resolveOpenClawConfigPaths,
} from "./config.js";

describe("OpenClaw B2 config extraction", () => {
  it("extracts modern plugins.entries config", () => {
    expect(
      extractB2BackupPluginConfig({
        plugins: {
          entries: {
            "openclaw-b2-backup": {
              enabled: true,
              config: {
                keyId: "key-id",
                applicationKey: "app-key",
                bucket: "bucket-name",
                region: "us-west-004",
              },
            },
          },
        },
      }),
    ).toEqual({
      keyId: "key-id",
      applicationKey: "app-key",
      bucket: "bucket-name",
      region: "us-west-004",
    });
  });

  it("extracts legacy top-level plugin config", () => {
    expect(
      extractB2BackupPluginConfig({
        "openclaw-b2-backup": {
          enabled: true,
          config: {
            keyId: "legacy-key",
            applicationKey: "legacy-secret",
            bucket: "legacy-bucket",
            region: "us-west-004",
          },
        },
      }),
    ).toEqual({
      keyId: "legacy-key",
      applicationKey: "legacy-secret",
      bucket: "legacy-bucket",
      region: "us-west-004",
    });
  });

  it("uses B2 env vars when no plugin config is present", () => {
    expect(
      resolveB2BackupConfigFromOpenClawConfig(
        {},
        {
          B2_APPLICATION_KEY_ID: "env-key",
          B2_APPLICATION_KEY: "env-secret",
          B2_BUCKET_NAME: "env-bucket",
          B2_REGION: "env-region",
        },
      ),
    ).toEqual({
      keyId: "env-key",
      applicationKey: "env-secret",
      bucket: "env-bucket",
      region: "env-region",
    });
  });

  it("throws typed errors for malformed plugin config", () => {
    expect(() =>
      extractB2BackupPluginConfig({
        plugins: {
          entries: {
            "openclaw-b2-backup": {
              config: "bad",
            },
          },
        },
      }),
    ).toThrow(B2BackupConfigError);
  });

  it("parses JSON5 OpenClaw config files", () => {
    expect(
      parseOpenClawConfig(`{
        // OpenClaw configs allow comments and trailing commas.
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
      }`),
    ).toEqual({
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
  });

  it("requires explicit state dir for external config paths", () => {
    expect(() =>
      resolveOpenClawConfigPaths({
        configPath: "/etc/openclaw/openclaw.json",
        env: { HOME: "/home/me" },
      }),
    ).toThrow(B2BackupConfigError);
  });

  it("resolves explicit state directory aliases for external config paths", () => {
    expect(
      resolveOpenClawConfigPaths({
        configPath: "/etc/openclaw/openclaw.json",
        env: { HOME: "/home/me", CLAWDBOT_STATE_DIR: "/var/lib/openclaw" },
      }),
    ).toEqual({
      configPath: "/etc/openclaw/openclaw.json",
      stateDir: "/var/lib/openclaw",
    });
  });
});
