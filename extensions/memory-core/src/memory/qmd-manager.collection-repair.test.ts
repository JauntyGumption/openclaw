// QMD collection repair and update failure behavior.
import {
  QmdMemoryManager,
  agentId,
  cfg,
  configureQmd,
  createDeferred,
  createManager,
  createMockChild,
  describe,
  emitAndClose,
  expect,
  expectMockMessageContains,
  fs,
  it,
  logDebugMock,
  logWarnMock,
  makeQmdChild,
  path,
  qmdIndexConfigPath,
  requireValue,
  resolveMemoryBackendConfigForTest,
  spawnMock,
  tmpRoot,
  trackManager,
  vi,
  withLeaseMock,
  workspaceDir,
} from "./qmd-manager.test.support.js";

describe("QmdMemoryManager collection repair", () => {
  it("falls back to --glob when qmd collection add rejects --mask", async () => {
    configureQmd({ includeDefaultMemory: true, paths: [] });

    const addFlagCalls: string[] = [];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        return makeQmdChild();
      }
      if (args[0] === "collection" && args[1] === "add") {
        const child = createMockChild({ autoClose: false });
        const flag = args.includes("--glob") ? "--glob" : args.includes("--mask") ? "--mask" : "";
        addFlagCalls.push(flag);
        if (flag === "--mask") {
          emitAndClose(child, "stderr", "unknown flag: --mask", 1);
          return child;
        }
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    expect(addFlagCalls).toEqual(["--mask", "--glob", "--glob"]);
    expectMockMessageContains(logWarnMock, "retrying with legacy compatibility flag");
  });

  it("migrates unscoped legacy collections from plain-text collection list output", async () => {
    configureQmd({ includeDefaultMemory: true, paths: [] });

    const removeCalls: string[] = [];
    const addCalls: string[] = [];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        return makeQmdChild({
          data: [
            "Collections (2):",
            "",
            "memory-root (qmd://memory-root/)",
            "  Pattern:  MEMORY.md",
            "",
            "memory-dir (qmd://memory-dir/)",
            "  Pattern:  **/*.md",
            "",
          ].join("\n"),
        });
      }
      if (args[0] === "collection" && args[1] === "remove") {
        const child = createMockChild({ autoClose: false });
        removeCalls.push(args[2] ?? "");
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      if (args[0] === "collection" && args[1] === "add") {
        const child = createMockChild({ autoClose: false });
        addCalls.push(args[args.indexOf("--name") + 1] ?? "");
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    expect(removeCalls).toEqual(["memory-root", "memory-dir"]);
    expect(addCalls).toEqual(["memory-root-main", "memory-dir-main"]);
  });

  it("does not migrate unscoped collections when listed metadata differs", async () => {
    configureQmd({ includeDefaultMemory: true, paths: [] });

    const differentPath = path.join(tmpRoot, "other-memory");
    await fs.mkdir(differentPath, { recursive: true });
    const removeCalls: string[] = [];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        return makeQmdChild({
          data: JSON.stringify([{ name: "memory-root", path: differentPath, mask: "MEMORY.md" }]),
        });
      }
      if (args[0] === "collection" && args[1] === "remove") {
        const child = createMockChild({ autoClose: false });
        removeCalls.push(args[2] ?? "");
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    expect(removeCalls).not.toContain("memory-root");
    expectMockMessageContains(
      logDebugMock,
      "qmd legacy collection migration skipped for memory-root",
    );
  });

  it("times out qmd update during sync when configured", async () => {
    vi.useFakeTimers();
    configureQmd({
      searchMode: "query",
      update: { interval: "0s", debounceMs: 0, onBoot: false, updateTimeoutMs: 20 },
    });
    const updateSpawned = createDeferred<void>();
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        updateSpawned.resolve();
        return createMockChild({ autoClose: false });
      }
      return createMockChild();
    });

    const resolved = resolveMemoryBackendConfigForTest(cfg, agentId);
    const createPromise = QmdMemoryManager.create({
      cfg,
      agentId,
      resolved,
      withLease: withLeaseMock,
      mode: "status",
    });
    await vi.advanceTimersByTimeAsync(0);
    const manager = requireValue(trackManager(await createPromise), "manager missing");
    const syncPromise = manager.sync({ reason: "manual" });
    const rejected = expect(syncPromise).rejects.toThrow("qmd update timed out after 20ms");
    await vi.advanceTimersByTimeAsync(0);
    await updateSpawned.promise;
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    await manager.close();
  });

  it("refreshes qmd index config with quoted collection values during update repair", async () => {
    const notesDir = path.join(workspaceDir, "Notes #1: blue");
    await fs.mkdir(notesDir, { recursive: true });
    configureQmd({
      update: { interval: "0s", debounceMs: 0, onBoot: false },
      paths: [{ path: notesDir, pattern: "**/* #tag: [draft].md", name: "notes" }],
    });

    let updateCalls = 0;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        updateCalls += 1;
        const child = createMockChild({ autoClose: false });
        if (updateCalls === 1) {
          emitAndClose(
            child,
            "stderr",
            "SQLiteError: UNIQUE constraint failed: documents.collection, documents.path",
            1,
          );
          return child;
        }
        queueMicrotask(() => {
          child.closeWith(0);
        });
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "status" });
    await expect(manager.sync({ reason: "manual" })).resolves.toBeUndefined();

    const indexConfig = await fs.readFile(qmdIndexConfigPath(), "utf8");
    expect(indexConfig).toContain('  "notes-main":');
    expect(indexConfig).toContain(`    path: ${JSON.stringify(notesDir)}`);
    expect(indexConfig).toContain('    pattern: "**/* #tag: [draft].md"');
    expect(updateCalls).toBe(2);

    await manager.close();
  });

  it("forces repair remove/add even when managed collections are still listed", async () => {
    configureQmd({
      includeDefaultMemory: true,
      update: { interval: "0s", debounceMs: 0, onBoot: false },
      paths: [],
    });

    let updateCalls = 0;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        emitAndClose(
          child,
          "stdout",
          JSON.stringify([
            { name: "memory-root-main", path: workspaceDir, mask: "MEMORY.md" },
            { name: "memory-dir-main", path: path.join(workspaceDir, "memory"), mask: "**/*.md" },
          ]),
        );
        return child;
      }
      if (args[0] === "update") {
        updateCalls += 1;
        const child = createMockChild({ autoClose: false });
        if (updateCalls === 1) {
          emitAndClose(
            child,
            "stderr",
            "SQLiteError: UNIQUE constraint failed: documents.collection, documents.path",
            1,
          );
          return child;
        }
        queueMicrotask(() => {
          child.closeWith(0);
        });
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await expect(manager.sync({ reason: "manual" })).resolves.toBeUndefined();

    const removeCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "collection" && args[1] === "remove")
      .map((args) => args[2]);
    const addCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "collection" && args[1] === "add")
      .map((args) => args[args.indexOf("--name") + 1]);

    expect(updateCalls).toBe(2);
    expect(removeCalls).toEqual(["memory-root-main", "memory-dir-main"]);
    expect(addCalls).toEqual(["memory-root-main", "memory-dir-main"]);

    await manager.close();
  });

  it("does not rebuild collections for unrelated unique constraint failures", async () => {
    configureQmd({
      includeDefaultMemory: true,
      update: { interval: "0s", debounceMs: 0, onBoot: false },
      paths: [],
    });

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        return makeQmdChild({
          stream: "stderr",
          data: "SQLiteError: UNIQUE constraint failed: documents.docid",
          code: 1,
        });
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "status" });
    await expect(manager.sync({ reason: "manual" })).rejects.toThrow(
      "SQLiteError: UNIQUE constraint failed: documents.docid",
    );

    const removeCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "collection" && args[1] === "remove");
    expect(removeCalls).toHaveLength(0);

    await manager.close();
  });

  it("does not rebuild collections for generic qmd update failures", async () => {
    configureQmd({
      includeDefaultMemory: true,
      update: { interval: "0s", debounceMs: 0, onBoot: false },
      paths: [],
    });

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        return makeQmdChild({
          stream: "stderr",
          data: "ENOTDIR: not a directory, open '/tmp/workspace/MEMORY.md'",
          code: 1,
        });
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "status" });
    await expect(manager.sync({ reason: "manual" })).rejects.toThrow(
      "ENOTDIR: not a directory, open '/tmp/workspace/MEMORY.md'",
    );

    const removeCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "collection" && args[1] === "remove");
    expect(removeCalls).toHaveLength(0);

    await manager.close();
  });

  it.each([
    {
      name: "rebuilds managed collections once when qmd update fails with null-byte ENOTDIR",
      error: "ENOTDIR: not a directory, open '/tmp/workspace/MEMORY.md^@'",
      warning: "suspected null-byte collection metadata",
    },
    {
      name: "rebuilds managed collections once when qmd update fails with null-byte ENOENT",
      error: "ENOENT: no such file or directory, open '/tmp/workspace/MEMORY.md\\x00'",
      warning: "suspected null-byte collection metadata",
    },
    {
      name: "rebuilds managed collections once when qmd update hits duplicate document constraint",
      error: "SQLiteError: UNIQUE constraint failed: documents.collection, documents.path",
      warning: "duplicate document constraint",
    },
  ])("$name", async ({ error, warning }) => {
    configureQmd({
      includeDefaultMemory: true,
      update: { interval: "0s", debounceMs: 0, onBoot: false },
      paths: [],
    });

    let updateCalls = 0;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        updateCalls += 1;
        const child = createMockChild({ autoClose: false });
        if (updateCalls === 1) {
          emitAndClose(child, "stderr", error, 1);
          return child;
        }
        queueMicrotask(() => {
          child.closeWith(0);
        });
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "status" });
    await expect(manager.sync({ reason: "manual" })).resolves.toBeUndefined();

    const removeCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "collection" && args[1] === "remove")
      .map((args) => args[2]);
    const addCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "collection" && args[1] === "add")
      .map((args) => args[args.indexOf("--name") + 1]);

    expect(updateCalls).toBe(2);
    expect(removeCalls).toEqual(["memory-root-main", "memory-dir-main"]);
    expect(addCalls).toEqual(["memory-root-main", "memory-dir-main"]);
    expectMockMessageContains(logWarnMock, warning);

    await manager.close();
  });
});
