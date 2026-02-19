import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createB2Client } from "./src/b2-client.js";
import { push } from "./src/push.js";
import { createB2BackupService } from "./src/service.js";
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

    api.registerService(createB2BackupService(config));

    api.on("gateway_stop", async () => {
      try {
        const b2 = await createB2Client(config.keyId, config.applicationKey, config.region);
        await push(config, stateDir, b2, api.logger);
      } catch (err) {
        api.logger.warn(`b2-backup: gateway_stop push failed: ${String(err)}`);
      }
    });
  },
};

export default plugin;
