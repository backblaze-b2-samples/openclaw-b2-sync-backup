import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetModuleImporterForTests,
  _setModuleImporterForTests,
  readJsonFileWithFallback,
  writeJsonFileAtomically,
} from "./sdk-json-store.js";

describe("sdk-json-store", () => {
  afterEach(() => {
    _resetModuleImporterForTests();
  });

  it("loads JSON-store helpers from the OpenClaw 2026.4+ submodule", async () => {
    const readJson = vi.fn(async () => ({ value: "new-layout" }));
    const writeJson = vi.fn(async () => undefined);
    const calls: string[] = [];

    _setModuleImporterForTests(async (specifier) => {
      calls.push(specifier);
      return {
        readJsonFileWithFallback: readJson,
        writeJsonFileAtomically: writeJson,
      };
    });

    await expect(readJsonFileWithFallback("manifest.json", null)).resolves.toEqual({
      value: "new-layout",
    });
    await writeJsonFileAtomically("manifest.json", { ok: true });

    expect(calls).toEqual(["openclaw/plugin-sdk/json-store"]);
    expect(readJson).toHaveBeenCalledWith("manifest.json", null);
    expect(writeJson).toHaveBeenCalledWith("manifest.json", { ok: true });
  });

  it("falls back to legacy top-level helpers for older OpenClaw hosts", async () => {
    const readJson = vi.fn(async () => ({ value: "legacy-layout" }));
    const writeJson = vi.fn(async () => undefined);
    const calls: string[] = [];

    _setModuleImporterForTests(async (specifier) => {
      calls.push(specifier);
      if (specifier === "openclaw/plugin-sdk/json-store") {
        throw new Error("Cannot find module");
      }
      return {
        readJsonFileWithFallback: readJson,
        writeJsonFileAtomically: writeJson,
      };
    });

    await expect(readJsonFileWithFallback("manifest.json", null)).resolves.toEqual({
      value: "legacy-layout",
    });
    await writeJsonFileAtomically("manifest.json", { ok: true });

    expect(calls).toEqual(["openclaw/plugin-sdk/json-store", "openclaw/plugin-sdk"]);
    expect(readJson).toHaveBeenCalledWith("manifest.json", null);
    expect(writeJson).toHaveBeenCalledWith("manifest.json", { ok: true });
  });

  it("reports a clear diagnostic when neither SDK layout exports helpers", async () => {
    _setModuleImporterForTests(async (specifier) => {
      if (specifier === "openclaw/plugin-sdk/json-store") return {};
      throw new Error("Cannot find module");
    });

    await expect(readJsonFileWithFallback("manifest.json", null)).rejects.toThrow(
      "b2-backup: OpenClaw plugin SDK JSON-store helpers are unavailable.",
    );
  });
});
