import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gatherFiles, shouldInclude } from "./gatherer.js";

describe("gatherer", () => {
  describe("shouldInclude", () => {
    it("includes openclaw.json", () => {
      expect(shouldInclude("openclaw.json")).toBe(true);
    });

    it("includes openclaw.json.bak files", () => {
      expect(shouldInclude("openclaw.json.bak")).toBe(true);
      expect(shouldInclude("openclaw.json.bak.2026-01-01")).toBe(true);
    });

    it("includes session files", () => {
      expect(shouldInclude("agents/default/sessions/abc.jsonl")).toBe(true);
      expect(shouldInclude("agents/default/sessions/sessions.json")).toBe(true);
    });

    it("includes memory sqlite files", () => {
      expect(shouldInclude("agents/default/memory/index.sqlite")).toBe(true);
    });

    it("includes workspace files", () => {
      expect(shouldInclude("workspace/SOUL.md")).toBe(true);
      expect(shouldInclude("workspace/nested/file.txt")).toBe(true);
    });

    it("includes multi-agent workspace directories", () => {
      expect(shouldInclude("workspace-research/SOUL.md")).toBe(true);
      expect(shouldInclude("workspace-coding/MEMORY.md")).toBe(true);
      expect(shouldInclude("workspace-default/AGENTS.md")).toBe(true);
    });

    it("includes cron files", () => {
      expect(shouldInclude("cron/daily.json")).toBe(true);
    });

    it("includes hooks files", () => {
      expect(shouldInclude("hooks/on-start.sh")).toBe(true);
    });

    it("includes agent runtime state", () => {
      expect(shouldInclude("agents/default/agent/config.json")).toBe(true);
      expect(shouldInclude("agents/default/agent/state.json")).toBe(true);
    });

    it("excludes auth profiles but includes other agent files", () => {
      expect(shouldInclude("agents/default/agent/auth-profiles.json")).toBe(false);
      expect(shouldInclude("agents/default/agent/search-config.json")).toBe(true);
    });

    it("excludes credentials", () => {
      expect(shouldInclude("credentials/token.json")).toBe(false);
    });

    it("excludes media", () => {
      expect(shouldInclude("media/image.png")).toBe(false);
    });

    it("excludes extensions", () => {
      expect(shouldInclude("extensions/some-plugin/index.ts")).toBe(false);
    });

    it("excludes lock files", () => {
      expect(shouldInclude("workspace/file.lock")).toBe(false);
    });

    it("excludes tmp files", () => {
      expect(shouldInclude("workspace/file.tmp")).toBe(false);
    });

    it("excludes WAL/SHM files", () => {
      expect(shouldInclude("agents/default/memory/index.sqlite-wal")).toBe(false);
      expect(shouldInclude("agents/default/memory/index.sqlite-shm")).toBe(false);
    });

    it("excludes .DS_Store", () => {
      expect(shouldInclude(".DS_Store")).toBe(false);
      expect(shouldInclude("workspace/.DS_Store")).toBe(false);
    });

    it("excludes unrecognized files", () => {
      expect(shouldInclude("random-file.txt")).toBe(false);
    });
  });

  describe("gatherFiles", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "b2-gatherer-test-"));
    });

    afterEach(async () => {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    });

    it("collects matching files from state dir", async () => {
      // Create test structure
      await fs.promises.writeFile(path.join(tmpDir, "openclaw.json"), "{}");
      await fs.promises.mkdir(path.join(tmpDir, "workspace"), { recursive: true });
      await fs.promises.writeFile(path.join(tmpDir, "workspace", "SOUL.md"), "# Soul");
      await fs.promises.mkdir(path.join(tmpDir, "credentials"), { recursive: true });
      await fs.promises.writeFile(path.join(tmpDir, "credentials", "secret.json"), "{}");

      const files = await gatherFiles(tmpDir);
      const paths = files.map((f) => f.relativePath);

      expect(paths).toContain("openclaw.json");
      expect(paths).toContain("workspace/SOUL.md");
      expect(paths).not.toContain("credentials/secret.json");
    });

    it("returns empty array for empty dir", async () => {
      const files = await gatherFiles(tmpDir);
      expect(files).toEqual([]);
    });

    it("returns files sorted by relative path", async () => {
      await fs.promises.mkdir(path.join(tmpDir, "workspace"), { recursive: true });
      await fs.promises.writeFile(path.join(tmpDir, "workspace", "b.md"), "b");
      await fs.promises.writeFile(path.join(tmpDir, "workspace", "a.md"), "a");
      await fs.promises.writeFile(path.join(tmpDir, "openclaw.json"), "{}");

      const files = await gatherFiles(tmpDir);
      const paths = files.map((f) => f.relativePath);

      expect(paths).toEqual(["openclaw.json", "workspace/a.md", "workspace/b.md"]);
    });
  });
});
