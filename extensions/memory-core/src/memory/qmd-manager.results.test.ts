// QMD result resolution, status probes, model cache, and path rebinding.
import {
  afterEach,
  agentId,
  beforeEach,
  cfg,
  configureQmd,
  createManager,
  createMockChild,
  describe,
  expect,
  expectMockMessageNotContains,
  expectPathMissing,
  expectedQmdProvenance,
  fs,
  it,
  logWarnMock,
  makeQmdChild,
  makeQmdResults,
  parseListedQmdCollections,
  parseShownQmdCollection,
  path,
  requireNodeSqlite,
  seedQmdSessionTranscript,
  spawnMock,
  stateDir,
  tmpRoot,
  vi,
  workspaceDir,
} from "./qmd-manager.test.support.js";
import type { DatabaseSync, Mock, OpenClawConfig } from "./qmd-manager.test.support.js";

describe("QmdMemoryManager result resolution and status", () => {
  it("restricts qmd search to session collections before result limiting", async () => {
    configureQmd({ sessions: { enabled: true } });

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search" && args.includes("workspace-main")) {
        return makeQmdResults({
          file: "qmd://workspace-main/notes.md",
          score: 0.99,
          snippet: "@@ -1,1\nmemory hit",
        });
      }
      if (args[0] === "search" && args.includes("sessions-main")) {
        return makeQmdResults({
          file: "qmd://sessions-main/session-1.md",
          score: 0.8,
          snippet: "@@ -2,1\nsession hit",
        });
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    const results = await manager.search("hit", {
      sessionKey: "agent:main:slack:dm:u123",
      sources: ["sessions"],
      maxResults: 1,
    });

    expect(results).toEqual([
      {
        path: "qmd/sessions-main/session-1.md",
        startLine: 2,
        endLine: 2,
        score: 0.8,
        snippet: "@@ -2,1\nsession hit",
        source: "sessions",
        provenance: expectedQmdProvenance("untrusted"),
      },
    ]);

    const searchCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args) => args[0] === "search");
    expect(searchCalls).toHaveLength(1);
    expect(searchCalls[0]).toContain("sessions-main");
    expect(searchCalls[0]).not.toContain("workspace-main");

    await manager.close();
  });

  it("preserves multi-collection qmd search hits when results only include file URIs", async () => {
    configureQmd({
      paths: [
        { path: workspaceDir, pattern: "**/*.md", name: "workspace" },
        { path: path.join(workspaceDir, "notes"), pattern: "**/*.md", name: "notes" },
      ],
    });

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search" && args.includes("workspace-main")) {
        return makeQmdResults({
          file: "qmd://workspace-main/memory/facts.md",
          score: 0.8,
          snippet: "@@ -2,1\nworkspace fact",
        });
      }
      if (args[0] === "search" && args.includes("notes-main")) {
        return makeQmdResults({
          file: "qmd://notes-main/guide.md",
          score: 0.7,
          snippet: "@@ -1,1\nnotes guide",
        });
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    const results = await manager.search("fact", {
      sessionKey: "agent:main:slack:dm:u123",
    });
    expect(results).toEqual([
      {
        path: "memory/facts.md",
        startLine: 2,
        endLine: 2,
        score: 0.8,
        snippet: "@@ -2,1\nworkspace fact",
        source: "memory",
        provenance: expectedQmdProvenance("untrusted"),
      },
      {
        path: "notes/guide.md",
        startLine: 1,
        endLine: 1,
        score: 0.7,
        snippet: "@@ -1,1\nnotes guide",
        source: "memory",
        provenance: expectedQmdProvenance("untrusted"),
      },
    ]);
    await manager.close();
  });

  it("errors when qmd output exceeds command output safety cap", async () => {
    const noisyPayload = "x".repeat(240_000);
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        return makeQmdChild({ data: noisyPayload });
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    await expect(
      manager.search("noise", { sessionKey: "agent:main:slack:dm:u123" }),
    ).rejects.toThrow(/too much output/);
    await manager.close();
  });

  it("treats plain-text no-results markers from stdout/stderr as empty result sets", async () => {
    const cases = [
      { name: "stdout with punctuation", stream: "stdout", payload: "No results found." },
      { name: "stdout without punctuation", stream: "stdout", payload: "No results found\n\n" },
      { name: "stderr", stream: "stderr", payload: "No results found.\n" },
    ] as const;

    for (const testCase of cases) {
      spawnMock.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === "search") {
          return makeQmdChild({ stream: testCase.stream, data: testCase.payload });
        }
        return createMockChild();
      });

      const { manager } = await createManager();
      await expect(
        manager.search("missing", { sessionKey: "agent:main:slack:dm:u123" }),
        testCase.name,
      ).resolves.toStrictEqual([]);
      await manager.close();
    }
  });

  it("uses qmd file hints when docid lookup misses", async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        return makeQmdResults({
          docid: "missing-from-openclaw-index",
          file: "qmd://workspace-main/notes/welcome.md",
          score: 0.91,
          snippet: "@@ -3,1\nQMD activation",
        });
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    const inner = manager as unknown as {
      db: { prepare: () => { all: () => unknown[] }; close: () => void };
    };
    inner.db = {
      prepare: () => ({
        all: () => [],
      }),
      close: () => {},
    };

    await expect(
      manager.search("QMD activation", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([
      {
        path: "notes/welcome.md",
        startLine: 3,
        endLine: 3,
        score: 0.91,
        snippet: "@@ -3,1\nQMD activation",
        source: "memory",
        provenance: expectedQmdProvenance("untrusted"),
      },
    ]);
    await manager.close();
  });

  it("uses index record after index recovery, not stale hint-only cache", async () => {
    const searchDocid = "recovered-doc-after-empty-index";
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        return makeQmdResults({
          docid: searchDocid,
          file: "qmd://workspace-main/notes/welcome.md",
          score: 0.91,
          snippet: "@@ -3,1\nQMD activation",
        });
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    const inner = manager as unknown as {
      db: {
        prepare: () => { all: (arg: unknown) => unknown[] };
        close: () => void;
      } | null;
    };

    inner.db = {
      prepare: () => ({
        all: () => [],
      }),
      close: () => {},
    };

    await expect(
      manager.search("QMD activation", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([
      {
        path: "notes/welcome.md",
        startLine: 3,
        endLine: 3,
        score: 0.91,
        snippet: "@@ -3,1\nQMD activation",
        source: "memory",
        provenance: expectedQmdProvenance("untrusted"),
      },
    ]);

    inner.db = {
      prepare: () => ({
        all: () => [{ collection: "workspace-main", path: "indexed/path.md" }],
      }),
      close: () => {},
    };

    await expect(
      manager.search("QMD activation", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([
      {
        path: "indexed/path.md",
        startLine: 3,
        endLine: 3,
        score: 0.91,
        snippet: "@@ -3,1\nQMD activation",
        source: "memory",
        provenance: expectedQmdProvenance("untrusted"),
      },
    ]);
    await manager.close();
  });

  it("throws when stdout is empty without the no-results marker", async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        queueMicrotask(() => {
          child.stdout.emit("data", "   \n");
          child.stderr.emit("data", "unexpected parser error");
          child.closeWith(0);
        });
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    await expect(
      manager.search("missing", { sessionKey: "agent:main:slack:dm:u123" }),
    ).rejects.toThrow(/qmd query returned invalid JSON/);
    await manager.close();
  });

  it("sets busy_timeout on qmd sqlite connections", async () => {
    const { manager } = await createManager();
    const indexPath = (manager as unknown as { indexPath: string }).indexPath;
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    const { DatabaseSync } = requireNodeSqlite();
    const seedDb = new DatabaseSync(indexPath);
    seedDb.close();

    const db = (manager as unknown as { ensureDb: () => DatabaseSync }).ensureDb();
    const row = db.prepare("PRAGMA busy_timeout").get() as
      | { busy_timeout?: number; timeout?: number }
      | undefined;
    const busyTimeout = row?.busy_timeout ?? row?.timeout;
    expect(busyTimeout).toBe(1000);
    await manager.close();
  });

  it("uses the configured qmd timeout for status probes", async () => {
    vi.useFakeTimers();
    configureQmd({ searchMode: "query", limits: { timeoutMs: 6000 } });

    let statusKill: Mock | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "status") {
        const child = createMockChild({ autoClose: false });
        statusKill = vi.fn();
        child.kill = statusKill;
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    const probe = manager.probeVectorAvailability();
    await vi.advanceTimersByTimeAsync(5000);
    expect(statusKill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    await expect(probe).resolves.toBe(false);
    expect(manager.status().vector).toEqual({
      enabled: true,
      available: false,
      semanticAvailable: false,
      loadError: expect.stringContaining("timed out after 6000ms"),
    });
    await manager.close();
  });

  it("exports valid session transcripts whose IDs contain checkpoint words", async () => {
    configureQmd({ sessions: { enabled: true }, update: undefined });

    await seedQmdSessionTranscript({
      agentId,
      content: "live",
      sessionId: "live-session",
      stateDir,
    });
    await seedQmdSessionTranscript({
      agentId,
      content: "notes",
      sessionId: "team.checkpoint.notes",
      stateDir,
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.sync({ reason: "manual", force: true });
    const sessionExportDir = path.join(stateDir, "agents", agentId, "qmd", "sessions");
    const exported = (await fs.readdir(sessionExportDir)).toSorted();

    expect(exported).toEqual(["live-session.md", "team.checkpoint.notes.md"]);
    await expect(
      fs.readFile(path.join(sessionExportDir, "team.checkpoint.notes.md"), "utf-8"),
    ).resolves.toContain("notes");
    await manager.close();
  });

  it("reports vector availability as unavailable when qmd status shows zero vectors", async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "status") {
        return makeQmdChild({ data: "Documents: 12\nVectors: 0\n" });
      }
      return createMockChild();
    });

    const { manager } = await createManager({
      cfg: {
        ...cfg,
        memory: {
          ...cfg.memory,
          qmd: { ...cfg.memory?.qmd, searchMode: "query" },
        },
      } as OpenClawConfig,
    });

    await expect(manager.probeVectorAvailability()).resolves.toBe(false);
    await expect(manager.probeEmbeddingAvailability()).resolves.toEqual({
      ok: false,
      error: "QMD index has 0 vectors; semantic search is unavailable until embeddings finish",
    });
    expect(manager.status().vector).toEqual({
      enabled: true,
      available: false,
      semanticAvailable: false,
      loadError: "QMD index has 0 vectors; semantic search is unavailable until embeddings finish",
    });
    await manager.close();
  });

  it("reports vector availability as ready when qmd status shows vectors", async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "status") {
        return makeQmdChild({ data: "Documents: 12\nVectors: 42\n" });
      }
      return createMockChild();
    });

    const { manager } = await createManager({
      cfg: {
        ...cfg,
        memory: {
          ...cfg.memory,
          qmd: { ...cfg.memory?.qmd, searchMode: "query" },
        },
      } as OpenClawConfig,
    });

    await expect(manager.probeVectorAvailability()).resolves.toBe(true);
    await expect(manager.probeEmbeddingAvailability()).resolves.toEqual({
      ok: true,
      error: undefined,
    });
    expect(manager.status().vector).toEqual({
      enabled: true,
      available: true,
      semanticAvailable: true,
      loadError: undefined,
    });
    await manager.close();
  });

  it("does not parse unrelated qmd status vector-like fields", async () => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "status") {
        return makeQmdChild({ data: "Documents: 12\nMaxVectors: 42\nVector index: yes\n" });
      }
      return createMockChild();
    });

    const { manager } = await createManager({
      cfg: {
        ...cfg,
        memory: {
          ...cfg.memory,
          qmd: { ...cfg.memory?.qmd, searchMode: "query" },
        },
      } as OpenClawConfig,
    });

    await expect(manager.probeVectorAvailability()).resolves.toBe(false);
    expect(manager.status().vector).toEqual({
      enabled: true,
      available: false,
      semanticAvailable: false,
      loadError: "Could not determine QMD vector status from `qmd status`",
    });
    await manager.close();
  });

  it("skips qmd status vector probes for lexical search mode", async () => {
    const { manager } = await createManager({
      cfg: {
        ...cfg,
        memory: {
          ...cfg.memory,
          qmd: { ...cfg.memory?.qmd, searchMode: "search" },
        },
      } as OpenClawConfig,
    });
    const baselineCalls = spawnMock.mock.calls.length;

    await expect(manager.probeVectorAvailability()).resolves.toBe(false);
    await expect(manager.probeEmbeddingAvailability()).resolves.toEqual({
      ok: true,
      checked: false,
    });
    expect(spawnMock.mock.calls.length).toBe(baselineCalls);
    expect(manager.status().vector).toEqual({
      enabled: false,
      available: false,
      semanticAvailable: false,
      loadError: undefined,
    });
    await manager.close();
  });

  describe("model cache symlink", () => {
    let defaultModelsDir: string;
    let customModelsDir: string;
    let savedXdgCacheHome: string | undefined;

    beforeEach(async () => {
      // Redirect XDG_CACHE_HOME so symlinkSharedModels finds our fake models
      // directory instead of the real ~/.cache.
      savedXdgCacheHome = process.env.XDG_CACHE_HOME;
      const fakeCacheHome = path.join(tmpRoot, "fake-cache");
      Reflect.set(process.env, "XDG_CACHE_HOME", fakeCacheHome);

      defaultModelsDir = path.join(fakeCacheHome, "qmd", "models");
      await fs.mkdir(defaultModelsDir, { recursive: true });
      await fs.writeFile(path.join(defaultModelsDir, "model.bin"), "fake-model");

      customModelsDir = path.join(stateDir, "agents", agentId, "qmd", "xdg-cache", "qmd", "models");
    });

    afterEach(() => {
      if (savedXdgCacheHome === undefined) {
        Reflect.deleteProperty(process.env, "XDG_CACHE_HOME");
      } else {
        Reflect.set(process.env, "XDG_CACHE_HOME", savedXdgCacheHome);
      }
    });

    it("handles first-run symlink, existing dir preservation, and missing default cache", async () => {
      const cases: Array<{
        name: string;
        setup?: () => Promise<void>;
        assert: () => Promise<void>;
      }> = [
        {
          name: "symlinks default cache on first run",
          assert: async () => {
            const stat = await fs.lstat(customModelsDir);
            expect(stat.isSymbolicLink()).toBe(true);
            const target = await fs.readlink(customModelsDir);
            expect(target).toBe(defaultModelsDir);
            const content = await fs.readFile(path.join(customModelsDir, "model.bin"), "utf-8");
            expect(content).toBe("fake-model");
          },
        },
        {
          name: "does not overwrite existing models directory",
          setup: async () => {
            await fs.mkdir(customModelsDir, { recursive: true });
            await fs.writeFile(path.join(customModelsDir, "custom-model.bin"), "custom");
          },
          assert: async () => {
            const stat = await fs.lstat(customModelsDir);
            expect(stat.isSymbolicLink()).toBe(false);
            expect(stat.isDirectory()).toBe(true);
            const content = await fs.readFile(
              path.join(customModelsDir, "custom-model.bin"),
              "utf-8",
            );
            expect(content).toBe("custom");
          },
        },
        {
          name: "skips symlink when default models are absent",
          setup: async () => {
            await fs.rm(defaultModelsDir, { recursive: true, force: true });
          },
          assert: async () => {
            await expectPathMissing(customModelsDir);
            expectMockMessageNotContains(logWarnMock, "failed to symlink qmd models directory");
          },
        },
      ];

      for (const testCase of cases) {
        await fs.rm(customModelsDir, { recursive: true, force: true });
        await fs.mkdir(defaultModelsDir, { recursive: true });
        await fs.writeFile(path.join(defaultModelsDir, "model.bin"), "fake-model");
        logWarnMock.mockClear();
        await testCase.setup?.();
        const { manager } = await createManager({ mode: "full" });
        try {
          await testCase.assert();
        } finally {
          await manager.close();
        }
      }
    });
  });

  it("rebinds a managed collection when its root path changed (show reveals old path)", async () => {
    // Regression: listCollectionsBestEffort gets only the name from `collection list`
    // (no path). The fix enriches path via `collection show`; without it shouldRebindCollection
    // hits the `!listed.path` branch and skips the rebind, leaving the old path pinned.
    const oldWorkspaceDir = path.join(tmpRoot, "old-workspace");
    const newWorkspaceDir = workspaceDir; // the manager is configured for this new path

    configureQmd({
      paths: [{ path: newWorkspaceDir, pattern: "**/*.md", name: "workspace" }],
    });

    const collectionName = `workspace-${agentId}`;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        // Real qmd: names only, no path/pattern in list output.
        return makeQmdResults(collectionName);
      }
      if (args[0] === "collection" && args[1] === "show" && args[2] === collectionName) {
        // Real qmd `collection show` output — exposes the stale (old) path.
        return makeQmdChild({
          data: [
            `Collection: ${collectionName}`,
            `  Path:     ${oldWorkspaceDir}`,
            `  Pattern:  **/*.md`,
            `  Include:  yes (default)`,
          ].join("\n"),
        });
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    const commands = spawnMock.mock.calls.map((call: unknown[]) => call[1] as string[]);

    const removeCall = commands.find(
      (args) => args[0] === "collection" && args[1] === "remove" && args[2] === collectionName,
    );
    expect(removeCall).toBeDefined(); // rebind must remove the stale collection

    const addCall = commands.find((args) => {
      if (args[0] !== "collection" || args[1] !== "add") {
        return false;
      }
      const nameIdx = args.indexOf("--name");
      return nameIdx >= 0 && args[nameIdx + 1] === collectionName;
    });
    expect(addCall).toBeDefined();
    // The new add must target the NEW workspace path, not the old one.
    expect(addCall?.[2]).toBe(newWorkspaceDir);
  });

  it("rebinds a stale in-container collection root to the host workspace (sandbox-mode transition)", async () => {
    // Sandbox coverage: an agent that previously ran with its workspace bind-mounted under
    // /home/node/.openclaw/... stored that in-container path as the collection root. Resolved
    // with host paths, `collection show` reveals the stale container path; the rebind is
    // path-namespace-agnostic and re-binds to the current host root.
    const containerRoot = "/home/node/.openclaw/teams/x/workspace";
    const newWorkspaceDir = workspaceDir; // host path the manager is configured for

    configureQmd({
      paths: [{ path: newWorkspaceDir, pattern: "**/*.md", name: "workspace" }],
    });

    const collectionName = `workspace-${agentId}`;

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        return makeQmdResults(collectionName);
      }
      if (args[0] === "collection" && args[1] === "show" && args[2] === collectionName) {
        return makeQmdChild({
          data: [
            `Collection: ${collectionName}`,
            `  Path:     ${containerRoot}`,
            `  Pattern:  **/*.md`,
            `  Include:  yes (default)`,
          ].join("\n"),
        });
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    const commands = spawnMock.mock.calls.map((call: unknown[]) => call[1] as string[]);
    const removeCall = commands.find(
      (args) => args[0] === "collection" && args[1] === "remove" && args[2] === collectionName,
    );
    expect(removeCall).toBeDefined();
    const addCall = commands.find((args) => {
      if (args[0] !== "collection" || args[1] !== "add") {
        return false;
      }
      const nameIdx = args.indexOf("--name");
      return nameIdx >= 0 && args[nameIdx + 1] === collectionName;
    });
    expect(addCall).toBeDefined();
    // Re-added at the host workspace root, not the stale container path.
    expect(addCall?.[2]).toBe(newWorkspaceDir);
  });

  it("parseShownQmdCollection extracts path and pattern from qmd collection show output", () => {
    const sampleOutput = [
      "Collection: memory-dir-example",
      "  Path:     /home/node/.openclaw/teams/example-team/workspace-example/memory",
      "  Pattern:  **/*.md",
      "  Include:  yes (default)",
    ].join("\n");

    const result = parseShownQmdCollection(sampleOutput);
    expect(result.path).toBe("/home/node/.openclaw/teams/example-team/workspace-example/memory");
    expect(result.pattern).toBe("**/*.md");

    // Tolerant of missing fields.
    expect(parseShownQmdCollection("")).toEqual({});
    expect(parseShownQmdCollection("Collection: no-path-here\n  Include:  yes")).toEqual({});

    // Path-only (no pattern line).
    const pathOnly = parseShownQmdCollection("Collection: x\n  Path:  /some/path\n");
    expect(pathOnly.path).toBe("/some/path");
    expect(pathOnly.pattern).toBeUndefined();
  });

  it("parseListedQmdCollections accepts uppercase bare collection names", () => {
    expect(parseListedQmdCollections("Workspace-Main\n")).toEqual(
      new Map([["Workspace-Main", {}]]),
    );
  });

  it.each([
    ["equals separator", "Documents: 12\nVectors = 42\n"],
    ["tab separator", "Documents: 12\nVectors:\t42\n"],
    ["compact separator", "Documents: 12\nVectors:42\n"],
    ["embedded suffix", "Documents: 12\nVectors:  42 embedded\n"],
  ])("reports vector availability as ready for qmd status %s", async (_name, statusOutput) => {
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "status") {
        return makeQmdChild({ data: statusOutput });
      }
      return createMockChild();
    });

    const { manager } = await createManager({
      cfg: {
        ...cfg,
        memory: {
          ...cfg.memory,
          qmd: { ...cfg.memory?.qmd, searchMode: "query" },
        },
      } as OpenClawConfig,
    });

    await expect(manager.probeVectorAvailability()).resolves.toBe(true);
    await manager.close();
  });
});
