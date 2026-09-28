// Mcporter QMD tools, result normalization, and daemon behavior.
import {
  MEMORY_SEARCH_DEADLINE_CONTROL,
  cfg,
  configureQmd,
  createManager,
  createMockChild,
  describe,
  emitAndClose,
  expect,
  expectMockMessageContains,
  expectMockMessageNotContains,
  expectedQmdProvenance,
  fs,
  isMcporterCommand,
  it,
  logWarnMock,
  makeMcporterChild,
  makeQmdChild,
  path,
  requireArgAfter,
  requireValue,
  spawnMock,
  tmpRoot,
  vi,
  withMockedWindowsPlatform,
  workspaceDir,
} from "./qmd-manager.test.support.js";
import type { OpenClawConfig } from "./qmd-manager.test.support.js";

describe("QmdMemoryManager mcporter search", () => {
  it("runs qmd searches via mcporter and warns when startDaemon=false", async () => {
    configureQmd({
      mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
    });

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      if (isMcporterCommand(cmd) && args[0] === "call") {
        return makeMcporterChild();
      }
      return makeQmdChild();
    });

    const { manager } = await createManager();

    logWarnMock.mockClear();
    await expect(
      manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toStrictEqual([]);

    const mcporterCalls = spawnMock.mock.calls.filter((call: unknown[]) =>
      isMcporterCommand(call[0]),
    );
    expect(mcporterCalls.length).toBeGreaterThan(0);
    expect(mcporterCalls.map((call: unknown[]) => (call[1] as string[])[0])).not.toContain(
      "daemon",
    );
    expectMockMessageContains(logWarnMock, "cold-start");

    await manager.close();
  });

  it("uses QMD 1.1+ query tool with searches array via mcporter", async () => {
    configureQmd({
      searchMode: "query",
      mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
    });

    const commandPhases: string[] = [];
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      if (isMcporterCommand(cmd) && args[0] === "call") {
        expect(commandPhases).toEqual(["pause"]);
        // Verify it calls qmd.query (v2) not qmd.deep_search (v1)
        expect(args[1]).toBe("qmd.query");
        const callArgs = JSON.parse(requireArgAfter(args, "--args"));
        // Verify QMD 1.1+ searches array format
        expect(callArgs).toHaveProperty("searches");
        expect(Array.isArray(callArgs.searches)).toBe(true);
        const searchTypes = callArgs.searches.map((search: { type?: unknown }) => search.type);
        expect(searchTypes).toContain("lex");
        expect(searchTypes).toContain("vec");
        expect(searchTypes).toContain("hyde");
        expect(callArgs).toHaveProperty("collections", ["workspace-main"]);
        // Should NOT have flat query/minScore (v1 format)
        expect(callArgs).not.toHaveProperty("query");
        expect(callArgs).not.toHaveProperty("minScore");
        expect(callArgs).not.toHaveProperty("collection");
        expect(callArgs).not.toHaveProperty("rerank");
        return makeMcporterChild();
      }
      return makeQmdChild();
    });

    const { manager } = await createManager();
    await manager.search("hello", {
      sessionKey: "agent:main:slack:dm:u123",
      [MEMORY_SEARCH_DEADLINE_CONTROL]: (action) => {
        commandPhases.push(action);
      },
    });
    expect(commandPhases).toEqual(["pause", "resume"]);
    await manager.close();
  });

  it("passes rerank false to QMD 1.1+ query tool via mcporter when query reranking is disabled", async () => {
    configureQmd({
      searchMode: "query",
      rerank: false,
      mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
    });

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      if (isMcporterCommand(cmd) && args[0] === "call") {
        expect(args[1]).toBe("qmd.query");
        const callArgs = JSON.parse(requireArgAfter(args, "--args"));
        expect(callArgs).toMatchObject({
          searches: [
            { type: "lex", query: "hello" },
            { type: "vec", query: "hello" },
            { type: "hyde", query: "hello" },
          ],
          limit: expect.any(Number),
          collections: ["workspace-main"],
          rerank: false,
        });
        return makeMcporterChild();
      }
      return makeQmdChild();
    });

    const { manager } = await createManager();
    await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });
    await manager.close();
  });

  it("disables the LLM reranker (rerank:false) for vsearch mode via mcporter", async () => {
    configureQmd({
      searchMode: "vsearch",
      mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
    });

    let captured: Record<string, unknown> | null = null;
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      if (isMcporterCommand(cmd) && args[0] === "call") {
        captured = JSON.parse(requireArgAfter(args, "--args"));
        return makeMcporterChild();
      }
      return makeQmdChild();
    });

    const { manager } = await createManager();
    await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });
    await manager.close();

    expect(captured).not.toBeNull();
    const sentArgs = captured as unknown as Record<string, unknown>;
    // vsearch is a vector-only mode (see buildV2Searches) — it must NOT trigger
    // QMD's LLM reranker, which the "query" tool enables by default.
    expect(sentArgs.rerank).toBe(false);
    const searchTypes = (sentArgs.searches as Array<{ type?: unknown }>).map((s) => s.type);
    expect(searchTypes).toEqual(["vec"]);
  });

  it("keeps hyphenated tokens in lexical QMD searches while normalizing semantic searches", async () => {
    configureQmd({
      searchMode: "query",
      mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
    });

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      if (isMcporterCommand(cmd) && args[0] === "call") {
        expect(args[1]).toBe("qmd.query");
        const callArgs = JSON.parse(requireArgAfter(args, "--args"));
        expect(callArgs.searches).toEqual([
          { type: "lex", query: "sqlite-vec-qmd backend health 2026-05-04 multi-agent" },
          { type: "vec", query: "sqlite vec qmd backend health 2026 05 04 multi agent" },
          { type: "hyde", query: "sqlite vec qmd backend health 2026 05 04 multi agent" },
        ]);
        return makeMcporterChild();
      }
      return makeQmdChild();
    });

    const { manager } = await createManager();
    await manager.search("sqlite-vec-qmd backend health 2026-05-04 multi-agent", {
      sessionKey: "agent:main:slack:dm:u123",
    });
    await manager.close();
  });

  it("normalizes hyphenated tokens for vector-only QMD searches", async () => {
    configureQmd({
      searchMode: "vsearch",
      mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
    });

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      if (isMcporterCommand(cmd) && args[0] === "call") {
        expect(args[1]).toBe("qmd.query");
        const callArgs = JSON.parse(requireArgAfter(args, "--args"));
        expect(callArgs.searches).toEqual([{ type: "vec", query: "sqlite vec backend health" }]);
        return makeMcporterChild();
      }
      return makeQmdChild();
    });

    const { manager } = await createManager();
    await manager.search("sqlite-vec backend health", {
      sessionKey: "agent:main:slack:dm:u123",
    });
    await manager.close();
  });

  it("wraps non-JSON mcporter stdout as a typed error instead of a raw SyntaxError", async () => {
    configureQmd({
      searchMode: "query",
      mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
    });

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      if (isMcporterCommand(cmd) && args[0] === "call") {
        // mcporter exits 0 but prints non-JSON to stdout (daemon warning, truncated
        // output, or CLI flag mismatch). Without the guard this throws a raw
        // SyntaxError out of runQmdSearchViaMcporter; the guard wraps it.
        return makeQmdChild({ data: "mcporter: daemon warning: connection unstable\n" });
      }
      return makeQmdChild();
    });

    const { manager } = await createManager();
    await expect(
      manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" }),
    ).rejects.toThrow(/non-JSON stdout/i);
    await manager.close();
  });

  it("falls back to QMD <1.1 tool names when query tool is not found", async () => {
    // qmdMcpToolVersion is an instance field — each createManager() starts fresh.

    configureQmd({
      searchMode: "query",
      mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
    });

    let callCount = 0;
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        callCount++;
        const toolSelector = args[1];
        if (toolSelector === "qmd.query") {
          // Simulate QMD <1.1 — "query" tool does not exist
          // The error message appears in stdout (mcporter wraps MCP errors in JSON output)
          queueMicrotask(() => {
            child.stderr.emit("data", "MCP error -32602: Tool query not found");
            child.closeWith(1);
          });
          return child;
        }
        if (toolSelector === "qmd.deep_search") {
          // v1 tool exists — verify v1 args format
          const callArgs = JSON.parse(requireArgAfter(args, "--args"));
          expect(callArgs).toHaveProperty("query");
          expect(callArgs).not.toHaveProperty("searches");
          // Return empty results (avoids needing a SQLite fixture)
          emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
          return child;
        }
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    // The first search should try v2, fail, then retry with v1
    await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });

    // Should have logged the v1 fallback warning
    expectMockMessageContains(logWarnMock, "falling back to v1 tool names");

    // One v2 attempt (fails) + one v1 retry (succeeds) per collection
    expect(callCount).toBe(2);

    await manager.close();
  });

  it("uses an explicit mcporter search tool override with flat query args", async () => {
    configureQmd({
      searchMode: "query",
      searchTool: "hybrid_search",
      mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
    });

    let expectedLimit = 0;
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        expect(args[1]).toBe("qmd.hybrid_search");
        const callArgs = JSON.parse(requireArgAfter(args, "--args"));
        expect(callArgs.query).toBe("hello");
        expect(callArgs.limit).toBe(expectedLimit);
        expect(callArgs.minScore).toBe(0);
        expect(callArgs.collection).toBe("workspace-main");
        expect(callArgs).not.toHaveProperty("searches");
        expect(callArgs).not.toHaveProperty("collections");
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager, resolved } = await createManager();
    expectedLimit = resolved.qmd?.limits.maxResults ?? 0;
    await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });
    await manager.close();
  });

  it("prefers mcporter start and end lines over snippet header offsets", async () => {
    const expectedDocId = "line-123";
    configureQmd({
      searchMode: "query",
      mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
    });

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        expect(args[1]).toBe("qmd.query");
        emitAndClose(
          child,
          "stdout",
          JSON.stringify({
            results: [
              {
                docid: expectedDocId,
                score: 0.91,
                collection: "workspace-main",
                start_line: 8,
                end_line: 10,
                snippet:
                  "@@ -20,3\nline one\nline two\nline three <!-- project: github.com/acme/Alpha -->",
              },
            ],
          }),
        );
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    const inner = manager as unknown as {
      db: { prepare: (query: string) => { all: (arg: unknown) => unknown }; close: () => void };
    };
    inner.db = {
      prepare: (_query: string) => ({
        all: (arg: unknown) => {
          if (typeof arg === "string" && arg.startsWith(expectedDocId)) {
            return [{ collection: "workspace-main", path: "notes/welcome.md" }];
          }
          return [];
        },
      }),
      close: () => {},
    };

    await expect(
      manager.search("line one", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([
      {
        path: "notes/welcome.md",
        startLine: 8,
        endLine: 10,
        score: 0.91,
        snippet: "@@ -20,3\nline one\nline two\nline three <!-- project: github.com/acme/Alpha -->",
        source: "memory",
        provenance: expectedQmdProvenance("untrusted"),
      },
    ]);

    await manager.close();
  });

  it("keeps per-result and aggregate QMD snippet limits UTF-16 safe", async () => {
    const expectedDocId = "unicode-boundary";
    const snippet = "@@ -1,1\nabc😀tail";
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        emitAndClose(
          child,
          "stdout",
          JSON.stringify({
            results: [
              {
                docid: expectedDocId,
                score: 0.91,
                collection: "workspace-main",
                snippet,
              },
            ],
          }),
        );
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const searchWithLimits = async (limits: {
      maxSnippetChars: number;
      maxInjectedChars: number;
    }) => {
      const testConfig = {
        ...cfg,
        memory: {
          backend: "qmd",
          qmd: {
            includeDefaultMemory: false,
            searchMode: "query",
            update: { interval: "0s", debounceMs: 60_000, onBoot: false },
            paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
            limits,
            mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
          },
        },
      } as OpenClawConfig;
      const { manager } = await createManager({ cfg: testConfig });
      const inner = manager as unknown as {
        db: { prepare: () => { all: () => unknown }; close: () => void };
      };
      inner.db = {
        prepare: () => ({
          all: () => [{ collection: "workspace-main", path: "notes/unicode.md" }],
        }),
        close: () => {},
      };
      const results = await manager.search("unicode", {
        sessionKey: "agent:main:slack:dm:u123",
      });
      await manager.close();
      return results;
    };

    await expect(searchWithLimits({ maxSnippetChars: 12, maxInjectedChars: 100 })).resolves.toEqual(
      [expect.objectContaining({ snippet: "@@ -1,1\nabc" })],
    );
    await expect(searchWithLimits({ maxSnippetChars: 100, maxInjectedChars: 12 })).resolves.toEqual(
      [expect.objectContaining({ snippet: "@@ -1,1\nabc" })],
    );
  });

  it("uses snippet header width when mcporter only returns a start line", async () => {
    const expectedDocId = "line-456";
    configureQmd({
      searchMode: "query",
      mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
    });

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        expect(args[1]).toBe("qmd.query");
        emitAndClose(
          child,
          "stdout",
          JSON.stringify({
            results: [
              {
                docid: expectedDocId,
                score: 0.73,
                collection: "workspace-main",
                start_line: 8,
                snippet: "@@ -20,3\nline one\nline two\nline three",
              },
            ],
          }),
        );
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    const inner = manager as unknown as {
      db: { prepare: (query: string) => { all: (arg: unknown) => unknown }; close: () => void };
    };
    inner.db = {
      prepare: (_query: string) => ({
        all: (arg: unknown) => {
          if (typeof arg === "string" && arg.startsWith(expectedDocId)) {
            return [{ collection: "workspace-main", path: "notes/welcome.md" }];
          }
          return [];
        },
      }),
      close: () => {},
    };

    await expect(
      manager.search("line one", { sessionKey: "agent:main:slack:dm:u123" }),
    ).resolves.toEqual([
      {
        path: "notes/welcome.md",
        startLine: 8,
        endLine: 10,
        score: 0.73,
        snippet: "@@ -20,3\nline one\nline two\nline three",
        source: "memory",
        provenance: expectedQmdProvenance("untrusted"),
      },
    ]);

    await manager.close();
  });

  it('uses unified v2 args when the explicit mcporter search tool override is "query"', async () => {
    configureQmd({
      searchMode: "search",
      searchTool: "query",
      mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
    });

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        expect(args[1]).toBe("qmd.query");
        const callArgs = JSON.parse(requireArgAfter(args, "--args"));
        expect(callArgs).toHaveProperty("searches", [{ type: "lex", query: "hello" }]);
        expect(callArgs).toHaveProperty("collections", ["workspace-main"]);
        expect(callArgs).not.toHaveProperty("query");
        expect(callArgs).not.toHaveProperty("minScore");
        expect(callArgs).not.toHaveProperty("collection");
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });
    await manager.close();
  });

  it('passes rerank false when explicit mcporter search tool override is "query"', async () => {
    configureQmd({
      searchMode: "query",
      searchTool: "query",
      rerank: false,
      mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
    });

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        expect(args[1]).toBe("qmd.query");
        const callArgs = JSON.parse(requireArgAfter(args, "--args"));
        expect(callArgs).toMatchObject({
          searches: [
            { type: "lex", query: "hello" },
            { type: "vec", query: "hello" },
            { type: "hyde", query: "hello" },
          ],
          collections: ["workspace-main"],
          rerank: false,
        });
        expect(callArgs).not.toHaveProperty("query");
        expect(callArgs).not.toHaveProperty("minScore");
        expect(callArgs).not.toHaveProperty("collection");
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });
    await manager.close();
  });

  it('reuses the cached v1 tool across collections when the explicit mcporter override is "query"', async () => {
    configureQmd({
      searchMode: "search",
      searchTool: "query",
      paths: [
        { path: path.join(workspaceDir, "notes-a"), pattern: "**/*.md", name: "workspace-a" },
        { path: path.join(workspaceDir, "notes-b"), pattern: "**/*.md", name: "workspace-b" },
      ],
      mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
    });

    const selectors: string[] = [];
    let expectedLimit = 0;
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        const selector = args[1] ?? "";
        selectors.push(selector);
        if (selector === "qmd.query") {
          queueMicrotask(() => {
            child.stderr.emit("data", "MCP error -32602: Tool query not found");
            child.closeWith(1);
          });
          return child;
        }
        const callArgs = JSON.parse(requireArgAfter(args, "--args"));
        expect(selector).toBe("qmd.search");
        expect(callArgs.query).toBe("hello");
        expect(callArgs.limit).toBe(expectedLimit);
        expect(callArgs.minScore).toBe(0);
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager, resolved } = await createManager();
    expectedLimit = resolved.qmd?.limits.maxResults ?? 0;
    await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });

    expect(selectors).toEqual(["qmd.query", "qmd.search", "qmd.search"]);

    await manager.close();
  });

  it("uses an explicit mcporter search tool override across multiple collections", async () => {
    configureQmd({
      searchMode: "query",
      searchTool: "hybrid_search",
      paths: [
        { path: path.join(workspaceDir, "notes-a"), pattern: "**/*.md", name: "workspace-a" },
        { path: path.join(workspaceDir, "notes-b"), pattern: "**/*.md", name: "workspace-b" },
      ],
      mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
    });

    const selectors: string[] = [];
    const collections: string[] = [];
    let expectedLimit = 0;
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        selectors.push(args[1] ?? "");
        const callArgs = JSON.parse(requireArgAfter(args, "--args"));
        collections.push(String(callArgs.collection ?? ""));
        expect(callArgs.query).toBe("hello");
        expect(callArgs.limit).toBe(expectedLimit);
        expect(callArgs.minScore).toBe(0);
        expect(callArgs).not.toHaveProperty("searches");
        expect(callArgs).not.toHaveProperty("collections");
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager, resolved } = await createManager();
    expectedLimit = resolved.qmd?.limits.maxResults ?? 0;
    await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });

    expect(selectors).toEqual(["qmd.hybrid_search", "qmd.hybrid_search"]);
    expect(collections).toEqual(["workspace-a-main", "workspace-b-main"]);

    await manager.close();
  });

  it("does not pin v1 fallback when only the serialized query text contains tool-not-found words", async () => {
    configureQmd({
      searchMode: "query",
      mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
    });

    const selectors: string[] = [];
    let firstQueryCall = true;
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        selectors.push(args[1] ?? "");
        if (args[1] === "qmd.query" && firstQueryCall) {
          firstQueryCall = false;
          queueMicrotask(() => {
            child.stderr.emit("data", "backend unavailable");
            child.closeWith(1);
          });
          return child;
        }
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();

    await expect(
      manager.search("abc: Tool query not found", {
        sessionKey: "agent:main:slack:dm:u123",
      }),
    ).resolves.toStrictEqual([]);

    await manager.search("hello again", { sessionKey: "agent:main:slack:dm:u123" });

    expect(selectors.length).toBeGreaterThanOrEqual(2);
    expect(selectors.every((selector) => selector === "qmd.query")).toBe(true);
    expectMockMessageNotContains(logWarnMock, "falling back to v1 tool names");

    await manager.close();
  });

  it("does not pin v1 fallback when a timed out query contains tool-not-found words", async () => {
    configureQmd({
      searchMode: "query",
      mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
    });

    const selectors: string[] = [];
    let firstQueryCall = true;
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      const child = createMockChild({ autoClose: false });
      if (isMcporterCommand(cmd) && args[0] === "call") {
        selectors.push(args[1] ?? "");
        if (args[1] === "qmd.query" && firstQueryCall) {
          firstQueryCall = false;
          return child;
        }
        emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
        return child;
      }
      emitAndClose(child, "stdout", "[]");
      return child;
    });

    const { manager } = await createManager();
    const commandClient = (
      manager as object as {
        commands: {
          runMcporter: (
            args: string[],
            opts?: { timeoutMs?: number; signal?: AbortSignal },
          ) => Promise<{ stdout: string; stderr: string }>;
        };
      }
    ).commands;
    const originalRunMcporter = commandClient.runMcporter.bind(commandClient);
    let injectTimeoutOnce = true;
    const runMcporterSpy = vi
      .spyOn(commandClient, "runMcporter")
      .mockImplementation(async (...args) => {
        if (injectTimeoutOnce) {
          injectTimeoutOnce = false;
          firstQueryCall = false;
          throw new Error(
            'mcporter call qmd.query --args {"query":"abc: Tool query not found"} timed out after 5000ms',
          );
        }
        return await originalRunMcporter(...args);
      });

    await expect(
      manager.search("abc: Tool query not found", {
        sessionKey: "agent:main:slack:dm:u123",
      }),
    ).rejects.toThrow("timed out after 5000ms");

    await manager.search("hello again", { sessionKey: "agent:main:slack:dm:u123" });

    expect(runMcporterSpy).toHaveBeenCalled();
    expect(selectors.length).toBeGreaterThanOrEqual(1);
    expect(selectors.every((selector) => selector === "qmd.query")).toBe(true);
    expectMockMessageNotContains(logWarnMock, "falling back to v1 tool names");

    runMcporterSpy.mockRestore();
    await manager.close();
  });

  it("resolves mcporter to a direct Windows entrypoint without enabling shell mode", async () => {
    await withMockedWindowsPlatform(async () => {
      const previousPath = process.env.PATH;
      try {
        const nodeModulesDir = path.join(tmpRoot, "node_modules");
        const shimDir = path.join(nodeModulesDir, ".bin");
        const packageDir = path.join(nodeModulesDir, "mcporter");
        const scriptPath = path.join(packageDir, "dist", "cli.js");
        await fs.mkdir(path.dirname(scriptPath), { recursive: true });
        await fs.mkdir(shimDir, { recursive: true });
        await fs.writeFile(path.join(shimDir, "mcporter.cmd"), "@echo off\r\n", "utf8");
        await fs.writeFile(
          path.join(packageDir, "package.json"),
          JSON.stringify({ name: "mcporter", version: "0.0.0", bin: { mcporter: "dist/cli.js" } }),
          "utf8",
        );
        await fs.writeFile(scriptPath, "module.exports = {};\n", "utf8");
        process.env.PATH = `${shimDir};${previousPath ?? ""}`;

        configureQmd({
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        });

        spawnMock.mockImplementation((_cmd: string, args: string[]) => {
          const child = createMockChild({ autoClose: false });
          if (args[0] === "call") {
            emitAndClose(child, "stdout", JSON.stringify({ results: [] }));
            return child;
          }
          emitAndClose(child, "stdout", "[]");
          return child;
        });

        const { manager } = await createManager();
        await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });

        const mcporterCall = spawnMock.mock.calls.find((call: unknown[]) =>
          (call[1] as string[] | undefined)?.includes("call"),
        );
        const searchCall = requireValue(mcporterCall, "mcporter search call missing");
        const callCommand = searchCall[0];
        expect(typeof callCommand).toBe("string");
        const options = searchCall[2] as { shell?: boolean } | undefined;
        expect(callCommand).not.toBe("mcporter.cmd");
        expect(options?.shell).not.toBe(true);

        await manager.close();
      } finally {
        process.env.PATH = previousPath;
      }
    });
  });

  it("fails closed on Windows EINVAL cmd-shim failures instead of retrying through the shell", async () => {
    await withMockedWindowsPlatform(async () => {
      const previousPath = process.env.PATH;
      try {
        const shimDir = await fs.mkdtemp(path.join(tmpRoot, "mcporter-shim-"));
        await fs.writeFile(path.join(shimDir, "mcporter.cmd"), "@echo off\n");
        process.env.PATH = `${shimDir};${previousPath ?? ""}`;

        configureQmd({
          mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
        });

        let firstCallCommand: string | null = null;
        spawnMock.mockImplementation((cmd: string, args: string[]) => {
          if (args[0] === "call" && firstCallCommand === null) {
            firstCallCommand = cmd;
          }
          if (args[0] === "call" && typeof cmd === "string" && cmd.toLowerCase().endsWith(".cmd")) {
            const child = createMockChild({ autoClose: false });
            queueMicrotask(() => {
              const err = Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" });
              child.emit("error", err);
            });
            return child;
          }
          return makeQmdChild();
        });

        const { manager } = await createManager();
        await expect(
          manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" }),
        ).rejects.toThrow(/without shell execution|EINVAL/);
        const attemptedCmdShim = (firstCallCommand ?? "").toLowerCase().endsWith(".cmd");
        if (attemptedCmdShim) {
          expect(
            spawnMock.mock.calls.some(
              (call: unknown[]) =>
                call[0] === "mcporter" &&
                (call[2] as { shell?: boolean } | undefined)?.shell === true,
            ),
          ).toBe(false);
        }
        await manager.close();
      } finally {
        process.env.PATH = previousPath;
      }
    });
  });

  it("passes manager-scoped XDG env to mcporter commands", async () => {
    configureQmd({
      mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
    });

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      if (isMcporterCommand(cmd) && args[0] === "call") {
        return makeMcporterChild();
      }
      return makeQmdChild();
    });

    const { manager } = await createManager();
    await manager.search("hello", { sessionKey: "agent:main:slack:dm:u123" });

    const mcporterCall = spawnMock.mock.calls.find(
      (call: unknown[]) => isMcporterCommand(call[0]) && (call[1] as string[])[0] === "call",
    );
    const searchCall = requireValue(mcporterCall, "mcporter search call missing");
    const spawnOpts = searchCall[2] as { env?: NodeJS.ProcessEnv } | undefined;
    const normalizePath = (value?: string) => value?.replace(/\\/g, "/");
    expect(normalizePath(spawnOpts?.env?.XDG_CONFIG_HOME)).toContain("/agents/main/qmd/xdg-config");
    expect(normalizePath(spawnOpts?.env?.QMD_CONFIG_DIR)).toContain(
      "/agents/main/qmd/xdg-config/qmd",
    );
    expect(normalizePath(spawnOpts?.env?.XDG_CACHE_HOME)).toContain("/agents/main/qmd/xdg-cache");
    expect(spawnOpts?.env?.PATH?.split(path.delimiter)).toContain(path.dirname(process.execPath));

    await manager.close();
  });

  it("retries mcporter daemon start after a failure", async () => {
    configureQmd({
      mcporter: { enabled: true, serverName: "qmd", startDaemon: true },
    });

    let daemonAttempts = 0;
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      if (isMcporterCommand(cmd) && args[0] === "daemon") {
        daemonAttempts += 1;
        return daemonAttempts === 1
          ? makeQmdChild({ stream: "stderr", data: "failed", code: 1 })
          : makeQmdChild({ data: "" });
      }
      if (isMcporterCommand(cmd) && args[0] === "call") {
        return makeMcporterChild();
      }
      return makeQmdChild();
    });

    const { manager } = await createManager();

    await manager.search("one", { sessionKey: "agent:main:slack:dm:u123" });
    await manager.search("two", { sessionKey: "agent:main:slack:dm:u123" });

    expect(daemonAttempts).toBe(2);

    await manager.close();
  });

  it("starts the mcporter daemon only once when enabled", async () => {
    configureQmd({
      mcporter: { enabled: true, serverName: "qmd", startDaemon: true },
    });

    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      if (isMcporterCommand(cmd) && args[0] === "daemon") {
        return makeQmdChild({ data: "" });
      }
      if (isMcporterCommand(cmd) && args[0] === "call") {
        return makeMcporterChild();
      }
      return makeQmdChild();
    });

    const { manager } = await createManager();

    await manager.search("one", { sessionKey: "agent:main:slack:dm:u123" });
    await manager.search("two", { sessionKey: "agent:main:slack:dm:u123" });

    const daemonStarts = spawnMock.mock.calls.filter(
      (call: unknown[]) => isMcporterCommand(call[0]) && (call[1] as string[])[0] === "daemon",
    );
    expect(daemonStarts).toHaveLength(1);

    await manager.close();
  });
});
