import { Cron } from "croner";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import { createB2Client } from "./b2-client.js";
import { push } from "./push.js";
import type { B2BackupConfig } from "./types.js";

function resolveSchedule(schedule: string | undefined): string {
  switch (schedule) {
    case "daily":
    case undefined:
      return "0 0 * * *"; // midnight
    case "weekly":
      return "0 0 * * 0"; // Sunday midnight
    default:
      return schedule; // treat as cron expression
  }
}

export function createB2BackupService(config: B2BackupConfig): OpenClawPluginService {
  let cron: Cron | null = null;

  return {
    id: "b2-backup",

    async start(ctx: OpenClawPluginServiceContext) {
      const b2 = await createB2Client(config.keyId, config.applicationKey, config.region);

      // Verify bucket access
      try {
        await b2.headBucket(config.bucket);
      } catch (err) {
        ctx.logger.error(`b2-backup: cannot access bucket "${config.bucket}": ${String(err)}`);
        return;
      }

      ctx.logger.info(`b2-backup: service started (schedule: ${config.schedule ?? "daily"})`);

      const cronExpr = resolveSchedule(config.schedule);
      cron = new Cron(cronExpr, async () => {
        try {
          await push(config, ctx.stateDir, b2, ctx.logger);
        } catch (err) {
          ctx.logger.error(`b2-backup: scheduled push failed: ${String(err)}`);
        }
      });
    },

    async stop(ctx: OpenClawPluginServiceContext) {
      cron?.stop();
      cron = null;

      // Final backup on shutdown
      try {
        const b2 = await createB2Client(config.keyId, config.applicationKey, config.region);
        await push(config, ctx.stateDir, b2, ctx.logger);
      } catch (err) {
        ctx.logger.warn(`b2-backup: shutdown push failed: ${String(err)}`);
      }
    },
  };
}
