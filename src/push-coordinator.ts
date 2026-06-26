export const DEFAULT_PUSH_DEADLINE_MS = 120_000;

type PushLogger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  debug?: (msg: string) => void;
};

export type PushCoordinatorRunOptions = {
  deadlineMs?: number;
};

export type PushCoordinator = {
  run(
    reason: string,
    job: (signal: AbortSignal) => Promise<void>,
    options?: PushCoordinatorRunOptions,
  ): Promise<boolean>;
};

export function createPushCoordinator(
  logger: PushLogger,
  options: PushCoordinatorRunOptions = {},
): PushCoordinator {
  let active: Promise<boolean> | null = null;

  return {
    async run(reason, job, runOptions) {
      if (active) {
        logger.info(`b2-backup: push skipped (${reason}); another push is already running`);
        return false;
      }

      const deadlineMs =
        runOptions?.deadlineMs ?? options.deadlineMs ?? DEFAULT_PUSH_DEADLINE_MS;
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error(`b2-backup: push deadline exceeded (${deadlineMs}ms)`)),
        deadlineMs,
      );
      timeout.unref?.();

      active = (async () => {
        try {
          logger.debug?.(`b2-backup: push starting (${reason}, deadline ${deadlineMs}ms)`);
          await job(controller.signal);
          logger.debug?.(`b2-backup: push finished (${reason})`);
          return true;
        } finally {
          clearTimeout(timeout);
          active = null;
        }
      })();

      return active;
    },
  };
}
