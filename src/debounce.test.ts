import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDebounceGate } from "./debounce.js";

describe("debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows first call immediately", () => {
    const gate = createDebounceGate(5000);
    expect(gate.tryAcquire()).toBe(true);
  });

  it("blocks second call within window", () => {
    const gate = createDebounceGate(5000);
    gate.tryAcquire();
    expect(gate.tryAcquire()).toBe(false);
  });

  it("allows call after window expires", () => {
    const gate = createDebounceGate(5000);
    gate.tryAcquire();
    vi.advanceTimersByTime(5001);
    expect(gate.tryAcquire()).toBe(true);
  });

  it("reports remaining time correctly", () => {
    const gate = createDebounceGate(10000);
    gate.tryAcquire();
    vi.advanceTimersByTime(3000);
    expect(gate.remainingMs()).toBe(7000);
  });

  it("reports zero remaining when ready", () => {
    const gate = createDebounceGate(5000);
    expect(gate.remainingMs()).toBe(0);
  });

  it("reset clears the cooldown", () => {
    const gate = createDebounceGate(5000);
    gate.tryAcquire();
    expect(gate.tryAcquire()).toBe(false);
    gate.reset();
    expect(gate.tryAcquire()).toBe(true);
  });
});
