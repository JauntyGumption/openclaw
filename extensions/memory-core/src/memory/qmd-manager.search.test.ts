import {
  qmdCommandMatrixScenarios,
  runQmdCommandMatrixScenario,
} from "./qmd-manager.search-scenarios.test.support.js";
// Direct QMD search modes, retries, normalization, and queueing.
import {
  configureQmd,
  createDeferred,
  createManager,
  createMockChild,
  describe,
  expect,
  expectMockMessageContains,
  expectedQmdProvenance,
  fs,
  it,
  logWarnMock,
  makeQmdChild,
  path,
  spawnMock,
  tmpRoot,
  withLeaseMock,
  withMockedWindowsPlatform,
  writeLeaseCalls,
} from "./qmd-manager.test.support.js";

describe("QmdMemoryManager direct search", () => {
  it("uses configured qmd search mode command", async () => {
    configureQmd({ searchMode: "search" });
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        return makeQmdChild();
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }

    await expect(
      manager.search("test", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toStrictEqual([]);

    const searchCall = spawnMock.mock.calls.find(
      (call: unknown[]) => (call[1] as string[])?.[0] === "search",
    );
    expect(searchCall?.[1]).toEqual([
      "search",
      "test",
      "--json",
      "-n",
      String(resolved.qmd?.limits.maxResults),
      "-c",
      "workspace-main",
    ]);
    expect(
      spawnMock.mock.calls.some((call: unknown[]) => (call[1] as string[])?.[0] === "query"),
    ).toBe(false);
    expect(maxResults).toBeGreaterThan(0);
    await manager.close();
  });

  it("uses valid qmd query JSON captured before a non-zero exit", async () => {
    configureQmd({ searchMode: "query" });

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        queueMicrotask(() => {
          child.stdout.emit("data", "initializing qmd reranker\n");
          child.stdout.emit(
            "data",
            JSON.stringify(
              [
                {
                  file: "qmd://workspace-main/notes/welcome.md",
                  score: 0.93,
                  snippet: "@@ -7,1\nrouter glacier backup",
                },
              ],
              null,
              2,
            ),
          );
          child.stderr.emit("data", "ggml-metal-device.m:612 assertion failed");
          child.closeWith(134);
        });
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    await expect(
      manager.search("router glacier backup", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([
      {
        path: "notes/welcome.md",
        startLine: 7,
        endLine: 7,
        score: 0.93,
        snippet: "@@ -7,1\nrouter glacier backup",
        source: "memory",
        provenance: expectedQmdProvenance("untrusted"),
      },
    ]);
    expectMockMessageContains(
      logWarnMock,
      "qmd query exited non-zero after producing valid JSON; using captured search results (code 134)",
    );
    await manager.close();
  });

  it("keeps invalid qmd query stdout failed after a non-zero exit", async () => {
    configureQmd({ searchMode: "query" });

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "query") {
        return makeQmdChild({ data: "not json", code: 134 });
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    await expect(
      manager.search("router glacier backup", { sessionKey: "agent:main:slack:dm:u123" }),
    ).rejects.toThrow(/qmd query router glacier backup .* failed \(code 134\): not json/);
    await manager.close();
  });

  it("does not use qmd query JSON from a non-crash search failure", async () => {
    configureQmd({ searchMode: "query" });

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "query") {
        const child = createMockChild({ autoClose: false });
        queueMicrotask(() => {
          child.stdout.emit("data", "[]");
          child.stderr.emit("data", "SQLITE_BUSY: database is locked");
          child.closeWith(2);
        });
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    await expect(
      manager.search("router glacier backup", { sessionKey: "agent:main:slack:dm:u123" }),
    ).rejects.toThrow(/SQLITE_BUSY: database is locked/);
    expect(logWarnMock).not.toHaveBeenCalledWith(
      expect.stringContaining("using captured search results"),
    );
    await manager.close();
  });

  it("repairs missing managed collections and retries search once", async () => {
    configureQmd({ includeDefaultMemory: true, searchMode: "search", paths: [] });

    const expectedDocId = "abc123";
    let missingCollectionSeen = false;
    let addCallsAfterMissing = 0;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        return makeQmdChild();
      }
      if (args[0] === "collection" && args[1] === "add") {
        if (missingCollectionSeen) {
          addCallsAfterMissing += 1;
        }
        return createMockChild();
      }
      if (args[0] === "search") {
        const collectionFlagIndex = args.indexOf("-c");
        const collection = collectionFlagIndex >= 0 ? args[collectionFlagIndex + 1] : "";
        if (collection === "memory-root-main" && !missingCollectionSeen) {
          missingCollectionSeen = true;
          const child = createMockChild({ autoClose: false });
          queueMicrotask(() => {
            child.stdout.emit("data", "[]");
            child.stderr.emit("data", "Collection not found: memory-root-main");
            child.closeWith(1);
          });
          return child;
        }
        if (collection === "memory-root-main") {
          return makeQmdChild({
            data: JSON.stringify([
              { docid: expectedDocId, score: 1, snippet: "@@ -1,1\nremember this" },
            ]),
          });
        }
        return makeQmdChild();
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    withLeaseMock.mockClear();
    const inner = manager as unknown as {
      db: { prepare: (query: string) => { all: (arg: unknown) => unknown }; close: () => void };
    };
    inner.db = {
      prepare: (_query: string) => ({
        all: (arg: unknown) => {
          if (typeof arg === "string" && arg.startsWith(expectedDocId)) {
            return [{ collection: "memory-root-main", path: "MEMORY.md" }];
          }
          return [];
        },
      }),
      close: () => {},
    };

    const callerController = new AbortController();
    await expect(
      manager.search("remember", {
        sessionKey: "agent:main:slack:dm:u123",
        signal: callerController.signal,
      }),
    ).resolves.toEqual([
      {
        path: "MEMORY.md",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "@@ -1,1\nremember this",
        source: "memory",
        provenance: expectedQmdProvenance("agent"),
      },
    ]);
    expect(addCallsAfterMissing).toBeGreaterThan(0);
    expectMockMessageContains(logWarnMock, "repairing collections and retrying once");
    const repairLeases = writeLeaseCalls();
    expect(repairLeases.some(([options]) => options.signal?.aborted)).toBe(false);
    callerController.abort();
    expect(repairLeases.some(([options]) => options.signal?.aborted)).toBe(true);

    await manager.close();
  });

  it("resolves bare qmd command to a Windows-compatible spawn invocation", async () => {
    await withMockedWindowsPlatform(async () => {
      const previousPath = process.env.PATH;
      try {
        const nodeModulesDir = path.join(tmpRoot, "node_modules");
        const shimDir = path.join(nodeModulesDir, ".bin");
        const packageDir = path.join(nodeModulesDir, "qmd");
        const scriptPath = path.join(packageDir, "dist", "cli.js");
        await fs.mkdir(path.dirname(scriptPath), { recursive: true });
        await fs.mkdir(shimDir, { recursive: true });
        await fs.writeFile(path.join(shimDir, "qmd.cmd"), "@echo off\r\n", "utf8");
        await fs.writeFile(
          path.join(packageDir, "package.json"),
          JSON.stringify({ name: "qmd", version: "0.0.0", bin: { qmd: "dist/cli.js" } }),
          "utf8",
        );
        await fs.writeFile(scriptPath, "module.exports = {};\n", "utf8");
        process.env.PATH = `${shimDir};${previousPath ?? ""}`;

        const { manager } = await createManager({ mode: "status" });
        await manager.sync({ reason: "manual" });

        const qmdCalls = spawnMock.mock.calls.filter((call: unknown[]) => {
          const args = call[1] as string[] | undefined;
          return (
            Array.isArray(args) &&
            args.some((token) => token === "update" || token === "search" || token === "query")
          );
        });
        expect(qmdCalls.length).toBeGreaterThan(0);
        for (const call of qmdCalls) {
          const command = String(call[0]);
          const options = call[2] as { shell?: boolean } | undefined;
          expect(command).not.toMatch(/(^|[\\/])qmd\.cmd$/i);
          expect(options?.shell).not.toBe(true);
        }

        await manager.close();
      } finally {
        process.env.PATH = previousPath;
      }
    });
  });

  it("keeps mixed Han-script BM25 queries intact before qmd search", async () => {
    configureQmd({ searchMode: "search" });
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        return makeQmdChild();
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }

    await expect(
      manager.search("記憶系統升級 QMD", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toStrictEqual([]);

    const searchCall = spawnMock.mock.calls.find(
      (call: unknown[]) => (call[1] as string[])?.[0] === "search",
    );
    expect(searchCall?.[1]).toEqual([
      "search",
      "記憶系統升級 QMD",
      "--json",
      "-n",
      String(maxResults),
      "-c",
      "workspace-main",
    ]);
    await manager.close();
  });

  it("falls back to the original query when Han normalization yields no BM25 tokens", async () => {
    configureQmd({ searchMode: "search" });
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        return makeQmdChild();
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    await expect(manager.search("記", { sessionKey: "agent:main:slack:dm:u123" })).resolves.toEqual(
      [],
    );

    const searchCall = spawnMock.mock.calls.find(
      (call: unknown[]) => (call[1] as string[])?.[0] === "search",
    );
    expect(searchCall?.[1]?.[1]).toBe("記");
    await manager.close();
  });

  it("keeps spaced Han queries intact before qmd search", async () => {
    configureQmd({ searchMode: "search" });
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        return makeQmdChild();
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    const query = "自然 高级感 结论先行 搜索偏好";
    await expect(
      manager.search(query, { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toStrictEqual([]);

    const searchCall = spawnMock.mock.calls.find(
      (call: unknown[]) => (call[1] as string[])?.[0] === "search",
    );
    expect(searchCall?.[1]?.[1]).toBe(query);
    await manager.close();
  });

  it("keeps original Han queries in qmd query mode", async () => {
    configureQmd({ searchMode: "query" });
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "query") {
        return makeQmdChild();
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    await expect(
      manager.search("記憶系統升級 QMD", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toStrictEqual([]);

    const queryCall = spawnMock.mock.calls.find(
      (call: unknown[]) => (call[1] as string[])?.[0] === "query",
    );
    expect(queryCall?.[1]?.[1]).toBe("記憶系統升級 QMD");
    await manager.close();
  });

  it("retries search with qmd query when configured mode rejects flags", async () => {
    configureQmd({ searchMode: "search" });
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        return makeQmdChild({ stream: "stderr", data: "unknown flag: --json", code: 2 });
      }
      if (args[0] === "query") {
        return makeQmdChild();
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }

    await expect(
      manager.search("test", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toStrictEqual([]);

    const searchAndQueryCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1])
      .filter(
        (args): args is string[] => Array.isArray(args) && ["search", "query"].includes(args[0]),
      );
    expect(searchAndQueryCalls).toEqual([
      ["search", "test", "--json", "-n", String(maxResults), "-c", "workspace-main"],
      ["query", "test", "--json", "-n", String(maxResults), "-c", "workspace-main"],
    ]);
    await manager.close();
  });

  it("passes --no-rerank to direct qmd query when query reranking is disabled", async () => {
    configureQmd({ searchMode: "query", rerank: false });
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "query") {
        return makeQmdChild();
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }

    await expect(
      manager.search("test", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toStrictEqual([]);

    const queryCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "query");
    expect(queryCalls).toEqual([
      ["query", "test", "--json", "-n", String(maxResults), "--no-rerank", "-c", "workspace-main"],
    ]);
    await manager.close();
  });

  it("does not pass --no-rerank to direct query fallback from search mode", async () => {
    configureQmd({ searchMode: "search", rerank: false });
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search") {
        return makeQmdChild({ stream: "stderr", data: "unknown flag: --json", code: 2 });
      }
      if (args[0] === "query") {
        return makeQmdChild();
      }
      return createMockChild();
    });

    const { manager, resolved } = await createManager();
    const maxResults = resolved.qmd?.limits.maxResults;
    if (!maxResults) {
      throw new Error("qmd maxResults missing");
    }

    await expect(
      manager.search("test", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toStrictEqual([]);

    const searchAndQueryCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1])
      .filter(
        (args): args is string[] => Array.isArray(args) && ["search", "query"].includes(args[0]),
      );
    expect(searchAndQueryCalls).toEqual([
      ["search", "test", "--json", "-n", String(maxResults), "-c", "workspace-main"],
      ["query", "test", "--json", "-n", String(maxResults), "-c", "workspace-main"],
    ]);
    await manager.close();
  });

  it("queues a forced sync behind an in-flight update", async () => {
    configureQmd({
      searchMode: "query",
      update: { interval: "0s", debounceMs: 0, onBoot: false, updateTimeoutMs: 1_000 },
    });

    const firstUpdateSpawned = createDeferred<void>();
    let updateCalls = 0;
    let releaseFirstUpdate: (() => void) | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        updateCalls += 1;
        if (updateCalls === 1) {
          const first = createMockChild({ autoClose: false });
          releaseFirstUpdate = () => first.closeWith(0);
          firstUpdateSpawned.resolve();
          return first;
        }
        return createMockChild();
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    const inFlight = manager.sync({ reason: "interval" });
    const forced = manager.sync({ reason: "manual", force: true });

    await firstUpdateSpawned.promise;
    expect(updateCalls).toBe(1);
    if (!releaseFirstUpdate) {
      throw new Error("first update release missing");
    }
    (releaseFirstUpdate as () => void)();

    await Promise.all([inFlight, forced]);
    expect(updateCalls).toBe(2);
    await manager.close();
  });

  it("honors multiple forced sync requests while forced queue is active", async () => {
    configureQmd({
      update: { interval: "0s", debounceMs: 0, onBoot: false, updateTimeoutMs: 1_000 },
    });

    const firstUpdateSpawned = createDeferred<void>();
    const secondUpdateSpawned = createDeferred<void>();
    let updateCalls = 0;
    let releaseFirstUpdate: (() => void) | null = null;
    let releaseSecondUpdate: (() => void) | null = null;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        updateCalls += 1;
        if (updateCalls === 1) {
          const first = createMockChild({ autoClose: false });
          releaseFirstUpdate = () => first.closeWith(0);
          firstUpdateSpawned.resolve();
          return first;
        }
        if (updateCalls === 2) {
          const second = createMockChild({ autoClose: false });
          releaseSecondUpdate = () => second.closeWith(0);
          secondUpdateSpawned.resolve();
          return second;
        }
        return createMockChild();
      }
      return createMockChild();
    });

    const { manager } = await createManager();

    const inFlight = manager.sync({ reason: "interval" });
    const forcedOne = manager.sync({ reason: "manual", force: true });

    await firstUpdateSpawned.promise;
    expect(updateCalls).toBe(1);
    if (!releaseFirstUpdate) {
      throw new Error("first update release missing");
    }
    (releaseFirstUpdate as () => void)();

    await secondUpdateSpawned.promise;
    const forcedTwo = manager.sync({ reason: "manual-again", force: true });

    if (!releaseSecondUpdate) {
      throw new Error("second update release missing");
    }
    (releaseSecondUpdate as () => void)();

    await Promise.all([inFlight, forcedOne, forcedTwo]);
    expect(updateCalls).toBe(3);
    await manager.close();
  });

  it.each(qmdCommandMatrixScenarios)("$name", runQmdCommandMatrixScenario);
});
