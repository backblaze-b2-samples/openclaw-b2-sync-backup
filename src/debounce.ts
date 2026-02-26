const DEFAULT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

export type DebounceGate = {
  /** Returns true if the action is allowed (not within cooldown window). */
  tryAcquire(): boolean;
  /** Reset the gate (e.g., for testing or shutdown). */
  reset(): void;
  /** Returns milliseconds remaining in cooldown, or 0 if ready. */
  remainingMs(): number;
};

export function createDebounceGate(windowMs: number = DEFAULT_WINDOW_MS): DebounceGate {
  let lastFired = 0;

  return {
    tryAcquire(): boolean {
      const now = Date.now();
      if (now - lastFired < windowMs) {
        return false;
      }
      lastFired = now;
      return true;
    },

    reset(): void {
      lastFired = 0;
    },

    remainingMs(): number {
      const elapsed = Date.now() - lastFired;
      return Math.max(0, windowMs - elapsed);
    },
  };
}
