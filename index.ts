import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createB2Client } from "./src/b2-client.js";
import { createDebounceGate } from "./src/debounce.js";
import { pullSnapshot } from "./src/pull.js";
import { push } from "./src/push.js";
import { createPushCoordinator, DEFAULT_PUSH_DEADLINE_MS } from "./src/push-coordinator.js";
import { createB2BackupService } from "./src/service.js";
import { listSnapshots } from "./src/snapshots.js";
import type { B2BackupConfig, ResolvedB2BackupConfig } from "./src/types.js";

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readConfigString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveB2BackupConfig(config: Partial<B2BackupConfig> | undefined): ResolvedB2BackupConfig | null {
  const keyId = readConfigString(config?.keyId) ?? readEnv("B2_APPLICATION_KEY_ID");
  const applicationKey = readConfigString(config?.applicationKey) ?? readEnv("B2_APPLICATION_KEY");
  const bucket = readConfigString(config?.bucket) ?? readEnv("B2_BUCKET_NAME");
  const region = readConfigString(config?.region) ?? readEnv("B2_REGION");
  const endpoint = readConfigString(config?.endpoint) ?? readEnv("B2_ENDPOINT");
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
  return resolved;
}

function toolText(text: string, details?: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

const plugin = {
  id: "openclaw-b2-backup",
  name: "Backblaze B2 Backup",
  description: "Sync OpenClaw state to Backblaze B2",

  register(api: OpenClawPluginApi) {
    const config = resolveB2BackupConfig(api.pluginConfig as Partial<B2BackupConfig> | undefined);
    if (!config) {
      api.logger.warn(
        "b2-backup: missing required config (keyId, applicationKey, bucket, region). " +
          "Set region in plugin config or B2_REGION in the environment; use B2_APPLICATION_KEY_ID for env config. " +
          "Native B2 region discovery is not used.",
      );
      return;
    }

    const stateDir = api.runtime.state.resolveStateDir();
    const debounce = createDebounceGate();
    const pushCoordinator = createPushCoordinator(api.logger);

    api.registerService(createB2BackupService(config, pushCoordinator));

    api.on("gateway_stop", async () => {
      await pushCoordinator.run(
        "gateway_stop",
        async (signal) => {
          try {
            const b2 = await createB2Client(config.keyId, config.applicationKey, config.region, {
              endpoint: config.endpoint,
              logger: api.logger,
              signal,
            });
            await push(config, stateDir, b2, api.logger);
          } catch (err) {
            api.logger.warn(`b2-backup: gateway_stop push failed: ${String(err)}`);
          }
        },
        { deadlineMs: DEFAULT_PUSH_DEADLINE_MS },
      );
    });

    api.on("before_compaction", async () => {
      if (!debounce.tryAcquire()) {
        api.logger.debug?.(
          `b2-backup: before_compaction push skipped (${Math.ceil(debounce.remainingMs() / 1000)}s remaining)`,
        );
        return;
      }
      await pushCoordinator.run("before_compaction", async (signal) => {
        try {
          const b2 = await createB2Client(config.keyId, config.applicationKey, config.region, {
            endpoint: config.endpoint,
            logger: api.logger,
            signal,
          });
          await push(config, stateDir, b2, api.logger);
        } catch (err) {
          api.logger.warn(`b2-backup: before_compaction push failed: ${String(err)}`);
        }
      });
    });

    const rollbackTool = {
      name: "b2_rollback",
      label: "B2 Rollback",
      description: "List and restore B2 backup snapshots",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list-snapshots", "restore"],
            description: "Action to perform",
          },
          timestamp: {
            type: "string",
            description: "Snapshot timestamp to restore (required for restore action)",
          },
        },
        required: ["action"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
        const action = typeof params.action === "string" ? params.action : "";
        const timestamp = typeof params.timestamp === "string" ? params.timestamp : undefined;
        const b2 = await createB2Client(config.keyId, config.applicationKey, config.region, {
          endpoint: config.endpoint,
          logger: api.logger,
          signal,
        });
        const prefix = config.prefix ?? "openclaw-backup";

        if (action === "list-snapshots") {
          const snapshots = await listSnapshots(b2, config.bucket, prefix);
          if (snapshots.length === 0) {
            return toolText("No snapshots found.", { snapshots });
          }
          return toolText(
            `Found ${snapshots.length} snapshot(s):\n${snapshots.map((ts) => `  - ${ts}`).join("\n")}`,
            { snapshots },
          );
        }

        if (action === "restore") {
          if (!timestamp) {
            return toolText("timestamp is required for restore action", { error: "timestamp is required" });
          }
          await pullSnapshot(config, stateDir, b2, api.logger, timestamp);
          return toolText(`Restored snapshot ${timestamp}`, { timestamp });
        }

        return toolText(`Unknown action: ${action}`, { error: "unknown action" });
      },
    } satisfies AnyAgentTool;

    api.registerTool(rollbackTool);
  },
};

export default plugin;
