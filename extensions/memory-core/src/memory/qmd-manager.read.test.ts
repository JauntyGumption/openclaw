// QMD read boundaries, session exports, and document resolution.
import {
  QmdMemoryManager,
  agentId,
  cfg,
  configureQmd,
  createManager,
  createMockChild,
  describe,
  emitAndClose,
  expect,
  expectDefined,
  expectMockMessageContains,
  expectedQmdProvenance,
  fs,
  it,
  logWarnMock,
  makeQmdChild,
  makeQmdResults,
  path,
  requireValue,
  seedQmdSessionTranscript,
  setWorkspaceDir,
  spawnMock,
  stateDir,
  vi,
  waitUntil,
  workspaceDir,
} from "./qmd-manager.test.support.js";

describe("QmdMemoryManager reads and session artifacts", () => {
  it("skips qmd embed in lexical search mode for forced sync", async () => {
    configureQmd({
      searchMode: "search",
      update: { interval: "0s", debounceMs: 0, onBoot: false },
    });

    const { manager } = await createManager({ mode: "status" });
    await manager.sync({ reason: "manual", force: true });

    const commandCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(commandCalls).toEqual([["update"]]);
    await manager.close();
  });

  it("retries boot update when qmd reports a retryable lock error", async () => {
    vi.useFakeTimers();
    configureQmd({
      searchMode: "search",
      update: { interval: "0s", debounceMs: 60_000, onBoot: true, waitForBootSync: true },
    });

    let updateCalls = 0;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        updateCalls += 1;
        const child = createMockChild({ autoClose: false });
        if (updateCalls === 1) {
          emitAndClose(child, "stderr", "SQLITE_BUSY: database is locked", 2);
        } else {
          emitAndClose(child, "stdout", "", 0);
        }
        return child;
      }
      return createMockChild();
    });

    const managerPromise = createManager({ mode: "full" });
    await waitUntil(() => updateCalls === 1);
    await vi.advanceTimersByTimeAsync(500);
    await waitUntil(() => updateCalls === 2);
    const { manager } = await managerPromise;

    expect(updateCalls).toBe(2);
    await manager.close();
  });

  it("succeeds on qmd update even when stdout exceeds the output cap", async () => {
    // Regression test for #24966: large indexes produce >200K chars of stdout
    // during `qmd update`, which used to fail with "produced too much output".
    const largeOutput = "x".repeat(300_000);
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(child, "stdout", largeOutput);
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "status" });
    // sync triggers runQmdUpdateOnce -> runQmd(["update"], { discardOutput: true })
    await expect(manager.sync({ reason: "manual" })).resolves.toBeUndefined();
    await manager.close();
  });

  it("scopes by channel for agent-prefixed session keys", async () => {
    configureQmd({
      scope: {
        default: "deny",
        rules: [{ action: "allow", match: { channel: "slack" } }],
      },
    });
    const { manager } = await createManager();

    const isAllowed = (key?: string) =>
      (manager as unknown as { isScopeAllowed: (key?: string) => boolean }).isScopeAllowed(key);
    expect(isAllowed("agent:main:slack:channel:c123")).toBe(true);
    expect(isAllowed("agent:main:slack:direct:u123")).toBe(true);
    expect(isAllowed("agent:main:slack:dm:u123")).toBe(true);
    expect(isAllowed("agent:main:discord:direct:u123")).toBe(false);
    expect(isAllowed("agent:main:discord:channel:c123")).toBe(false);

    await manager.close();
  });

  it("logs when qmd scope denies search", async () => {
    configureQmd({
      scope: {
        default: "deny",
        rules: [{ action: "allow", match: { chatType: "direct" } }],
      },
    });
    const { manager } = await createManager();

    logWarnMock.mockClear();
    const beforeCalls = spawnMock.mock.calls.length;
    await expect(
      manager.search("blocked", { sessionKey: "agent:main:discord:channel:c123" }),
    ).resolves.toStrictEqual([]);

    expect(spawnMock.mock.calls.length).toBe(beforeCalls);
    expectMockMessageContains(logWarnMock, "qmd search denied by scope");
    expectMockMessageContains(logWarnMock, "chatType=channel");

    await manager.close();
  });

  it("blocks non-markdown or symlink reads for qmd paths", async () => {
    const { manager } = await createManager();

    const textPath = path.join(workspaceDir, "secret.txt");
    await fs.writeFile(textPath, "nope", "utf-8");
    await expect(manager.readFile({ relPath: "qmd/workspace-main/secret.txt" })).rejects.toThrow(
      "path required",
    );

    const target = path.join(workspaceDir, "target.md");
    await fs.writeFile(target, "ok", "utf-8");
    const link = path.join(workspaceDir, "link.md");
    await fs.symlink(target, link);
    await expect(manager.readFile({ relPath: "qmd/workspace-main/link.md" })).rejects.toThrow(
      "path required",
    );

    await manager.close();
  });

  it("blocks memory_get reads of remember-only session exports", async () => {
    configureQmd(
      {},
      {
        agents: {
          ...cfg.agents,
          list: [{ id: "main", memory: { search: { rememberAcrossConversations: true } } }],
        },
      },
    );
    const { manager } = await createManager();

    // Remember-only export is search-only for trusted recall; ordinary
    // memory_get must not read transcript exports the operator never opted into.
    await expect(manager.readFile({ relPath: "qmd/sessions-main/export.md" })).rejects.toThrow(
      "path required",
    );

    await manager.close();
  });

  it("keeps explicitly configured session exports readable via memory_get", async () => {
    configureQmd({ sessions: { enabled: true } });
    const { manager } = await createManager();

    await expect(manager.readFile({ relPath: "qmd/sessions-main/export.md" })).resolves.toEqual({
      status: "not_found",
      path: "qmd/sessions-main/export.md",
      text: "",
    });

    await manager.close();
  });

  it("rejects non-memory workspace markdown reads", async () => {
    await fs.writeFile(path.join(workspaceDir, "window.md"), "secret", "utf-8");
    await fs.mkdir(path.join(workspaceDir, ".memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, ".memory", "hidden.md"), "secret", "utf-8");

    const { manager } = await createManager();

    await expect(manager.readFile({ relPath: "window.md" })).rejects.toThrow("path required");
    await expect(manager.readFile({ relPath: ".memory/hidden.md" })).rejects.toThrow(
      "path required",
    );

    await manager.close();
  });

  it("reads only requested line ranges from canonical memory files without loading the whole file", async () => {
    const readFileSpy = vi.spyOn(fs, "readFile");
    const text = Array.from({ length: 50 }, (_, index) => `line-${index + 1}`).join("\n");
    const relPath = path.join("memory", "window.md");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, relPath), text, "utf-8");

    const { manager } = await createManager();

    const result = await manager.readFile({ relPath, from: 10, lines: 3 });
    expect(result).toEqual({
      status: "ok",
      path: relPath,
      text: "line-10\nline-11\nline-12\n\n[More content available. Use from=13 to continue.]",
      from: 10,
      lines: 3,
      truncated: true,
      nextFrom: 13,
    });
    expect(readFileSpy).not.toHaveBeenCalled();

    await manager.close();
    readFileSpy.mockRestore();
  });

  it("defaults non-finite partial read line options before streaming canonical memory files", async () => {
    const readFileSpy = vi.spyOn(fs, "readFile");
    const relPath = path.join("memory", "non-finite-window.md");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, relPath),
      ["line-1", "line-2", "line-3"].join("\n"),
      "utf-8",
    );

    const { manager } = await createManager();

    const result = await manager.readFile({
      relPath,
      from: Number.NaN,
      lines: Number.POSITIVE_INFINITY,
    });
    expect(result).toEqual({
      status: "ok",
      path: relPath,
      text: "line-1\nline-2\nline-3",
      from: 1,
      lines: 3,
    });
    expect(readFileSpy).not.toHaveBeenCalled();

    await manager.close();
    readFileSpy.mockRestore();
  });

  it("returns a bounded default excerpt for qmd memory reads without explicit lines", async () => {
    const relPath = path.join("memory", "default-window.md");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, relPath),
      Array.from({ length: 150 }, (_, index) => `line-${index + 1}`).join("\n"),
      "utf-8",
    );

    const { manager } = await createManager();

    const result = await manager.readFile({ relPath });
    expect(result.path).toBe(relPath);
    expect(result.from).toBe(1);
    expect(result.lines).toBe(120);
    expect(result.truncated).toBe(true);
    expect(result.nextFrom).toBe(121);
    expect(result.text).toContain("line-1");
    expect(result.text).toContain("line-120");
    expect(result.text).not.toContain("line-121");
    expect(result.text).toContain("Use from=121 to continue.");

    await manager.close();
  });

  it("returns empty text when qmd files are missing before or during read", async () => {
    const relPath = path.join("memory", "qmd-window.md");
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, "one\ntwo\nthree", "utf-8");

    const cases = [
      {
        name: "missing before read",
        request: { relPath: path.join("memory", "ghost.md") },
        expectedPath: path.join("memory", "ghost.md"),
      },
      {
        name: "disappears before partial read",
        request: { relPath, from: 2, lines: 1 },
        expectedPath: relPath,
        installOpenSpy: () => {
          const realOpen = fs.open;
          let injected = false;
          const openSpy = vi
            .spyOn(fs, "open")
            .mockImplementation(async (...args: Parameters<typeof realOpen>) => {
              const [target, options] = args;
              if (!injected && typeof target === "string" && path.resolve(target) === absPath) {
                injected = true;
                const err = new Error("gone") as NodeJS.ErrnoException;
                err.code = "ENOENT";
                throw err;
              }
              return await realOpen(target, options);
            });
          return () => openSpy.mockRestore();
        },
      },
    ] as const;

    for (const testCase of cases) {
      const { manager } = await createManager();
      const restoreOpen = "installOpenSpy" in testCase ? testCase.installOpenSpy() : undefined;
      try {
        const result = await manager.readFile(testCase.request);
        expect(result, testCase.name).toEqual({
          status: "not_found",
          text: "",
          path: testCase.expectedPath,
        });
      } finally {
        restoreOpen?.();
        await manager.close();
      }
    }
  });

  it("reuses exported session markdown files when inputs are unchanged", async () => {
    const exportFile = path.join(stateDir, "agents", agentId, "qmd", "sessions", "session-1.md");
    await seedQmdSessionTranscript({ agentId, content: "hello", sessionId: "session-1", stateDir });

    const currentMemory = cfg.memory;
    configureQmd(
      { ...currentMemory?.qmd, sessions: { enabled: true } },
      { search: currentMemory?.search },
    );

    const { manager } = await createManager();

    try {
      await manager.sync({ reason: "manual" });
      const firstExport = await fs.readFile(exportFile, "utf-8");
      expect(firstExport).toContain("hello");

      await manager.sync({ reason: "manual" });
      const secondExport = await fs.readFile(exportFile, "utf-8");
      expect(secondExport).toBe(firstExport);
    } finally {
      await manager.close();
    }
  });

  it("fails closed when sqlite index is busy during doc lookup or search", async () => {
    const cases = [
      {
        name: "resolveDocLocation",
        run: async (manager: QmdMemoryManager) => {
          const inner = manager as unknown as {
            db: {
              prepare: () => {
                all: () => never;
                get: () => never;
              };
              close: () => void;
            } | null;
            resolveDocLocation: (docid?: string) => Promise<unknown>;
          };
          const busyStmt: { all: () => never; get: () => never } = {
            all: () => {
              throw new Error("SQLITE_BUSY: database is locked");
            },
            get: () => {
              throw new Error("SQLITE_BUSY: database is locked");
            },
          };
          inner.db = {
            prepare: () => busyStmt,
            close: () => {},
          };
          await expect(inner.resolveDocLocation("abc123")).rejects.toThrow(
            "qmd index busy while reading results",
          );
        },
      },
      {
        name: "search",
        run: async (manager: QmdMemoryManager) => {
          spawnMock.mockImplementation((_cmd: string, args: string[]) => {
            if (args[0] === "search") {
              const child = createMockChild({ autoClose: false });
              emitAndClose(
                child,
                "stdout",
                JSON.stringify([{ docid: "abc123", score: 1, snippet: "@@ -1,1\nremember this" }]),
              );
              return child;
            }
            return createMockChild();
          });
          const inner = manager as unknown as {
            db: { prepare: () => { all: () => never }; close: () => void } | null;
          };
          inner.db = {
            prepare: () => ({
              all: () => {
                throw new Error("SQLITE_BUSY: database is locked");
              },
            }),
            close: () => {},
          };
          await expect(
            manager.search("busy lookup", { sessionKey: "agent:main:slack:dm:u123" }),
          ).rejects.toThrow("qmd index busy while reading results");
        },
      },
    ] as const;

    for (const testCase of cases) {
      spawnMock.mockClear();
      spawnMock.mockImplementation(() => createMockChild());
      const { manager } = await createManager();
      try {
        await testCase.run(manager);
      } catch (error) {
        throw new Error(
          `${testCase.name}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      } finally {
        await manager.close();
      }
    }
  });

  it("prefers exact docid match before prefix fallback for qmd document lookups", async () => {
    const prepareCalls: string[] = [];
    const exactDocid = "abc123";
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        return makeQmdResults({
          docid: exactDocid,
          score: 1,
          snippet: "@@ -5,2\nremember this\nnext line",
        });
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    const inner = manager as unknown as {
      db: { prepare: (query: string) => { all: (arg: unknown) => unknown }; close: () => void };
    };
    inner.db = {
      prepare: (query: string) => {
        prepareCalls.push(query);
        return {
          all: (arg: unknown) => {
            if (query.includes("hash = ?")) {
              return [];
            }
            if (query.includes("hash LIKE ?")) {
              expect(arg).toBe(`${exactDocid}%`);
              return [
                {
                  collection: "workspace-main",
                  path: "notes/welcome.md",
                  modified_at: "2026-07-01T10:00:00.000Z",
                },
              ];
            }
            throw new Error(`unexpected sqlite query: ${query}`);
          },
        };
      },
      close: () => {},
    };

    const results = await manager.search("test", { sessionKey: "agent:main:slack:dm:u123" });
    expect(results).toEqual([
      {
        path: "notes/welcome.md",
        startLine: 5,
        endLine: 6,
        score: 1,
        snippet: "@@ -5,2\nremember this\nnext line",
        source: "memory",
        provenance: expectedQmdProvenance("untrusted"),
      },
    ]);

    expect(prepareCalls).toHaveLength(2);
    expect(prepareCalls[0]).toContain("hash = ?");
    expect(prepareCalls[1]).toContain("hash LIKE ?");
    expect(results[0]?.provenance?.observedAt).toBe(Date.parse("2026-07-01T10:00:00.000Z"));
    await manager.close();
  });

  it("prefers collection hint when resolving duplicate qmd document hashes", async () => {
    configureQmd({
      paths: [
        { path: workspaceDir, pattern: "**/*.md", name: "workspace" },
        { path: path.join(workspaceDir, "notes"), pattern: "**/*.md", name: "notes" },
      ],
    });

    const duplicateDocid = "dup-123";
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search" && args.includes("workspace-main")) {
        return makeQmdResults({
          docid: duplicateDocid,
          score: 0.9,
          snippet: "@@ -3,1\nworkspace hit",
        });
      }
      if (args[0] === "search" && args.includes("notes-main")) {
        return makeQmdChild();
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    const inner = manager as unknown as {
      db: { prepare: (query: string) => { all: (arg: unknown) => unknown }; close: () => void };
    };
    inner.db = {
      prepare: (_query: string) => ({
        all: (arg: unknown) => {
          if (typeof arg === "string" && arg.startsWith(duplicateDocid)) {
            return [
              { collection: "stale-workspace", path: "notes/welcome.md" },
              { collection: "workspace-main", path: "notes/welcome.md" },
            ];
          }
          return [];
        },
      }),
      close: () => {},
    };

    const results = await manager.search("workspace", { sessionKey: "agent:main:slack:dm:u123" });
    expect(results).toEqual([
      {
        path: "notes/welcome.md",
        startLine: 3,
        endLine: 3,
        score: 0.9,
        snippet: "@@ -3,1\nworkspace hit",
        source: "memory",
        provenance: expectedQmdProvenance("untrusted"),
      },
    ]);
    await manager.close();
  });

  it("resolves search hits when qmd returns qmd:// file URIs without docid", async () => {
    configureQmd();

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        return makeQmdResults({
          file: "qmd://workspace-main/notes/welcome.md",
          score: 0.71,
          snippet: "@@ -4,1\ntoken unlock",
        });
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    const results = await manager.search("token unlock", {
      sessionKey: "agent:main:slack:dm:u123",
    });
    expect(results).toEqual([
      {
        path: "notes/welcome.md",
        startLine: 4,
        endLine: 4,
        score: 0.71,
        snippet: "@@ -4,1\ntoken unlock",
        source: "memory",
        provenance: expectedQmdProvenance("untrusted"),
      },
    ]);
    await manager.close();
  });

  it("returns collection-scoped qmd paths when session exports live under the workspace qmd directory", async () => {
    setWorkspaceDir(path.join(stateDir, "agents", agentId));
    await fs.mkdir(workspaceDir, { recursive: true });
    configureQmd(
      { sessions: { enabled: true } },
      { agents: { list: [{ id: agentId, default: true, workspace: workspaceDir }] } },
    );

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        return makeQmdResults({
          file: "qmd://sessions-main/session-1.md",
          score: 0.84,
          snippet: "@@ -2,1\nsession canary",
        });
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    const inner = manager as unknown as {
      collectionRoots: Map<string, { path: string }>;
      resolveReadPath: (relPath: string) => string;
    };
    const sessionRoot = requireValue(
      inner.collectionRoots.get("sessions-main"),
      "sessions collection root missing",
    );
    expect(sessionRoot.path).toContain(path.join("qmd", "sessions"));
    const exportedSessionPath = path.join(sessionRoot.path, "session-1.md");

    const results = await manager.search("session canary", {
      sessionKey: "agent:main:slack:dm:u123",
    });
    expect(results).toEqual([
      {
        path: "qmd/sessions-main/session-1.md",
        startLine: 2,
        endLine: 2,
        score: 0.84,
        snippet: "@@ -2,1\nsession canary",
        source: "sessions",
        provenance: expectedQmdProvenance("untrusted"),
      },
    ]);

    const result = expectDefined(results[0], "QMD session search result");
    expect(inner.resolveReadPath(result.path)).toBe(exportedSessionPath);
    const realLstat = fs.lstat;
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (target, options) => {
      if (typeof target === "string" && path.resolve(target) === exportedSessionPath) {
        return {
          isFile: () => true,
          isSymbolicLink: () => false,
        } as Awaited<ReturnType<typeof realLstat>>;
      }
      return await realLstat(target, options);
    });
    const realReadFile = fs.readFile;
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation(async (target, options) => {
      if (typeof target === "string" && path.resolve(target) === exportedSessionPath) {
        return "# Session session-1\n\nsession canary\n";
      }
      return await realReadFile(target, options as never);
    });

    try {
      const readResult = await manager.readFile({ relPath: result.path });
      expect(readResult).toEqual({
        status: "ok",
        path: "qmd/sessions-main/session-1.md",
        text: "# Session session-1\n\nsession canary",
        from: 1,
        lines: 3,
      });
    } finally {
      lstatSpy.mockRestore();
      readSpy.mockRestore();
    }

    await manager.close();
  });
});
