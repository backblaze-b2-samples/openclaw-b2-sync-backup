import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createB2Client } from "./src/b2-client.js";
import { resolveB2BackupConfig } from "./src/config.js";
import { createDebounceGate } from "./src/debounce.js";
import { pullSnapshot } from "./src/pull.js";
import { push } from "./src/push.js";
import { createPushCoordinator, DEFAULT_PUSH_DEADLINE_MS } from "./src/push-coordinator.js";
import { createB2BackupService } from "./src/service.js";
import { listRegularSnapshots, listSafetySnapshots } from "./src/snapshots.js";
import type { B2BackupConfig } from "./src/types.js";

export * from "./src/index.js";
export { resolveB2BackupConfig } from "./src/config.js";

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
          const b2 = await createB2Client(config.keyId, config.applicationKey, config.region, {
            endpoint: config.endpoint,
            logger: api.logger,
            signal,
          });
          await push(config, stateDir, b2, api.logger);
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
        const b2 = await createB2Client(config.keyId, config.applicationKey, config.region, {
          endpoint: config.endpoint,
          logger: api.logger,
          signal,
        });
        await push(config, stateDir, b2, api.logger);
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
          snapshotId: {
            type: "string",
            description: "Snapshot ID to restore (required for restore action)",
          },
          timestamp: {
            type: "string",
            description: "Deprecated alias for snapshotId",
          },
        },
        required: ["action"],
      },
      async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
        const action = typeof params.action === "string" ? params.action : "";
        const snapshotId =
          typeof params.snapshotId === "string"
            ? params.snapshotId
            : typeof params.timestamp === "string"
              ? params.timestamp
              : undefined;
        const b2 = await createB2Client(config.keyId, config.applicationKey, config.region, {
          endpoint: config.endpoint,
          logger: api.logger,
          signal,
        });
        const prefix = config.prefix ?? "openclaw-backup";

        if (action === "list-snapshots") {
          const snapshots = await listRegularSnapshots(b2, config.bucket, prefix);
          const safetySnapshots = await listSafetySnapshots(b2, config.bucket, prefix);
          if (snapshots.length === 0 && safetySnapshots.length === 0) {
            return toolText("No snapshots found.", { snapshots, safetySnapshots });
          }

          const sections: string[] = [];
          if (snapshots.length > 0) {
            sections.push(`Regular snapshots:\n${snapshots.map((ts) => `  - ${ts}`).join("\n")}`);
          }
          if (safetySnapshots.length > 0) {
            sections.push(
              `Safety snapshots:\n${safetySnapshots.map((ts) => `  - ${ts}`).join("\n")}`,
            );
          }

          return toolText(
            `Found ${snapshots.length + safetySnapshots.length} snapshot(s):\n${sections.join("\n")}`,
            { snapshots, safetySnapshots },
          );
        }

        if (action === "restore") {
          if (!snapshotId) {
            return toolText("snapshot ID is required for restore action", {
              error: "snapshot ID is required",
            });
          }
          await pullSnapshot(config, stateDir, b2, api.logger, snapshotId);
          return toolText(`Restored snapshot ${snapshotId}`, { snapshotId });
        }

        return toolText(`Unknown action: ${action}`, { error: "unknown action" });
      },
    } satisfies AnyAgentTool;

    api.registerTool(rollbackTool);
  },
};

export default plugin;
