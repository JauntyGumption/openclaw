import {
  abortSearchScenarios,
  runAbortSearchScenario,
} from "./qmd-manager.search-scenarios.test.support.js";
// QMD manager cache, command matrix, and validation behavior.
import {
  MAX_TIMER_TIMEOUT_MS,
  MEMORY_SEARCH_DEADLINE_CONTROL,
  cfg,
  configureMemoryCoreDreamingState,
  configureMemoryCoreDreamingStateForTests,
  configureQmd,
  countQmdCommand,
  createManager,
  createMockChild,
  describe,
  emitAndClose,
  expect,
  fs,
  it,
  makeQmdChild,
  path,
  requireValue,
  resolveQmdMcporterSearchProcessTimeoutMs,
  spawnMock,
  tmpRoot,
  vi,
  waitUntil,
  withLeaseMock,
  workspaceDir,
} from "./qmd-manager.test.support.js";
import type {
  MemorySearchRuntimeDebug,
  MockChild,
  OpenClawConfig,
  PluginStateLeaseContext,
  PluginStateLeaseOptions,
} from "./qmd-manager.test.support.js";

describe("QmdMemoryManager runtime cache and command behavior", () => {
  it("caps mcporter search process timeout grace", () => {
    expect(resolveQmdMcporterSearchProcessTimeoutMs(1_000)).toBe(5_000);
    expect(resolveQmdMcporterSearchProcessTimeoutMs(10_000)).toBe(12_000);
    expect(resolveQmdMcporterSearchProcessTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
    expect(resolveQmdMcporterSearchProcessTimeoutMs(Number.MAX_VALUE)).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(resolveQmdMcporterSearchProcessTimeoutMs(MAX_TIMER_TIMEOUT_MS - 100)).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });

  it("reuses persisted collection validation across transient cli managers", async () => {
    await configureMemoryCoreDreamingStateForTests();
    const first = await createManager({ mode: "cli" });
    await first.manager.close();
    expect(countQmdCommand((args) => args[0] === "collection" && args[1] === "list")).toBe(1);

    spawnMock.mockClear();
    const second = await createManager({ mode: "cli" });
    await second.manager.close();

    expect(countQmdCommand((args) => args[0] === "collection" && args[1] === "list")).toBe(0);
    expect(countQmdCommand((args) => args[0] === "collection" && args[1] === "show")).toBe(0);
    expect(countQmdCommand((args) => args[0] === "collection" && args[1] === "add")).toBe(0);
  });

  it("serializes same-agent initialization through cache publication", async () => {
    await configureMemoryCoreDreamingStateForTests();
    let tail = Promise.resolve();
    let active = 0;
    let maxActive = 0;
    withLeaseMock.mockImplementation(
      async <T>(
        options: PluginStateLeaseOptions,
        run: (lease: PluginStateLeaseContext) => Promise<T>,
      ) => {
        const context = {
          signal: options.signal ?? new AbortController().signal,
          assertOwned: vi.fn(),
        };
        if (options.database.scope !== "agent" || options.key !== "write") {
          return (await run(context)) as T;
        }
        const execute = async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          try {
            return (await run(context)) as T;
          } finally {
            active -= 1;
          }
        };
        const result = tail.then(execute, execute);
        tail = result.then(
          () => undefined,
          () => undefined,
        );
        return await result;
      },
    );

    const [first, second] = await Promise.all([
      createManager({ mode: "cli" }),
      createManager({ mode: "cli" }),
    ]);

    expect(maxActive).toBe(1);
    expect(countQmdCommand((args) => args[0] === "collection" && args[1] === "list")).toBe(1);
    await first.manager.close();
    await second.manager.close();
  });

  it("does not cache incomplete collection validation", async () => {
    await configureMemoryCoreDreamingStateForTests();
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "add") {
        return makeQmdChild({ stream: "stderr", data: "permission denied", code: 1 });
      }
      return createMockChild();
    });

    const first = await createManager({ mode: "cli" });
    await first.manager.close();

    spawnMock.mockClear();
    spawnMock.mockImplementation(() => createMockChild());
    const second = await createManager({ mode: "cli" });
    await second.manager.close();

    expect(countQmdCommand((args) => args[0] === "collection" && args[1] === "list")).toBe(1);
    expect(countQmdCommand((args) => args[0] === "collection" && args[1] === "add")).toBe(1);
  });

  it("runs collection validation when the runtime cache store is unavailable", async () => {
    configureMemoryCoreDreamingState(() => {
      throw new Error("state store unavailable");
    });
    try {
      const manager = await createManager({ mode: "cli" });
      await manager.manager.close();
    } finally {
      await configureMemoryCoreDreamingStateForTests();
    }

    expect(countQmdCommand((args) => args[0] === "collection" && args[1] === "list")).toBe(1);
    expect(countQmdCommand((args) => args[0] === "collection" && args[1] === "add")).toBe(1);
  });

  it("reports collection validation debug only once per validation run", async () => {
    await configureMemoryCoreDreamingStateForTests();
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "query" || args[0] === "search" || args[0] === "vsearch") {
        return makeQmdChild();
      }
      return createMockChild();
    });
    const { manager } = await createManager({ mode: "cli" });
    const firstDebug: MemorySearchRuntimeDebug[] = [];
    const secondDebug: MemorySearchRuntimeDebug[] = [];

    await manager.search("fact", {
      sessionKey: "agent:main:slack:dm:u123",
      onDebug: (entry) => {
        firstDebug.push(entry);
      },
    });
    await manager.search("fact again", {
      sessionKey: "agent:main:slack:dm:u123",
      onDebug: (entry) => {
        secondDebug.push(entry);
      },
    });

    expect(firstDebug.at(-1)?.qmd?.collectionValidation?.cacheState).toBe("write");
    expect(secondDebug.at(-1)?.qmd?.collectionValidation).toBeUndefined();
  });

  it("misses collection validation cache when managed collection config changes", async () => {
    await configureMemoryCoreDreamingStateForTests();
    const first = await createManager({ mode: "cli" });
    await first.manager.close();

    const otherWorkspaceDir = path.join(tmpRoot, "other-workspace");
    await fs.mkdir(otherWorkspaceDir, { recursive: true });
    const changedCfg = {
      ...cfg,
      memory: {
        backend: "qmd",
        qmd: {
          ...cfg.memory?.qmd,
          paths: [{ path: otherWorkspaceDir, pattern: "**/*.md", name: "workspace" }],
        },
      },
    } as OpenClawConfig;

    spawnMock.mockClear();
    const second = await createManager({ mode: "cli", cfg: changedCfg });
    await second.manager.close();

    expect(countQmdCommand((args) => args[0] === "collection" && args[1] === "list")).toBe(1);
  });

  it("bypasses validation cache for missing-collection search repair", async () => {
    await configureMemoryCoreDreamingStateForTests();
    const { manager } = await createManager();
    spawnMock.mockClear();
    let searchAttempts = 0;
    const events: string[] = [];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      events.push(`command:${args[0]}${args[1] ? `:${args[1]}` : ""}`);
      if (args[0] === "query" || args[0] === "search" || args[0] === "vsearch") {
        const child = createMockChild({ autoClose: false });
        searchAttempts += 1;
        if (searchAttempts === 1) {
          emitAndClose(child, "stderr", "collection workspace-main not found", 1);
        } else {
          emitAndClose(child, "stdout", "[]");
        }
        return child;
      }
      return createMockChild();
    });
    const debug: MemorySearchRuntimeDebug[] = [];

    await manager.search("fact", {
      sessionKey: "agent:main:slack:dm:u123",
      onDebug: (entry) => {
        debug.push(entry);
      },
      [MEMORY_SEARCH_DEADLINE_CONTROL]: (action) => {
        events.push(`phase:${action}`);
      },
    });

    expect(searchAttempts).toBe(2);
    expect(countQmdCommand((args) => args[0] === "collection" && args[1] === "list")).toBe(1);
    expect(debug.at(-1)?.qmd?.collectionValidation?.cacheState).toBe("bypass-force");
    expect(events.filter((event) => event.startsWith("phase:"))).toEqual([
      "phase:pause",
      "phase:resume",
      "phase:pause",
      "phase:resume",
    ]);
    const isSearchCommand = (event: string) =>
      ["command:query:", "command:search:", "command:vsearch:"].some((prefix) =>
        event.startsWith(prefix),
      );
    const firstSearch = events.findIndex(isSearchCommand);
    const firstSearchEnd = events.indexOf("phase:resume");
    const collectionRepair = events.findIndex(
      (event, index) => index > firstSearchEnd && event.startsWith("command:collection:"),
    );
    const retryStart = events.indexOf("phase:pause", firstSearchEnd + 1);
    const retrySearch = events.findIndex(
      (event, index) => index > firstSearch && isSearchCommand(event),
    );
    expect(events.indexOf("phase:pause")).toBeLessThan(firstSearch);
    expect(firstSearch).toBeLessThan(firstSearchEnd);
    expect(firstSearchEnd).toBeLessThan(collectionRepair);
    expect(collectionRepair).toBeLessThan(retryStart);
    expect(retryStart).toBeLessThan(retrySearch);
  });

  it("reuses persisted qmd multi-collection support probe across managers", async () => {
    await configureMemoryCoreDreamingStateForTests();
    configureQmd({ sessions: { enabled: true } });
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "--help") {
        return makeQmdChild({ data: "Usage: qmd search -c one or more collections" });
      }
      if (args[0] === "search") {
        return makeQmdChild();
      }
      return createMockChild();
    });

    const first = await createManager({ mode: "cli" });
    await first.manager.search("fact", {
      sessionKey: "agent:main:slack:dm:u123",
    });
    await first.manager.close();
    expect(countQmdCommand((args) => args[0] === "--help")).toBe(1);

    spawnMock.mockClear();
    const second = await createManager({ mode: "cli" });
    const debug: MemorySearchRuntimeDebug[] = [];
    await second.manager.search("fact", {
      sessionKey: "agent:main:slack:dm:u123",
      onDebug: (entry) => {
        debug.push(entry);
      },
    });
    await second.manager.close();

    expect(countQmdCommand((args) => args[0] === "--help")).toBe(0);
    expect(debug.at(-1)?.qmd?.multiCollectionProbe?.cacheState).toBe("hit");
    expect(debug.at(-1)?.qmd?.searchPlan?.groupCount).toBe(2);
  });

  it("reports multi-collection probe debug only when the probe runs", async () => {
    await configureMemoryCoreDreamingStateForTests();
    configureQmd({ sessions: { enabled: true } });
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "--help") {
        return makeQmdChild({ data: "Usage: qmd search -c one or more collections" });
      }
      if (args[0] === "search") {
        return makeQmdChild();
      }
      return createMockChild();
    });
    const { manager } = await createManager({ mode: "cli" });
    const firstDebug: MemorySearchRuntimeDebug[] = [];
    const secondDebug: MemorySearchRuntimeDebug[] = [];

    await manager.search("fact", {
      sessionKey: "agent:main:slack:dm:u123",
      onDebug: (entry) => {
        firstDebug.push(entry);
      },
    });
    await manager.search("fact again", {
      sessionKey: "agent:main:slack:dm:u123",
      onDebug: (entry) => {
        secondDebug.push(entry);
      },
    });

    expect(firstDebug.at(-1)?.qmd?.multiCollectionProbe?.cacheState).toBe("write");
    expect(secondDebug.at(-1)?.qmd?.multiCollectionProbe).toBeUndefined();
  });

  it("keeps concurrent search debug isolated on a shared qmd manager", async () => {
    await configureMemoryCoreDreamingStateForTests();
    configureQmd({ sessions: { enabled: true } });
    let firstSearchChild: MockChild | undefined;
    let searchCalls = 0;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        searchCalls += 1;
        const child = createMockChild({ autoClose: false });
        if (searchCalls === 1) {
          firstSearchChild = child;
          return child;
        }
        emitAndClose(child, "stdout", "[]");
        return child;
      }
      if (args[0] === "--version") {
        return makeQmdChild({ data: "qmd 1.0.0" });
      }
      return createMockChild();
    });
    const { manager } = await createManager({ mode: "full" });
    const firstDebug: MemorySearchRuntimeDebug[] = [];
    const secondDebug: MemorySearchRuntimeDebug[] = [];

    const firstSearch = manager.search("memory fact", {
      sessionKey: "agent:main:slack:dm:u123",
      sources: ["memory"],
      onDebug: (entry) => {
        firstDebug.push(entry);
      },
    });
    await waitUntil(() => searchCalls === 1);
    const secondSearch = manager.search("session fact", {
      sessionKey: "agent:main:slack:dm:u123",
      sources: ["sessions"],
      onDebug: (entry) => {
        secondDebug.push(entry);
      },
    });
    await waitUntil(() => searchCalls === 2);
    emitAndClose(requireValue(firstSearchChild, "first search child missing"), "stdout", "[]");

    await Promise.all([firstSearch, secondSearch]);

    expect(firstDebug.at(-1)?.qmd?.searchPlan?.sources).toEqual(["memory"]);
    expect(secondDebug.at(-1)?.qmd?.searchPlan?.sources).toEqual(["sessions"]);
  });

  it("keeps remember-only session exports out of ordinary manager searches", async () => {
    configureQmd(
      {},
      {
        agents: {
          ...cfg.agents,
          list: [{ id: "main", memory: { search: { rememberAcrossConversations: true } } }],
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

    await manager.search("remember-only", {
      sessionKey: "agent:main:cli:direct:memory-search",
    });

    const searchCalls = spawnMock.mock.calls
      .filter(([, args]) => args[0] === "search")
      .map(([, args]) => args);
    expect(searchCalls.some((args) => args.includes("workspace-main"))).toBe(true);
    expect(searchCalls.some((args) => args.includes("sessions-main"))).toBe(false);
    await manager.close();
  });

  it("rewrites stale multi-collection probe cache when combined filters are rejected", async () => {
    await configureMemoryCoreDreamingStateForTests();
    const otherWorkspaceDir = path.join(tmpRoot, "other-workspace");
    await fs.mkdir(otherWorkspaceDir, { recursive: true });
    configureQmd({
      paths: [
        { path: workspaceDir, pattern: "**/*.md", name: "workspace" },
        { path: otherWorkspaceDir, pattern: "**/*.md", name: "other" },
      ],
    });
    const isCombinedSearch = (args: string[]) =>
      (args[0] === "search" || args[0] === "query") &&
      args.filter((token) => token === "-c").length > 1;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "--version") {
        return makeQmdChild({ data: "qmd 1.0.0" });
      }
      if (args[0] === "--help") {
        return makeQmdChild({ data: "Usage: qmd search -c one or more collections" });
      }
      if (isCombinedSearch(args)) {
        return makeQmdChild({ stream: "stderr", data: "unknown flag: -c", code: 1 });
      }
      if (args[0] === "search" || args[0] === "query" || args[0] === "vsearch") {
        return makeQmdChild();
      }
      return createMockChild();
    });

    const first = await createManager({ mode: "cli" });
    const firstDebug: MemorySearchRuntimeDebug[] = [];
    await first.manager.search("fact", {
      sessionKey: "agent:main:slack:dm:u123",
      onDebug: (entry) => {
        firstDebug.push(entry);
      },
    });
    await first.manager.close();

    expect(firstDebug.at(-1)?.qmd?.multiCollectionProbe).toMatchObject({
      cacheState: "write",
      supported: false,
    });

    spawnMock.mockClear();
    const second = await createManager({ mode: "cli" });
    const secondDebug: MemorySearchRuntimeDebug[] = [];
    await second.manager.search("fact", {
      sessionKey: "agent:main:slack:dm:u123",
      onDebug: (entry) => {
        secondDebug.push(entry);
      },
    });
    await second.manager.close();

    expect(countQmdCommand((args) => args[0] === "--help")).toBe(0);
    expect(countQmdCommand(isCombinedSearch)).toBe(0);
    expect(secondDebug.at(-1)?.qmd?.multiCollectionProbe).toMatchObject({
      cacheState: "hit",
      supported: false,
    });
  });

  it.each(abortSearchScenarios)("$name", runAbortSearchScenario);
});
