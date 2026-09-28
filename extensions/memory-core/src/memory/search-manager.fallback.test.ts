// Stage 1 CI verification touch; no test semantics changed.
// Search-manager fallback, cancellation, races, and teardown behavior.
import {
  MEMORY_SEARCH_DEADLINE_CONTROL,
  closeAllMemorySearchManagers,
  closeMemorySearchManager,
  createBuiltinCfg,
  createDeferred,
  createFailedQmdSearchHarness,
  createQmdCfg,
  createQmdManagerInstanceMock,
  createQmdManagerMock,
  describe,
  expect,
  fallbackManager,
  fallbackSearch,
  getMemorySearchManager,
  it,
  mockCloseAllMemoryIndexManagers,
  mockCloseMemoryIndexManagersForAgent,
  mockMemoryIndexGet,
  mockPrimary,
  requireManager,
  runMemorySearchWithDeadline,
  vi,
} from "./search-manager.test.support.js";
import type {
  ManagerSearchParams,
  MemorySearchDeadlineControlOptions,
  QmdManagerInstance,
  SearchManager,
} from "./search-manager.test.support.js";

describe("getMemorySearchManager fallback and teardown", () => {
  it("falls back to builtin search when qmd fails with sqlite busy", async () => {
    const retryAgentId = "retry-agent-busy";
    const { manager: firstManager } = await createFailedQmdSearchHarness({
      agentId: retryAgentId,
      errorMessage: "qmd index busy while reading results: SQLITE_BUSY: database is locked",
    });

    const results = await firstManager.search("hello");
    expect(results).toHaveLength(1);
    expect(results[0]?.path).toBe("MEMORY.md");
    expect(fallbackSearch).toHaveBeenCalledTimes(1);
  });

  it("does not activate builtin when fail-closed qmd search fails", async () => {
    const agentId = "qmd-fail-closed-search";
    const cfg = createQmdCfg(agentId, "/tmp/workspace", { fallback: "none" });
    mockPrimary.search.mockRejectedValueOnce(new Error("qmd query failed"));
    const manager = requireManager(await getMemorySearchManager({ cfg, agentId }));

    await expect(manager.search("hello")).rejects.toThrow("qmd query failed");

    expect(mockMemoryIndexGet).not.toHaveBeenCalled();
    expect(fallbackSearch).not.toHaveBeenCalled();
  });

  it("does not activate builtin for a missing optional qmd project-list capability", async () => {
    const agentId = "qmd-fail-closed-project-list-missing";
    const cfg = createQmdCfg(agentId, "/tmp/workspace", { fallback: "none" });
    const original = mockPrimary.listCuratedProjectCandidates;
    Reflect.deleteProperty(mockPrimary, "listCuratedProjectCandidates");

    try {
      const manager = requireManager(await getMemorySearchManager({ cfg, agentId }));
      const results = await manager.listCuratedProjectCandidates?.({
        activeProjectKeys: ["github.com/openclaw/openclaw"],
        limit: 3,
      });

      expect(results).toStrictEqual([]);
      expect(mockMemoryIndexGet).not.toHaveBeenCalled();
      expect(mockPrimary.search).not.toHaveBeenCalled();
    } finally {
      Object.assign(mockPrimary, { listCuratedProjectCandidates: original });
    }
  });

  it("does not activate builtin when fail-closed curated project listing fails", async () => {
    const agentId = "qmd-fail-closed-project-list-error";
    const cfg = createQmdCfg(agentId, "/tmp/workspace", { fallback: "none" });
    mockPrimary.listCuratedProjectCandidates.mockRejectedValueOnce(
      new Error("qmd project listing failed"),
    );
    const manager = requireManager(await getMemorySearchManager({ cfg, agentId }));

    const results = await manager.listCuratedProjectCandidates?.({
      activeProjectKeys: ["github.com/openclaw/openclaw"],
      limit: 3,
    });

    expect(results).toStrictEqual([]);
    expect(mockMemoryIndexGet).not.toHaveBeenCalled();
  });

  it("falls back to builtin when curated project listing fails", async () => {
    const agentId = "project-list-fallback";
    const cfg = createQmdCfg(agentId);
    mockPrimary.listCuratedProjectCandidates.mockRejectedValueOnce(
      new Error("qmd project listing failed"),
    );
    const manager = requireManager(await getMemorySearchManager({ cfg, agentId }));

    const results = await manager.listCuratedProjectCandidates?.({
      activeProjectKeys: ["github.com/openclaw/openclaw"],
      limit: 3,
    });

    expect(results).toHaveLength(1);
    expect(fallbackManager.listCuratedProjectCandidates).toHaveBeenCalledWith({
      activeProjectKeys: ["github.com/openclaw/openclaw"],
      limit: 3,
    });
  });

  it("does not wait for failed qmd retirement before starting builtin fallback", async () => {
    const retryAgentId = "retry-agent-slow-retirement";
    const { manager: firstManager } = await createFailedQmdSearchHarness({
      agentId: retryAgentId,
      errorMessage: "qmd query failed",
    });
    const retirementGate = createDeferred<void>();
    mockPrimary.close.mockImplementationOnce(async () => await retirementGate.promise);
    const onDebug = vi.fn();

    try {
      const results = await firstManager.search("hello", { onDebug });

      expect(results).toHaveLength(1);
      expect(onDebug).toHaveBeenCalledWith({ backend: "builtin" });
      expect(mockPrimary.close).toHaveBeenCalledTimes(1);
      expect(fallbackSearch).toHaveBeenCalledTimes(1);
    } finally {
      retirementGate.resolve();
      mockPrimary.close.mockImplementation(async () => {});
    }
  });

  it("signals builtin fallback to calls queued behind the failed qmd primary", async () => {
    const retryAgentId = "retry-agent-concurrent-fallback";
    const { manager: firstManager } = await createFailedQmdSearchHarness({
      agentId: retryAgentId,
      errorMessage: "qmd query failed",
    });
    const fallbackGate = createDeferred<typeof fallbackManager>();
    mockMemoryIndexGet.mockImplementation(async () => await fallbackGate.promise);
    const firstDebug = vi.fn();
    const secondDebug = vi.fn();

    const firstSearch = firstManager.search("first", { onDebug: firstDebug });
    await vi.waitFor(() => expect(firstDebug).toHaveBeenCalledWith({ backend: "builtin" }));
    const secondSearch = firstManager.search("second", { onDebug: secondDebug });
    await vi.waitFor(() => expect(secondDebug).toHaveBeenCalledWith({ backend: "builtin" }));

    fallbackGate.resolve(fallbackManager);
    await expect(Promise.all([firstSearch, secondSearch])).resolves.toHaveLength(2);
    expect(fallbackSearch).toHaveBeenCalledTimes(2);
  });

  it("lets a sibling admitted primary search finish while the failed primary retires", async () => {
    const agentId = "qmd-concurrent-primary-retirement";
    const cfg = createQmdCfg(agentId, "/tmp/workspace", { fallback: "none" });
    const failingSearchGate = createDeferred<void>();
    const siblingSearchGate = createDeferred<[]>();
    let call = 0;
    mockPrimary.search.mockImplementation(async () => {
      call += 1;
      if (call === 1) {
        await failingSearchGate.promise;
        throw new Error("qmd query failed");
      }
      return await siblingSearchGate.promise;
    });
    const manager = requireManager(await getMemorySearchManager({ cfg, agentId }));

    const failing = manager.search("first");
    const sibling = manager.search("second");
    await vi.waitFor(() => expect(mockPrimary.search).toHaveBeenCalledTimes(2));

    failingSearchGate.resolve();
    await expect(failing).rejects.toThrow("qmd query failed");
    await vi.waitFor(() => expect(mockPrimary.close).toHaveBeenCalledTimes(1));

    siblingSearchGate.resolve([]);
    await expect(sibling).resolves.toStrictEqual([]);
    expect(mockMemoryIndexGet).not.toHaveBeenCalled();
  });

  it("joins and closes builtin fallback creation during wrapper teardown", async () => {
    const agentId = "fallback-create-close-race";
    const { manager } = await createFailedQmdSearchHarness({
      agentId,
      errorMessage: "qmd query failed",
    });
    const fallbackGate = createDeferred<typeof fallbackManager>();
    mockMemoryIndexGet.mockImplementationOnce(async () => await fallbackGate.promise);

    const searchPromise = manager.search("hello");
    await vi.waitFor(() => expect(mockMemoryIndexGet).toHaveBeenCalledTimes(1));
    const closePromise = manager.close?.() ?? Promise.resolve();
    fallbackGate.resolve(fallbackManager);

    await closePromise;
    await expect(searchPromise).rejects.toThrow("memory search manager is closed");
    expect(fallbackManager.close).toHaveBeenCalledTimes(1);
  });

  it("does not start fallback creation after wrapper teardown begins", async () => {
    const agentId = "fallback-after-close-race";
    const primarySearchGate = createDeferred<void>();
    mockPrimary.search.mockImplementationOnce(async () => {
      await primarySearchGate.promise;
      throw new Error("qmd query failed");
    });
    const cfg = createQmdCfg(agentId);
    const manager = requireManager(await getMemorySearchManager({ cfg, agentId }));
    const primaryCloseGate = createDeferred<void>();
    mockPrimary.close.mockImplementation(async () => await primaryCloseGate.promise);

    const searchPromise = manager.search("hello");
    await vi.waitFor(() => expect(mockPrimary.search).toHaveBeenCalledTimes(1));
    const closePromise = manager.close?.() ?? Promise.resolve();
    primarySearchGate.resolve();
    await vi.waitFor(() => expect(mockPrimary.close).toHaveBeenCalled());

    primaryCloseGate.resolve();
    await closePromise;
    await expect(searchPromise).rejects.toThrow("memory search manager is closed");
    expect(mockMemoryIndexGet).not.toHaveBeenCalled();
  });

  it("gives same-call qmd-to-builtin fallback a fresh default deadline", async () => {
    vi.useFakeTimers();
    try {
      const retryAgentId = "retry-agent-fallback-timeout";
      const { manager: firstManager } = await createFailedQmdSearchHarness({
        agentId: retryAgentId,
        errorMessage: "qmd query failed",
      });
      mockPrimary.search.mockReset();
      mockPrimary.search.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 10_000);
        });
        throw new Error("qmd query failed");
      });
      let fallbackSignal: AbortSignal | undefined;
      fallbackSearch.mockImplementationOnce(
        async (_query: string, opts?: Parameters<SearchManager["search"]>[1]) => {
          fallbackSignal = opts?.signal;
          return await new Promise(() => {});
        },
      );
      const onDebug = vi.fn();

      let settled = false;
      const resultPromise = runMemorySearchWithDeadline({
        timeoutMs: 15_000,
        run: async (signal, controlDeadline) => {
          const searchOptions: NonNullable<ManagerSearchParams[1]> &
            MemorySearchDeadlineControlOptions = {
            signal,
            onDebug,
            [MEMORY_SEARCH_DEADLINE_CONTROL]: controlDeadline,
          };
          return await firstManager.search("hello", searchOptions);
        },
      }).then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await vi.advanceTimersByTimeAsync(9_999);

      expect(fallbackSearch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);

      expect(fallbackSearch).toHaveBeenCalledTimes(1);
      expect(onDebug).toHaveBeenCalledWith({ backend: "builtin" });
      await vi.advanceTimersByTimeAsync(14_999);

      expect(settled).toBe(false);
      expect(fallbackSignal?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(1);

      const error = await resultPromise;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("memory_search timed out after 15s");
      expect(fallbackSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates caller cancellation to a same-call builtin fallback", async () => {
    const retryAgentId = "retry-agent-fallback-abort";
    const { manager: firstManager } = await createFailedQmdSearchHarness({
      agentId: retryAgentId,
      errorMessage: "qmd query failed",
    });
    let fallbackSignal: AbortSignal | undefined;
    fallbackSearch.mockImplementationOnce(
      async (_query: string, opts?: Parameters<SearchManager["search"]>[1]) => {
        fallbackSignal = opts?.signal;
        return await new Promise(() => {});
      },
    );
    const controller = new AbortController();
    const abortError = new Error("memory_search timed out after 45s");

    const resultPromise = firstManager.search("hello", { signal: controller.signal });
    await vi.waitFor(() => expect(fallbackSearch).toHaveBeenCalledTimes(1));
    controller.abort(abortError);

    await expect(resultPromise).rejects.toBe(abortError);
    expect(fallbackSignal?.aborted).toBe(true);
    expect(fallbackSignal?.reason).toBe(abortError);
  });

  it("keeps original qmd error when fallback manager initialization fails", async () => {
    const retryAgentId = "retry-agent-no-fallback-auth";
    const { manager: firstManager } = await createFailedQmdSearchHarness({
      agentId: retryAgentId,
      errorMessage: "qmd query failed",
    });
    mockMemoryIndexGet.mockRejectedValueOnce(new Error("No API key found for provider openai"));

    await expect(firstManager.search("hello")).rejects.toThrow("qmd query failed");
  });

  it("closes cached managers on global teardown", async () => {
    const cfg = createQmdCfg("teardown-agent");
    const first = await getMemorySearchManager({ cfg, agentId: "teardown-agent" });
    const firstManager = requireManager(first);

    await closeAllMemorySearchManagers();

    expect(mockPrimary.close).toHaveBeenCalledTimes(1);
    expect(mockCloseAllMemoryIndexManagers).toHaveBeenCalledTimes(1);

    const second = await getMemorySearchManager({ cfg, agentId: "teardown-agent" });
    const secondManager = requireManager(second);
    expect(secondManager).not.toBe(firstManager);
    expect(createQmdManagerMock.mock.calls).toHaveLength(2);
  });

  it("closes only the requested agent qmd manager on scoped teardown", async () => {
    const mainCfg = createQmdCfg("main");
    const otherPrimary = createQmdManagerInstanceMock();
    createQmdManagerMock.mockImplementationOnce(
      async () => mockPrimary as unknown as QmdManagerInstance,
    );
    createQmdManagerMock.mockImplementationOnce(
      async () => otherPrimary as unknown as QmdManagerInstance,
    );

    const main = await getMemorySearchManager({ cfg: mainCfg, agentId: "main" });
    const other = await getMemorySearchManager({ cfg: createQmdCfg("other"), agentId: "other" });
    const mainManager = requireManager(main);
    const otherManager = requireManager(other);

    await closeMemorySearchManager({ cfg: mainCfg, agentId: "main" });

    expect(mockPrimary.close).toHaveBeenCalledTimes(1);
    expect(otherPrimary.close).not.toHaveBeenCalled();
    const nextMain = await getMemorySearchManager({ cfg: mainCfg, agentId: "main" });
    const nextOther = await getMemorySearchManager({
      cfg: createQmdCfg("other"),
      agentId: "other",
    });
    expect(nextMain.manager).not.toBe(mainManager);
    expect(nextOther.manager).toBe(otherManager);
  });

  it("blocks qmd replacement while scoped teardown closes its builtin fallback", async () => {
    const agentId = "scoped-fallback-close-race";
    const cfg = createQmdCfg(agentId);
    const firstManager = requireManager(await getMemorySearchManager({ cfg, agentId }));
    (firstManager as unknown as { fallback: typeof fallbackManager }).fallback = fallbackManager;
    const fallbackCloseGate = createDeferred<void>();
    fallbackManager.close.mockImplementationOnce(async () => await fallbackCloseGate.promise);

    const closePromise = closeMemorySearchManager({ cfg, agentId });
    await vi.waitFor(() => expect(fallbackManager.close).toHaveBeenCalledTimes(1));
    const secondPromise = getMemorySearchManager({ cfg, agentId });
    await Promise.resolve();
    expect(createQmdManagerMock).toHaveBeenCalledTimes(1);

    fallbackCloseGate.resolve();
    await closePromise;
    const secondManager = requireManager(await secondPromise);
    expect(secondManager).not.toBe(firstManager);
    expect(createQmdManagerMock).toHaveBeenCalledTimes(2);
  });

  it("closes the requested agent builtin index manager on scoped teardown", async () => {
    const cfg = createBuiltinCfg("main");
    await getMemorySearchManager({ cfg, agentId: "main" });

    await closeMemorySearchManager({ cfg, agentId: "main" });

    expect(mockCloseMemoryIndexManagersForAgent).toHaveBeenCalledWith({
      agentId: "main",
    });
  });

  it("waits for pending full qmd manager creation during global teardown", async () => {
    const agentId = "teardown-pending-qmd";
    const cfg = createQmdCfg(agentId);
    const createGate = createDeferred<QmdManagerInstance>();
    createQmdManagerMock.mockImplementationOnce(async () => await createGate.promise);

    const firstPromise = getMemorySearchManager({ cfg, agentId });
    await Promise.resolve();

    const closePromise = closeAllMemorySearchManagers();
    await Promise.resolve();

    createGate.resolve(mockPrimary as unknown as QmdManagerInstance);

    const first = await firstPromise;
    const firstManager = requireManager(first);
    await closePromise;

    expect(mockPrimary.close).toHaveBeenCalledTimes(1);

    const second = await getMemorySearchManager({ cfg, agentId });
    expect(second.manager).not.toBe(firstManager);
    expect(createQmdManagerMock.mock.calls).toHaveLength(2);
  });

  it("closes builtin index managers on teardown after runtime is loaded", async () => {
    const retryAgentId = "teardown-with-fallback";
    const { manager } = await createFailedQmdSearchHarness({
      agentId: retryAgentId,
      errorMessage: "qmd query failed",
    });
    await manager.search("hello");

    await closeAllMemorySearchManagers();

    expect(mockCloseAllMemoryIndexManagers).toHaveBeenCalledTimes(1);
  });
});
