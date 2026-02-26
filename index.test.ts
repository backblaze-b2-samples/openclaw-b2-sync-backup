import { describe, expect, it, vi } from "vitest";
import register from "./index.js";

function createMockApi(config: Record<string, unknown> = {}) {
  return {
    pluginConfig: config,
    config: {},
    runtime: { state: { resolveStateDir: () => "/tmp/openclaw-test" } },
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    registerService: vi.fn(),
    registerTool: vi.fn(),
    on: vi.fn(),
  };
}

describe("b2-backup plugin", () => {
  it("registers service and gateway_stop hook when config is provided", () => {
    const api = createMockApi({
      keyId: "test-key",
      applicationKey: "test-secret",
      bucket: "test-bucket",
    });

    register.register(api as any);

    expect(api.registerService).toHaveBeenCalledTimes(1);
    expect(api.registerService).toHaveBeenCalledWith(
      expect.objectContaining({ id: "b2-backup" }),
    );
    expect(api.on).toHaveBeenCalledWith("gateway_stop", expect.any(Function));
  });

  it("warns and skips when config is missing", () => {
    const api = createMockApi();

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

  it("registers before_compaction hook", () => {
    const api = createMockApi({
      keyId: "test-key",
      applicationKey: "test-secret",
      bucket: "test-bucket",
    });

    register.register(api as any);

    expect(api.on).toHaveBeenCalledWith("before_compaction", expect.any(Function));
  });

  it("registers b2_rollback agent tool", () => {
    const api = createMockApi({
      keyId: "test-key",
      applicationKey: "test-secret",
      bucket: "test-bucket",
    });

    register.register(api as any);

    expect(api.registerTool).toHaveBeenCalledTimes(1);
    expect(api.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "b2_rollback",
        execute: expect.any(Function),
      }),
    );
  });

  it("registers both gateway_stop and before_compaction hooks", () => {
    const api = createMockApi({
      keyId: "test-key",
      applicationKey: "test-secret",
      bucket: "test-bucket",
    });

    register.register(api as any);

    expect(api.on).toHaveBeenCalledTimes(2);
    const hookNames = api.on.mock.calls.map((c: unknown[]) => c[0]);
    expect(hookNames).toContain("gateway_stop");
    expect(hookNames).toContain("before_compaction");
  });

  it("does not register tool when config is missing", () => {
    const api = createMockApi();

    register.register(api as any);

    expect(api.registerTool).not.toHaveBeenCalled();
  });
});
