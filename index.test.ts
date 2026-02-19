import { describe, expect, it, vi } from "vitest";
import register from "./index.js";

describe("b2-backup plugin", () => {
  it("registers service and gateway_stop hook when config is provided", () => {
    const api = {
      pluginConfig: {
        keyId: "test-key",
        applicationKey: "test-secret",
        bucket: "test-bucket",
      },
      config: {},
      runtime: { state: { resolveStateDir: () => "/tmp/openclaw-test" } },
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      registerService: vi.fn(),
      on: vi.fn(),
    };

    register.register(api as any);

    expect(api.registerService).toHaveBeenCalledTimes(1);
    expect(api.registerService).toHaveBeenCalledWith(
      expect.objectContaining({ id: "b2-backup" }),
    );
    expect(api.on).toHaveBeenCalledTimes(1);
    expect(api.on).toHaveBeenCalledWith("gateway_stop", expect.any(Function));
  });

  it("warns and skips when config is missing", () => {
    const api = {
      pluginConfig: {},
      config: {},
      runtime: { state: { resolveStateDir: () => "/tmp/openclaw-test" } },
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      registerService: vi.fn(),
      on: vi.fn(),
    };

    register.register(api as any);

    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("missing required config"),
    );
    expect(api.registerService).not.toHaveBeenCalled();
    expect(api.on).not.toHaveBeenCalled();
  });

  it("exports correct plugin metadata", () => {
    expect(register.id).toBe("b2-backup");
    expect(register.name).toBe("Backblaze B2 Backup");
  });
});
