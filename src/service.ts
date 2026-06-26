import fs from "node:fs";
import { Cron } from "croner";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "openclaw/plugin-sdk";
import { createB2Client } from "./b2-client.js";
import { gatherFiles } from "./gatherer.js";
import { pullLatest } from "./pull.js";
import { push } from "./push.js";
import { createPushCoordinator, DEFAULT_PUSH_DEADLINE_MS, type PushCoordinator } from "./push-coordinator.js";
import { getLatestSnapshot } from "./snapshots.js";
import type { ResolvedB2BackupConfig } from "./types.js";

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

export function createB2BackupService(
  config: ResolvedB2BackupConfig,
  pushCoordinator?: PushCoordinator,
): OpenClawPluginService {
  let cron: Cron | null = null;
  let coordinator = pushCoordinator;

  return {
    id: "b2-backup",

    async start(ctx: OpenClawPluginServiceContext) {
      coordinator ??= createPushCoordinator(ctx.logger);
      const b2 = await createB2Client(config.keyId, config.applicationKey, config.region, {
        endpoint: config.endpoint,
        logger: ctx.logger,
      });

      // Verify bucket access
      try {
        await b2.headBucket(config.bucket);
      } catch (err) {
        ctx.logger.error(`b2-backup: cannot access bucket "${config.bucket}": ${String(err)}`);
        return;
      }

      // Auto-restore: if state dir is empty and B2 has snapshots, pull latest
      try {
        const files = await gatherFiles(ctx.stateDir);
        if (files.length === 0) {
          const prefix = config.prefix ?? "openclaw-backup";
          const latest = await getLatestSnapshot(b2, config.bucket, prefix);
          if (latest) {
            ctx.logger.info("b2-backup: empty state dir detected, auto-restoring from B2");
            await pullLatest(config, ctx.stateDir, b2, ctx.logger, { skipSafety: true });
          }
        }
      } catch (err) {
        ctx.logger.warn(`b2-backup: auto-restore check failed: ${String(err)}`);
      }

      ctx.logger.info(`b2-backup: service started (schedule: ${config.schedule ?? "daily"})`);

      const cronExpr = resolveSchedule(config.schedule);
      cron = new Cron(cronExpr, async () => {
        await coordinator!.run("cron", async (signal) => {
          const cronB2 = await createB2Client(config.keyId, config.applicationKey, config.region, {
            endpoint: config.endpoint,
            logger: ctx.logger,
            signal,
          });
          await push(config, ctx.stateDir, cronB2, ctx.logger);
        });
      });
    },

    async stop(ctx: OpenClawPluginServiceContext) {
      cron?.stop();
      cron = null;

      // Final backup on shutdown
      coordinator ??= createPushCoordinator(ctx.logger);
      await coordinator.run(
        "shutdown",
        async (signal) => {
          const b2 = await createB2Client(config.keyId, config.applicationKey, config.region, {
            endpoint: config.endpoint,
            logger: ctx.logger,
            signal,
          });
          await push(config, ctx.stateDir, b2, ctx.logger);
        },
        { deadlineMs: DEFAULT_PUSH_DEADLINE_MS },
      );
    },
  };
}
