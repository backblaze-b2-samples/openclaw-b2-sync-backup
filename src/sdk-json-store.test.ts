import { afterEach, describe, expect, it, vi } from "vitest";

describe("sdk-json-store", () => {
  afterEach(() => {
    vi.doUnmock("openclaw/plugin-sdk/json-store");
    vi.doUnmock("openclaw/plugin-sdk");
    vi.resetModules();
  });

  it("loads JSON-store helpers from the OpenClaw 2026.4+ submodule", async () => {
    const readJson = vi.fn(async () => ({ value: "new-layout" }));
    const writeJson = vi.fn(async () => undefined);

    vi.doMock("openclaw/plugin-sdk/json-store", () => ({
      readJsonFileWithFallback: readJson,
      writeJsonFileAtomically: writeJson,
    }));
    vi.doMock("openclaw/plugin-sdk", () => {
      throw new Error("legacy module should not load");
    });
    const { readJsonFileWithFallback, writeJsonFileAtomically } = await import(
      "./sdk-json-store.js"
    );

    await expect(readJsonFileWithFallback("manifest.json", null)).resolves.toEqual({
      value: "new-layout",
    });
    await writeJsonFileAtomically("manifest.json", { ok: true });

    expect(readJson).toHaveBeenCalledWith("manifest.json", null);
    expect(writeJson).toHaveBeenCalledWith("manifest.json", { ok: true });
  });

  it("falls back to legacy top-level helpers for older OpenClaw hosts", async () => {
    const readJson = vi.fn(async () => ({ value: "legacy-layout" }));
    const writeJson = vi.fn(async () => undefined);

    vi.doMock("openclaw/plugin-sdk/json-store", () => {
      throw new Error("Cannot find module");
    });
    vi.doMock("openclaw/plugin-sdk", () => ({
      readJsonFileWithFallback: readJson,
      writeJsonFileAtomically: writeJson,
    }));
    const { readJsonFileWithFallback, writeJsonFileAtomically } = await import(
      "./sdk-json-store.js"
    );

    await expect(readJsonFileWithFallback("manifest.json", null)).resolves.toEqual({
      value: "legacy-layout",
    });
    await writeJsonFileAtomically("manifest.json", { ok: true });

    expect(readJson).toHaveBeenCalledWith("manifest.json", null);
    expect(writeJson).toHaveBeenCalledWith("manifest.json", { ok: true });
  });

  it("reports a clear diagnostic when neither SDK layout exports helpers", async () => {
    vi.doMock("openclaw/plugin-sdk/json-store", () => ({}));
    vi.doMock("openclaw/plugin-sdk", () => {
      throw new Error("Cannot find module");
    });
    const { readJsonFileWithFallback } = await import("./sdk-json-store.js");

    await expect(readJsonFileWithFallback("manifest.json", null)).rejects.toThrow(
      "b2-backup: OpenClaw plugin SDK JSON-store helpers are unavailable.",
    );
  });
});
