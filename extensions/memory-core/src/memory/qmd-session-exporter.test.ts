import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  buildQmdSqliteSessionParts: vi.fn(),
  buildSessionEntry: vi.fn(),
  corpusEntries: vi.fn(),
  replaceArtifactMappings: vi.fn(),
  statSessionEntrySync: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-qmd", () => ({
  buildQmdSqliteSessionParts: mocks.buildQmdSqliteSessionParts,
  buildSessionEntry: mocks.buildSessionEntry,
  isSessionArchiveArtifactName: () => false,
  listSessionTranscriptCorpusEntriesForAgent: mocks.corpusEntries,
  QmdSessionTranscriptGenerationChangedError: class QmdSessionTranscriptGenerationChangedError extends Error {},
  resolveSessionIdentityForTranscriptFile: () => null,
  statSessionEntrySync: mocks.statSessionEntrySync,
}));

vi.mock("../qmd-session-artifacts.js", () => ({
  refreshQmdSessionArtifactDocIds: vi.fn(),
  replaceQmdSessionArtifactMappings: mocks.replaceArtifactMappings,
}));

import { QmdSessionExporter } from "./qmd-session-exporter.js";

const createLease = () => ({
  assertOwned: vi.fn(),
  signal: new AbortController().signal,
});

function smallSqliteState(sessionFile: string, size = 100) {
  return {
    absPath: sessionFile,
    mtimeMs: 1,
    path: "sessions/main/session-1.jsonl",
    size,
  };
}

function multipartPart(params: { content: string; hash: string; partIndex: number }) {
  return {
    absPath: "agent:main:session-1",
    content: params.content,
    hash: params.hash,
    lineMap: [params.partIndex],
    lineProvenance: [],
    messageTimestampsMs: [1],
    mtimeMs: 1,
    partIndex: params.partIndex,
    path: "sessions/main/session-1.jsonl",
    sessionKind: "interactive" as const,
    size: 16 * 1024 * 1024,
  };
}

describe("QmdSessionExporter", () => {
  beforeEach(() => {
    mocks.buildQmdSqliteSessionParts.mockReset();
    mocks.buildSessionEntry.mockReset();
    mocks.corpusEntries.mockReset();
    mocks.replaceArtifactMappings.mockReset();
    mocks.statSessionEntrySync.mockReset();
    mocks.statSessionEntrySync.mockImplementation((sessionFile: string) =>
      smallSqliteState(sessionFile),
    );
  });

  it("skips unchanged transcript parsing by canonical corpus revision", async () => {
    await withTempDir("qmd-session-exporter-", async (tempDir) => {
      const exportDir = path.join(tempDir, "exports");
      const corpusEntry = {
        agentId: "main",
        artifactKind: "active-session" as const,
        contentRevision: "sqlite:1:100:1:1",
        sessionFile: "sqlite:main:session-1",
        sessionId: "session-1",
        transcriptSource: "sqlite" as const,
        updatedAtMs: 1,
      };
      mocks.corpusEntries.mockImplementation(async () => [corpusEntry]);
      mocks.buildSessionEntry.mockResolvedValue({
        absPath: corpusEntry.sessionFile,
        content: "User: first",
        hash: "first",
        lineMap: [1],
        messageTimestampsMs: [1],
        mtimeMs: 1,
        path: "sessions/main/session-1.jsonl",
        size: 100,
      });
      const exporter = new QmdSessionExporter(
        { collectionName: "sessions-main", dir: exportDir },
        "main",
        tempDir,
        path.join(tempDir, "index.sqlite"),
        () => "unused",
      );
      const lease = createLease();

      await exporter.exportSessions(lease);
      await exporter.exportSessions(lease);

      expect(mocks.buildSessionEntry).toHaveBeenCalledTimes(1);
      await expect(fs.readFile(path.join(exportDir, "session-1.md"), "utf8")).resolves.toContain(
        "User: first",
      );

      corpusEntry.contentRevision = "sqlite:2:200:2:2";
      mocks.buildSessionEntry.mockResolvedValue({
        absPath: corpusEntry.sessionFile,
        content: "User: second",
        hash: "second",
        lineMap: [1],
        messageTimestampsMs: [2],
        mtimeMs: 2,
        path: "sessions/main/session-1.jsonl",
        size: 200,
      });
      await exporter.exportSessions(lease);

      expect(mocks.buildSessionEntry).toHaveBeenCalledTimes(2);
      await expect(fs.readFile(path.join(exportDir, "session-1.md"), "utf8")).resolves.toContain(
        "User: second",
      );
    });
  });

  it("atomically repairs a missing or replaced export without hashing the transcript", async () => {
    await withTempDir("qmd-session-exporter-", async (tempDir) => {
      const exportDir = path.join(tempDir, "exports");
      const corpusEntry = {
        agentId: "main",
        artifactKind: "active-session" as const,
        contentRevision: "sqlite:1:100:1:1",
        sessionFile: "sqlite:main:session-1",
        sessionId: "session-1",
        transcriptSource: "sqlite" as const,
        updatedAtMs: 1,
      };
      mocks.corpusEntries.mockResolvedValue([corpusEntry]);
      mocks.buildSessionEntry.mockResolvedValue({
        absPath: corpusEntry.sessionFile,
        content: "User: canonical",
        hash: "canonical",
        lineMap: [1],
        messageTimestampsMs: [1],
        mtimeMs: 1,
        path: "sessions/main/session-1.jsonl",
        size: 100,
      });
      const exporter = new QmdSessionExporter(
        { collectionName: "sessions-main", dir: exportDir },
        "main",
        tempDir,
        path.join(tempDir, "index.sqlite"),
        () => "unused",
      );
      const target = path.join(exportDir, "session-1.md");
      const lease = createLease();

      await exporter.exportSessions(lease);
      await fs.writeFile(target, "corrupt", "utf8");
      await exporter.exportSessions(lease);
      await fs.rm(target);
      await exporter.exportSessions(lease);

      expect(mocks.buildSessionEntry).toHaveBeenCalledTimes(3);
      await expect(fs.readFile(target, "utf8")).resolves.toContain("User: canonical");
    });
  });

  it("reuses intact multipart artifacts across exporter restarts", async () => {
    await withTempDir("qmd-session-exporter-", async (tempDir) => {
      const exportDir = path.join(tempDir, "exports");
      const corpusEntry = {
        agentId: "main",
        artifactKind: "active-session" as const,
        contentRevision: "sqlite:10:16777216:10:1",
        sessionFile: "agent:main:session-1",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        storePath: path.join(tempDir, "sessions.json"),
        transcriptSource: "sqlite" as const,
        updatedAtMs: 1,
      };
      mocks.corpusEntries.mockImplementation(async () => [corpusEntry]);
      mocks.statSessionEntrySync.mockImplementation((sessionFile: string) =>
        smallSqliteState(sessionFile, 16 * 1024 * 1024),
      );
      mocks.buildQmdSqliteSessionParts.mockImplementation(async function* () {
        yield multipartPart({
          content: "User: first part",
          hash: "aaaaaaaaaaaaaaaa1111111111111111",
          partIndex: 1,
        });
        yield multipartPart({
          content: "Assistant: tail",
          hash: "bbbbbbbbbbbbbbbb2222222222222222",
          partIndex: 2,
        });
      });

      const createExporter = () =>
        new QmdSessionExporter(
          { collectionName: "sessions-main", dir: exportDir },
          "main",
          tempDir,
          path.join(tempDir, "index.sqlite"),
          (collection, artifactPath) => `qmd/${collection}/${artifactPath}`,
        );
      const lease = createLease();

      await createExporter().exportSessions(lease);

      const firstPath = path.join(exportDir, "session-1.part-000001.aaaaaaaaaaaaaaaa.md");
      const secondPath = path.join(exportDir, "session-1.part-000002.bbbbbbbbbbbbbbbb.md");
      const historicalTime = new Date("2000-01-01T00:00:00.000Z");
      await fs.utimes(firstPath, historicalTime, historicalTime);
      await fs.utimes(secondPath, historicalTime, historicalTime);
      const beforeFirst = await fs.stat(firstPath);
      const beforeSecond = await fs.stat(secondPath);

      await createExporter().exportSessions(lease);

      expect((await fs.stat(firstPath)).mtimeMs).toBe(beforeFirst.mtimeMs);
      expect((await fs.stat(secondPath)).mtimeMs).toBe(beforeSecond.mtimeMs);
      await expect(fs.readFile(firstPath, "utf8")).resolves.toContain("User: first part");
      await expect(fs.readFile(secondPath, "utf8")).resolves.toContain("Assistant: tail");
    });
  });

  it("exports large SQLite transcripts as multiple mapped artifacts and removes stale parts", async () => {
    await withTempDir("qmd-session-exporter-", async (tempDir) => {
      const exportDir = path.join(tempDir, "exports");
      const corpusEntry = {
        agentId: "main",
        artifactKind: "active-session" as const,
        contentRevision: "sqlite:10:16777216:10:1",
        sessionFile: "agent:main:session-1",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        storePath: path.join(tempDir, "sessions.json"),
        transcriptSource: "sqlite" as const,
        updatedAtMs: 1,
      };
      mocks.corpusEntries.mockImplementation(async () => [corpusEntry]);
      mocks.statSessionEntrySync.mockImplementation((sessionFile: string) =>
        smallSqliteState(sessionFile, 16 * 1024 * 1024),
      );
      mocks.buildQmdSqliteSessionParts.mockImplementation(async function* () {
        yield multipartPart({
          content: "User: first part",
          hash: "aaaaaaaaaaaaaaaa1111111111111111",
          partIndex: 1,
        });
        yield multipartPart({
          content: "Assistant: old tail",
          hash: "bbbbbbbbbbbbbbbb2222222222222222",
          partIndex: 2,
        });
      });

      const exporter = new QmdSessionExporter(
        { collectionName: "sessions-main", dir: exportDir },
        "main",
        tempDir,
        path.join(tempDir, "index.sqlite"),
        (collection, artifactPath) => `qmd/${collection}/${artifactPath}`,
      );
      const lease = createLease();

      await exporter.exportSessions(lease);

      expect(mocks.buildSessionEntry).not.toHaveBeenCalled();
      expect((await fs.readdir(exportDir)).toSorted()).toEqual([
        "session-1.part-000001.aaaaaaaaaaaaaaaa.md",
        "session-1.part-000002.bbbbbbbbbbbbbbbb.md",
      ]);
      expect(mocks.replaceArtifactMappings).toHaveBeenLastCalledWith({
        collection: "sessions-main",
        indexPath: path.join(tempDir, "index.sqlite"),
        mappings: [
          expect.objectContaining({
            artifactPath: "session-1.part-000001.aaaaaaaaaaaaaaaa.md",
            sessionId: "session-1",
          }),
          expect.objectContaining({
            artifactPath: "session-1.part-000002.bbbbbbbbbbbbbbbb.md",
            sessionId: "session-1",
          }),
        ],
      });

      corpusEntry.contentRevision = "sqlite:11:16777300:11:2";
      mocks.buildQmdSqliteSessionParts.mockImplementation(async function* () {
        yield multipartPart({
          content: "User: first part",
          hash: "aaaaaaaaaaaaaaaa1111111111111111",
          partIndex: 1,
        });
        yield multipartPart({
          content: "Assistant: new tail",
          hash: "cccccccccccccccc3333333333333333",
          partIndex: 2,
        });
      });

      await exporter.exportSessions(lease);

      expect((await fs.readdir(exportDir)).toSorted()).toEqual([
        "session-1.part-000001.aaaaaaaaaaaaaaaa.md",
        "session-1.part-000002.cccccccccccccccc.md",
      ]);
      expect(mocks.replaceArtifactMappings).toHaveBeenLastCalledWith({
        collection: "sessions-main",
        indexPath: path.join(tempDir, "index.sqlite"),
        mappings: [
          expect.objectContaining({
            artifactPath: "session-1.part-000001.aaaaaaaaaaaaaaaa.md",
            sessionId: "session-1",
          }),
          expect.objectContaining({
            artifactPath: "session-1.part-000002.cccccccccccccccc.md",
            sessionId: "session-1",
          }),
        ],
      });
    });
  });
});
