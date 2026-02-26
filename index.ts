import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createB2Client } from "./src/b2-client.js";
import { createDebounceGate } from "./src/debounce.js";
import { pullSnapshot } from "./src/pull.js";
import { push } from "./src/push.js";
import { createB2BackupService } from "./src/service.js";
import { listSnapshots } from "./src/snapshots.js";
import type { B2BackupConfig } from "./src/types.js";

const plugin = {
  id: "b2-backup",
  name: "Backblaze B2 Backup",
  description: "Sync OpenClaw state to Backblaze B2",

  register(api: OpenClawPluginApi) {
    const config = api.pluginConfig as unknown as B2BackupConfig;
    if (!config?.keyId || !config?.applicationKey || !config?.bucket) {
      api.logger.warn("b2-backup: missing required config (keyId, applicationKey, bucket)");
      return;
    }

    const stateDir = api.runtime.state.resolveStateDir();
    const debounce = createDebounceGate();

    api.registerService(createB2BackupService(config));

    api.on("gateway_stop", async () => {
      try {
        const b2 = await createB2Client(config.keyId, config.applicationKey, config.region);
        await push(config, stateDir, b2, api.logger);
      } catch (err) {
        api.logger.warn(`b2-backup: gateway_stop push failed: ${String(err)}`);
      }
    });

    api.on("before_compaction", async () => {
      if (!debounce.tryAcquire()) {
        api.logger.debug?.(
          `b2-backup: before_compaction push skipped (${Math.ceil(debounce.remainingMs() / 1000)}s remaining)`,
        );
        return;
      }
      try {
        const b2 = await createB2Client(config.keyId, config.applicationKey, config.region);
        await push(config, stateDir, b2, api.logger);
      } catch (err) {
        api.logger.warn(`b2-backup: before_compaction push failed: ${String(err)}`);
      }
    });

    api.registerTool({
      name: "b2_rollback",
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
      async execute(params: { action: string; timestamp?: string }) {
        const b2 = await createB2Client(config.keyId, config.applicationKey, config.region);
        const prefix = config.prefix ?? "openclaw-backup";

        if (params.action === "list-snapshots") {
          const snapshots = await listSnapshots(b2, config.bucket, prefix);
          if (snapshots.length === 0) {
            return { result: "No snapshots found." };
          }
          return {
            result: `Found ${snapshots.length} snapshot(s):\n${snapshots.map((ts) => `  - ${ts}`).join("\n")}`,
            snapshots,
          };
        }

        if (params.action === "restore") {
          if (!params.timestamp) {
            return { error: "timestamp is required for restore action" };
          }
          await pullSnapshot(config, stateDir, b2, api.logger, params.timestamp);
          return { result: `Restored snapshot ${params.timestamp}` };
        }

        return { error: `Unknown action: ${params.action}` };
      },
    });
  },
};

export default plugin;
