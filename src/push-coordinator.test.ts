import { describe, expect, it, vi } from "vitest";
import { createPushCoordinator } from "./push-coordinator.js";

describe("push coordinator", () => {
  it("skips overlapping cron, shutdown, and compaction push triggers", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const coordinator = createPushCoordinator(logger, { deadlineMs: 5_000 });
    let release!: () => void;
    const running = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const skipped = vi.fn(async () => undefined);

    const cron = coordinator.run("cron", running);
    const shutdown = await coordinator.run("shutdown", skipped);
    const compaction = await coordinator.run("before_compaction", skipped);
    release();

    await expect(cron).resolves.toBe(true);
    expect(shutdown).toBe(false);
    expect(compaction).toBe(false);
    expect(running).toHaveBeenCalledTimes(1);
    expect(skipped).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "b2-backup: push skipped (shutdown); another push is already running",
    );
    expect(logger.info).toHaveBeenCalledWith(
      "b2-backup: push skipped (before_compaction); another push is already running",
    );
  });

  it("returns false and clears the lock when a push rejects", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };
    const coordinator = createPushCoordinator(logger, { deadlineMs: 5_000 });

    await expect(
      coordinator.run("cron", async () => {
        throw new Error("upload failed");
      }),
    ).resolves.toBe(false);
    await expect(coordinator.run("shutdown", async () => undefined)).resolves.toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      "b2-backup: push failed (cron): Error: upload failed",
    );
  });
});
