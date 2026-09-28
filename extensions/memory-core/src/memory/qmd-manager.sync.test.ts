import type { EventEmitter } from "node:events";
// QMD synchronization, watching, and startup behavior.
import {
  BUILT_IN_WATCH_DEBOUNCE_MS,
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
  firstWatchOptions,
  firstWatchPaths,
  fs,
  it,
  logWarnMock,
  makeQmdChild,
  path,
  resolveMemoryBackendConfigForTest,
  spawnMock,
  vi,
  waitUntil,
  watchMock,
  withLeaseMock,
  workspaceDir,
} from "./qmd-manager.test.support.js";

describe("QmdMemoryManager synchronization and startup", () => {
  it("debounces back-to-back sync calls", async () => {
    const { manager, resolved } = await createManager();

    const baselineCalls = spawnMock.mock.calls.length;

    await manager.sync({ reason: "manual" });
    expect(spawnMock.mock.calls.length).toBe(baselineCalls + 1);

    await manager.sync({ reason: "manual-again" });
    expect(spawnMock.mock.calls.length).toBe(baselineCalls + 1);

    (manager as unknown as { lastUpdateAt: number | null }).lastUpdateAt =
      Date.now() - (resolved.qmd?.update.debounceMs ?? 0) - 10;

    await manager.sync({ reason: "after-wait" });
    expect(spawnMock.mock.calls.length).toBe(baselineCalls + 2);

    await manager.close();
  });

  it("runs a qmd sync once for the first search in a fresh session", async () => {
    configureQmd(
      { update: { interval: "0s", debounceMs: 0, onBoot: false } },
      {
        search: {
          provider: "openai",
          model: "mock-embed",
          store: { vector: { enabled: false } },
          sync: { watch: false, onSessionStart: true, onSearch: false },
        },
      },
    );

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (args[0] === "search" || args[0] === "query" || args[0] === "vsearch") {
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      queueMicrotask(() => child.closeWith(0));
      return child;
    });

    const { manager } = await createManager({ mode: "full" });

    await manager.search("hello", { sessionKey: "session-a" });
    await manager.search("hello again", { sessionKey: "session-a" });

    const updateCalls = spawnMock.mock.calls.filter((call) => call[1]?.[0] === "update");
    expect(updateCalls).toHaveLength(1);
  });

  it("does not block first search on session-start sync completion", async () => {
    vi.useFakeTimers();
    configureQmd(
      { update: { interval: "0s", debounceMs: 0, onBoot: false } },
      {
        search: {
          provider: "openai",
          model: "mock-embed",
          store: { vector: { enabled: false } },
          sync: { watch: false, onSessionStart: true, onSearch: false },
        },
      },
    );

    let releaseUpdate: (() => void) | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        const child = createMockChild({ autoClose: false });
        releaseUpdate = () => child.closeWith(0);
        return child;
      }
      if (args[0] === "search" || args[0] === "query" || args[0] === "vsearch") {
        return makeQmdChild();
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    const searchPromise = manager.search("hello", { sessionKey: "session-b" });

    await vi.advanceTimersByTimeAsync(500);
    await expect(searchPromise).resolves.toStrictEqual([]);

    (
      releaseUpdate ??
      (() => {
        throw new Error("expected qmd update process to start");
      })
    )();
    await manager.close();
  });

  it("logs qmd watcher errors instead of throwing", async () => {
    configureQmd(
      { update: { interval: "0s", debounceMs: 0, onBoot: false } },
      {
        search: {
          provider: "openai",
          model: "mock-embed",
          store: { vector: { enabled: false } },
          sync: { watch: true, onSessionStart: false, onSearch: false },
        },
      },
    );

    const { manager } = await createManager({ mode: "full" });
    expect(watchMock).toHaveBeenCalledTimes(1);
    const watcher = watchMock.mock.results[0]?.value as EventEmitter;

    expect(() => {
      watcher.emit("error", new Error("ENOSPC: watcher limit reached"));
    }).not.toThrow();
    expectMockMessageContains(logWarnMock, "qmd watcher error: ENOSPC: watcher limit reached");

    await manager.close();
  });

  it("runs qmd sync when watched collection files change", async () => {
    vi.useFakeTimers();
    configureQmd(
      { update: { interval: "0s", debounceMs: 0, onBoot: false } },
      {
        search: {
          provider: "openai",
          model: "mock-embed",
          store: { vector: { enabled: false } },
          sync: { watch: true, onSessionStart: false, onSearch: false },
        },
      },
    );

    const { manager } = await createManager({ mode: "full" });
    expect(watchMock).toHaveBeenCalledTimes(1);
    const watcher = watchMock.mock.results[0]?.value as EventEmitter & {
      watchedEntries: Record<string, string[]>;
    };
    const initialUpdateCalls = spawnMock.mock.calls.filter((call) => call[1]?.[0] === "update");
    expect(initialUpdateCalls).toHaveLength(0);
    const watchOptions = firstWatchOptions();
    expect(watchOptions).not.toHaveProperty("awaitWriteFinish");
    expect(watchOptions.ignored?.(path.join(workspaceDir, "node_modules", "pkg", "note.md"))).toBe(
      true,
    );
    expect(watchOptions.ignored?.(path.join(workspaceDir, ".cache", "qmd", "note.md"))).toBe(true);
    expect(watchOptions.ignored?.(path.join(workspaceDir, "vendor", "pkg", "note.md"))).toBe(true);
    expect(watchOptions.ignored?.(path.join(workspaceDir, "dist", "note.md"))).toBe(true);
    expect(watchOptions.ignored?.(path.join(workspaceDir, "build", "note.md"))).toBe(true);
    expect(watchOptions.ignored?.(path.join(workspaceDir, "notes.md"))).toBe(false);
    watcher.watchedEntries = {
      [workspaceDir]: Array.from({ length: 2_001 }, (_value, index) => `${index}.md`),
    };
    watcher.emit("ready");
    expectMockMessageContains(logWarnMock, "Memory file watching is tracking 2002 paths.");

    const notesPath = path.join(workspaceDir, "notes.md");
    await fs.writeFile(notesPath, "hello");
    const initialStats = await fs.stat(notesPath);
    watcher.emit("change", notesPath, {
      size: initialStats.size,
      mtimeMs: initialStats.mtimeMs,
      isDirectory: () => false,
    });
    expect(manager.status().dirty).toBe(true);

    await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);

    const updateCalls = spawnMock.mock.calls.filter((call) => call[1]?.[0] === "update");
    expect(updateCalls).toHaveLength(1);
    expect(manager.status().dirty).toBe(false);

    await manager.close();
  });

  it("keeps explicit qmd collection roots watchable when their directory name is ignored", async () => {
    const rootNames = ["build", "dist", "vendor", ".cache"];
    const roots = rootNames.map((name) => path.join(workspaceDir, name));
    configureQmd(
      {
        update: { interval: "0s", debounceMs: 0, onBoot: false },
        paths: roots.map((root) => ({
          path: root,
          pattern: "**/*.md",
          name: path.basename(root),
        })),
      },
      {
        search: {
          provider: "openai",
          model: "mock-embed",
          store: { vector: { enabled: false } },
          sync: { watch: true, onSessionStart: false, onSearch: false },
        },
      },
    );

    const { manager } = await createManager({ mode: "full" });
    expect(watchMock).toHaveBeenCalledTimes(1);
    expect(firstWatchPaths().toSorted()).toEqual(
      roots.map((root) => path.join(root, "**/*.md")).toSorted(),
    );
    const ignored = firstWatchOptions().ignored;
    for (const root of roots) {
      expect(ignored?.(root)).toBe(false);
      expect(ignored?.(path.join(root, "note.md"))).toBe(false);
      expect(ignored?.(path.join(root, "..notes", "daily.md"))).toBe(false);
      expect(ignored?.(path.join(root, "notes", "daily.md"))).toBe(false);
      expect(ignored?.(path.join(root, "node_modules", "pkg", "note.md"))).toBe(true);
      expect(ignored?.(path.join(root, "build", "artifact.md"))).toBe(true);
    }

    await manager.close();
  });

  it("prefers a nested explicit qmd collection root over a broader watched root", async () => {
    const nestedRoot = path.join(workspaceDir, "build");
    configureQmd(
      {
        update: { interval: "0s", debounceMs: 0, onBoot: false },
        paths: [
          { path: workspaceDir, pattern: "**/*.md", name: "workspace" },
          { path: nestedRoot, pattern: "**/*.md", name: "build" },
        ],
      },
      {
        search: {
          provider: "openai",
          model: "mock-embed",
          store: { vector: { enabled: false } },
          sync: { watch: true, onSessionStart: false, onSearch: false },
        },
      },
    );

    const { manager } = await createManager({ mode: "full" });
    const ignored = firstWatchOptions().ignored;
    expect(ignored?.(path.join(nestedRoot, "note.md"))).toBe(false);
    expect(ignored?.(path.join(nestedRoot, "..notes", "daily.md"))).toBe(false);
    expect(ignored?.(path.join(nestedRoot, "node_modules", "pkg", "note.md"))).toBe(true);
    expect(ignored?.(path.join(workspaceDir, "node_modules", "pkg", "note.md"))).toBe(true);

    await manager.close();
  });

  it("delays qmd watch sync until changed file stats settle", async () => {
    vi.useFakeTimers();
    configureQmd(
      { update: { interval: "0s", debounceMs: 0, onBoot: false } },
      {
        search: {
          provider: "openai",
          model: "mock-embed",
          store: { vector: { enabled: false } },
          sync: { watch: true, onSessionStart: false, onSearch: false },
        },
      },
    );

    const notesPath = path.join(workspaceDir, "notes.md");
    await fs.writeFile(notesPath, "hello");
    const initialStats = await fs.stat(notesPath);
    const { manager } = await createManager({ mode: "full" });
    const watcher = watchMock.mock.results[0]?.value as {
      emit: (event: string, ...args: unknown[]) => boolean;
    };

    watcher.emit("change", notesPath, {
      size: initialStats.size,
      mtimeMs: initialStats.mtimeMs,
      isDirectory: () => false,
    });
    await fs.writeFile(notesPath, "hello updated");

    await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);
    expect(spawnMock.mock.calls.filter((call) => call[1]?.[0] === "update")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(BUILT_IN_WATCH_DEBOUNCE_MS);
    expect(spawnMock.mock.calls.filter((call) => call[1]?.[0] === "update")).toHaveLength(1);

    await manager.close();
  });

  it("runs boot update in background by default", async () => {
    configureQmd({ update: { interval: "0s", debounceMs: 60_000, onBoot: true } });

    let releaseUpdate: (() => void) | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        const child = createMockChild({ autoClose: false });
        releaseUpdate = () => child.closeWith(0);
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    (
      releaseUpdate ??
      (() => {
        throw new Error("Expected qmd update release callback");
      })
    )();
    await manager?.close();
  });

  it("skips qmd command side effects in status mode initialization", async () => {
    configureQmd({
      update: { interval: "5m", debounceMs: 60_000, onBoot: true },
    });

    const { manager } = await createManager({ mode: "status" });
    expect(spawnMock).not.toHaveBeenCalled();
    await manager?.close();
  });

  it("initializes one-shot CLI mode without watchers or background updates", async () => {
    configureQmd({
      update: { interval: "5m", debounceMs: 60_000, onBoot: true },
    });

    const { manager } = await createManager({ mode: "cli" });

    expect(watchMock).not.toHaveBeenCalled();
    const updateCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(updateCalls).toStrictEqual([]);

    await manager?.close();
  });

  it("preserves blocking boot update freshness for one-shot CLI mode", async () => {
    configureQmd({
      update: { interval: "5m", debounceMs: 60_000, onBoot: true, waitForBootSync: true },
    });

    const updateSpawned = createDeferred<void>();
    let releaseUpdate: (() => void) | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        const child = createMockChild({ autoClose: false });
        releaseUpdate = () => child.closeWith(0);
        updateSpawned.resolve();
        return child;
      }
      return createMockChild();
    });

    const createPromise = createManager({ mode: "cli" });
    await updateSpawned.promise;
    let created = false;
    void createPromise.then(() => {
      created = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(created).toBe(false);
    expect(watchMock).not.toHaveBeenCalled();

    (releaseUpdate as (() => void) | null)?.();
    const { manager } = await createPromise;
    const updateCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(updateCalls).toStrictEqual([["update"]]);
    expect(watchMock).not.toHaveBeenCalled();

    await manager?.close();
  });

  it("keeps one-shot CLI searches from scheduling session-start updates", async () => {
    configureQmd(
      { searchMode: "search" },
      {
        agents: {
          ...cfg.agents,
          defaults: { ...cfg.agents?.defaults, workspace: workspaceDir },
        },
        search: {
          ...cfg.memory?.search,
          sync: { watch: false, onSessionStart: true, onSearch: true },
        },
      },
    );
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        return makeQmdChild();
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "cli" });

    await expect(
      manager.search("glacier", { sessionKey: "agent:main:cli:memory-search" }),
    ).resolves.toStrictEqual([]);
    await manager.close();

    const updateCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(updateCalls).toStrictEqual([]);
    expect(
      spawnMock.mock.calls.some((call: unknown[]) => (call[1] as string[])?.[0] === "search"),
    ).toBe(true);
  });

  it("can be configured to block startup on boot update", async () => {
    configureQmd({
      update: { interval: "0s", debounceMs: 60_000, onBoot: true, waitForBootSync: true },
    });

    const updateSpawned = createDeferred<void>();
    let releaseUpdate: (() => void) | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        const child = createMockChild({ autoClose: false });
        releaseUpdate = () => child.closeWith(0);
        updateSpawned.resolve();
        return child;
      }
      return createMockChild();
    });

    const resolved = resolveMemoryBackendConfigForTest(cfg, agentId);
    const createPromise = QmdMemoryManager.create({
      cfg,
      agentId,
      resolved,
      withLease: withLeaseMock,
      mode: "full",
    });
    await updateSpawned.promise;
    let created = false;
    void createPromise.then(() => {
      created = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(created).toBe(false);
    (releaseUpdate as (() => void) | null)?.();
    const manager = await createPromise;
    await manager?.close();
  });

  it("times out collection bootstrap commands", async () => {
    vi.useFakeTimers();
    configureQmd({
      update: { interval: "0s", debounceMs: 60_000, onBoot: false, commandTimeoutMs: 15 },
    });

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        return createMockChild({ autoClose: false });
      }
      return createMockChild();
    });

    const managerPromise = createManager({ mode: "full" });
    await waitUntil(() =>
      spawnMock.mock.calls.some((call: unknown[]) => {
        const args = call[1] as string[];
        return args[0] === "collection" && args[1] === "list";
      }),
    );
    await vi.advanceTimersByTimeAsync(15);
    const { manager } = await managerPromise;
    const status = manager.status();
    expect(status.backend).toBe("qmd");
    expect(status.requestedProvider).toBe("qmd");
    await manager?.close();
  });
});
