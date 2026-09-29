// Search-manager cache identity, acquisition, replacement, and transient lifecycle.
import {
  checkQmdBinaryAvailability,
  closeAllMemorySearchManagers,
  closeMemorySearchManager,
  createBuiltinCfg,
  createDeferred,
  createFailedQmdSearchHarness,
  createLeaseHost,
  createManagerMock,
  createManagerStatus,
  createQmdCfg,
  createQmdManagerInstanceMock,
  createQmdManagerMock,
  describe,
  expect,
  expectPendingQmdReplacement,
  fallbackManager,
  fallbackSearch,
  fs,
  getMemorySearchManager,
  getMemorySearchManagerWithoutLease,
  it,
  mockCloseMemoryIndexManagersForAgent,
  mockMemoryIndexGet,
  mockPrimary,
  nativePath,
  os,
  path,
  qmdCreateParams,
  requireManager,
  vi,
  withLease,
} from "./search-manager.test.support.js";
import type { OpenClawConfig, QmdManagerInstance } from "./search-manager.test.support.js";

describe("getMemorySearchManager caching and lifecycle", () => {
  it("repairs an invalid shared singleton cache shape before using qmd cache maps", async () => {
    await closeAllMemorySearchManagers();
    vi.resetModules();
    const cacheKey = Symbol.for("openclaw.memorySearchManagerCache");
    (globalThis as Record<PropertyKey, unknown>)[cacheKey] = {};

    const freshModule = await import("./search-manager.js");
    try {
      const result = await freshModule.getMemorySearchManager({
        cfg: createQmdCfg("corrupt-cache-agent"),
        agentId: "corrupt-cache-agent",
        withLease,
      });
      const managerStatus = requireManager(result).status();
      expect(managerStatus.backend).toBe("qmd");
      expect(managerStatus.requestedProvider).toBe("qmd");
    } finally {
      await freshModule.closeAllMemorySearchManagers();
      delete (globalThis as Record<PropertyKey, unknown>)[cacheKey];
    }
  });

  it("does not return a failed-close wrapper after a module reload", async () => {
    const agentId = "reload-failed-close";
    const cfg = createQmdCfg(agentId);
    const firstManager = requireManager(await getMemorySearchManager({ cfg, agentId }));
    mockPrimary.close.mockRejectedValueOnce(new Error("qmd close failed"));

    await expect(closeMemorySearchManager({ cfg, agentId })).rejects.toThrow("qmd close failed");

    vi.resetModules();
    const freshModule = await import("./search-manager.js");
    try {
      const second = await freshModule.getMemorySearchManager({ cfg, agentId, withLease });
      expect(second.manager).not.toBe(firstManager);
    } finally {
      await freshModule.closeAllMemorySearchManagers();
    }
  });

  it("reuses the same QMD manager instance for repeated calls", async () => {
    const cfg = createQmdCfg("main");

    const first = await getMemorySearchManager({ cfg, agentId: "main" });
    const second = await getMemorySearchManager({ cfg, agentId: "main" });

    expect(first.manager).toBe(second.manager);
    expect(createQmdManagerMock.mock.calls).toHaveLength(1);
    expect(first.debug?.managerCacheState).toBe("cached-full-miss");
    expect(second.debug?.managerCacheState).toBe("cached-full-hit");
    expect(first.debug?.qmdIdentityHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.debug?.qmdIdentityHash).toBe(first.debug?.qmdIdentityHash);
  });

  it("does not reuse QMD fallback managers across local-service hosts", async () => {
    const agentId = "local-service-hosts";
    const cfg = createQmdCfg(agentId);
    const firstAcquire = vi.fn(async () => undefined);
    const secondAcquire = vi.fn(async () => undefined);
    const firstPrimary = createQmdManagerInstanceMock();
    const secondPrimary = createQmdManagerInstanceMock();
    secondPrimary.search.mockRejectedValueOnce(new Error("qmd query failed"));
    createQmdManagerMock
      .mockImplementationOnce(async () => firstPrimary as unknown as QmdManagerInstance)
      .mockImplementationOnce(async () => secondPrimary as unknown as QmdManagerInstance);

    const first = await getMemorySearchManager({
      cfg,
      agentId,
      acquireLocalService: firstAcquire,
    });
    const second = await getMemorySearchManager({
      cfg,
      agentId,
      acquireLocalService: secondAcquire,
    });
    const secondManager = requireManager(second);
    await secondManager.search("hello");

    expect(Object.is(first.manager, second.manager)).toBe(false);
    expect(firstPrimary.close).toHaveBeenCalledTimes(1);
    expect(mockMemoryIndexGet).toHaveBeenCalledWith(
      expect.objectContaining({ acquireLocalService: secondAcquire }),
    );
  });

  it("does not reuse QMD managers across SQLite lease hosts", async () => {
    const agentId = "lease-hosts";
    const cfg = createQmdCfg(agentId);
    const firstLease = createLeaseHost();
    const secondLease = createLeaseHost();
    const firstPrimary = createQmdManagerInstanceMock();
    const secondPrimary = createQmdManagerInstanceMock();
    createQmdManagerMock
      .mockImplementationOnce(async () => firstPrimary as unknown as QmdManagerInstance)
      .mockImplementationOnce(async () => secondPrimary as unknown as QmdManagerInstance);

    const first = await getMemorySearchManager({ cfg, agentId, withLease: firstLease });
    const second = await getMemorySearchManager({ cfg, agentId, withLease: secondLease });

    expect(first.manager).not.toBe(second.manager);
    expect(createQmdManagerMock).toHaveBeenCalledTimes(2);
    expect(firstPrimary.close).toHaveBeenCalledTimes(1);
    expect(qmdCreateParams(1).withLease).toBe(secondLease);
  });

  it("fails QMD closed when the host omits SQLite lease coordination", async () => {
    const cfg = createQmdCfg("missing-lease-host");

    const result = await getMemorySearchManagerWithoutLease({
      cfg,
      agentId: "missing-lease-host",
    });

    expect(result.manager).toBe(fallbackManager);
    expect(result.debug).toMatchObject({
      backend: "qmd",
      managerCacheState: "fallback-builtin",
      failureCode: "qmd-unavailable",
    });
    expect(createQmdManagerMock).not.toHaveBeenCalled();
  });

  it("fails QMD closed without builtin when the host omits SQLite lease coordination", async () => {
    const agentId = "missing-lease-host-fail-closed";
    const cfg = createQmdCfg(agentId, "/tmp/workspace", { fallback: "none" });

    const result = await getMemorySearchManagerWithoutLease({ cfg, agentId });

    expect(result.manager).toBeNull();
    expect(result.error).toContain("memory-core host does not provide SQLite lease coordination");
    expect(result.debug).toMatchObject({
      backend: "qmd",
      managerCacheState: "qmd-unavailable",
      failureCode: "qmd-unavailable",
    });
    expect(mockMemoryIndexGet).not.toHaveBeenCalled();
    expect(createQmdManagerMock).not.toHaveBeenCalled();
  });

  it("keeps the cached QMD manager active when the caller cancels a search", async () => {
    const agentId = "cancelled-search";
    const cfg = createQmdCfg(agentId);
    const controller = new AbortController();
    const abortError = new Error("memory_search timed out after 15s");
    mockPrimary.search.mockImplementationOnce(async () => {
      controller.abort(abortError);
      throw abortError;
    });

    const first = await getMemorySearchManager({ cfg, agentId });
    const firstManager = requireManager(first);
    await expect(firstManager.search("hello", { signal: controller.signal })).rejects.toBe(
      abortError,
    );

    expect(mockPrimary.close).not.toHaveBeenCalled();
    expect(fallbackSearch).not.toHaveBeenCalled();
    const second = await getMemorySearchManager({ cfg, agentId });
    expect(second.manager).toBe(first.manager);
    expect(createQmdManagerMock).toHaveBeenCalledTimes(1);
  });

  it("evicts failed qmd wrapper so next call retries qmd", async () => {
    const retryAgentId = "retry-agent";
    const {
      cfg,
      manager: firstManager,
      firstResult: first,
    } = await createFailedQmdSearchHarness({
      agentId: retryAgentId,
      errorMessage: "qmd query failed",
    });

    const controller = new AbortController();
    const fallbackResults = await firstManager.search("hello", { signal: controller.signal });
    expect(fallbackResults).toHaveLength(1);
    expect(fallbackResults[0]?.path).toBe("MEMORY.md");
    expect(fallbackSearch).toHaveBeenCalledWith("hello", { signal: expect.any(AbortSignal) });
    const fallbackSignal = fallbackSearch.mock.calls[0]?.[1]?.signal;
    expect(fallbackSignal).toBeInstanceOf(AbortSignal);
    expect(fallbackSignal).not.toBe(controller.signal);
    expect(fallbackSignal?.aborted).toBe(false);

    const second = await getMemorySearchManager({ cfg, agentId: retryAgentId });
    requireManager(second);
    expect(second.manager).not.toBe(first.manager);
    expect(createQmdManagerMock.mock.calls).toHaveLength(2);
  });

  it("blocks qmd reacquisition while a failed primary retires", async () => {
    const agentId = "retry-agent-retirement";
    const cfg = createQmdCfg(agentId);
    const firstPrimary = createQmdManagerInstanceMock();
    const secondPrimary = createQmdManagerInstanceMock();
    const closeGate = createDeferred<void>();
    firstPrimary.search.mockRejectedValueOnce(new Error("qmd query failed"));
    firstPrimary.close.mockImplementationOnce(async () => await closeGate.promise);
    createQmdManagerMock
      .mockImplementationOnce(async () => firstPrimary as unknown as QmdManagerInstance)
      .mockImplementationOnce(async () => secondPrimary as unknown as QmdManagerInstance);

    const first = requireManager(await getMemorySearchManager({ cfg, agentId }));
    await expect(first.search("hello")).resolves.toHaveLength(1);
    await vi.waitFor(() => expect(firstPrimary.close).toHaveBeenCalledTimes(1));

    const secondPromise = getMemorySearchManager({ cfg, agentId });
    await Promise.resolve();
    expect(createQmdManagerMock).toHaveBeenCalledTimes(1);

    closeGate.resolve();
    const second = requireManager(await secondPromise);
    expect(second).not.toBe(first);
    expect(createQmdManagerMock).toHaveBeenCalledTimes(2);
  });

  it("allows builtin acquisition while failed qmd cleanup remains retained", async () => {
    const agentId = "retry-agent-retained-cleanup";
    const qmdCfg = createQmdCfg(agentId);
    const primary = createQmdManagerInstanceMock();
    primary.search.mockRejectedValueOnce(new Error("qmd query failed"));
    primary.close.mockRejectedValue(new Error("qmd close failed"));
    createQmdManagerMock.mockImplementationOnce(
      async () => primary as unknown as QmdManagerInstance,
    );

    const first = requireManager(await getMemorySearchManager({ cfg: qmdCfg, agentId }));
    await expect(first.search("hello")).resolves.toHaveLength(1);
    await vi.waitFor(() => expect(primary.close).toHaveBeenCalledTimes(1));

    const builtin = await getMemorySearchManager({ cfg: createBuiltinCfg(agentId), agentId });
    expect(builtin.manager).toBe(fallbackManager);
    expect(createQmdManagerMock).toHaveBeenCalledTimes(1);

    primary.close.mockResolvedValue(undefined);
  });

  it("falls back immediately when the qmd binary is unavailable", async () => {
    const cfg = createQmdCfg("missing-qmd");
    checkQmdBinaryAvailability.mockResolvedValueOnce({
      available: false,
      reason: "binary",
      error: "spawn qmd ENOENT",
    });

    const result = await getMemorySearchManager({ cfg, agentId: "missing-qmd" });
    const manager = requireManager(result);
    const searchResults = await manager.search("hello");

    expect(createQmdManagerMock).not.toHaveBeenCalled();
    expect(mockMemoryIndexGet).toHaveBeenCalled();
    expect(searchResults).toHaveLength(1);
  });

  it("keeps qmd startup failure fail-closed when fallback is disabled", async () => {
    const agentId = "missing-qmd-fail-closed";
    const cfg = createQmdCfg(agentId, "/tmp/workspace", { fallback: "none" });
    checkQmdBinaryAvailability.mockResolvedValueOnce({
      available: false,
      reason: "binary",
      error: "spawn qmd ENOENT",
    });

    const result = await getMemorySearchManager({ cfg, agentId });

    expect(result.manager).toBeNull();
    expect(result.error).toContain("qmd binary unavailable (qmd): spawn qmd ENOENT");
    expect(result.debug).toMatchObject({
      backend: "qmd",
      managerCacheState: "qmd-unavailable",
      failureCode: "qmd-unavailable",
    });
    expect(createQmdManagerMock).not.toHaveBeenCalled();
    expect(mockMemoryIndexGet).not.toHaveBeenCalled();
  });

  it("keeps qmd open-failure cooldown fail-closed without builtin activation", async () => {
    const agentId = "qmd-open-cooldown-fail-closed";
    const cfg = createQmdCfg(agentId, "/tmp/workspace", { fallback: "none" });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    createQmdManagerMock.mockRejectedValueOnce(new Error("Cannot find package 'chokidar'"));

    try {
      const first = await getMemorySearchManager({ cfg, agentId });
      const second = await getMemorySearchManager({ cfg, agentId });

      expect(first.manager).toBeNull();
      expect(second.manager).toBeNull();
      expect(first.error).toContain("Cannot find package 'chokidar'");
      expect(second.error).toContain("Cannot find package 'chokidar'");
      expect(createQmdManagerMock).toHaveBeenCalledTimes(1);
      expect(checkQmdBinaryAvailability).toHaveBeenCalledTimes(1);
      expect(mockMemoryIndexGet).not.toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("returns the qmd startup failure when builtin fallback is unavailable", async () => {
    const cfg = createQmdCfg("missing-qmd-no-builtin");
    checkQmdBinaryAvailability.mockResolvedValueOnce({
      available: false,
      reason: "binary",
      error: "spawn qmd ENOENT",
    });
    mockMemoryIndexGet.mockRejectedValueOnce(
      new Error(
        'Memory search unavailable: embedding provider "openai" is configured but unavailable.',
      ),
    );

    const result = await getMemorySearchManager({ cfg, agentId: "missing-qmd-no-builtin" });

    expect(result.manager).toBeNull();
    expect(result.error).toContain("qmd binary unavailable (qmd): spawn qmd ENOENT");
    expect(result.error).toContain(
      'builtin fallback unavailable: Memory search unavailable: embedding provider "openai" is configured but unavailable.',
    );
    expect(createQmdManagerMock).not.toHaveBeenCalled();
    expect(mockMemoryIndexGet).toHaveBeenCalledTimes(1);
  });

  it("treats legacy qmd unavailable results without a reason as binary failures", async () => {
    const cfg = createQmdCfg("missing-qmd-legacy");
    checkQmdBinaryAvailability.mockResolvedValueOnce({
      available: false,
      error: "spawn qmd ENOENT",
    });

    const result = await getMemorySearchManager({ cfg, agentId: "missing-qmd-legacy" });
    const manager = requireManager(result);
    const searchResults = await manager.search("hello");

    expect(createQmdManagerMock).not.toHaveBeenCalled();
    expect(mockMemoryIndexGet).toHaveBeenCalled();
    expect(searchResults).toHaveLength(1);
  });

  it("backs off repeated full qmd open failures until the cooldown expires", async () => {
    const agentId = "qmd-open-cooldown";
    const cfg = createQmdCfg(agentId);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    createQmdManagerMock.mockRejectedValueOnce(new Error("Cannot find package 'chokidar'"));

    try {
      const first = await getMemorySearchManager({ cfg, agentId });
      const second = await getMemorySearchManager({ cfg, agentId });

      expect(first.manager).toBe(fallbackManager);
      expect(second.manager).toBe(fallbackManager);
      expect(createQmdManagerMock).toHaveBeenCalledTimes(1);
      expect(checkQmdBinaryAvailability).toHaveBeenCalledTimes(1);

      nowSpy.mockReturnValue(62_001);
      const third = await getMemorySearchManager({ cfg, agentId });
      const thirdManager = requireManager(third);

      expect(thirdManager.status().backend).toBe("qmd");
      expect(createQmdManagerMock).toHaveBeenCalledTimes(2);
      expect(checkQmdBinaryAvailability).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("preserves qmd open-failure cooldown when scoped teardown closes no qmd manager", async () => {
    const agentId = "qmd-open-cooldown-scoped-close";
    const cfg = createQmdCfg(agentId);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    createQmdManagerMock.mockRejectedValueOnce(new Error("Cannot find package 'chokidar'"));

    try {
      const first = await getMemorySearchManager({ cfg, agentId });
      expect(first.manager).toBe(fallbackManager);
      expect(createQmdManagerMock).toHaveBeenCalledTimes(1);

      await closeMemorySearchManager({ cfg, agentId });

      const second = await getMemorySearchManager({ cfg, agentId });
      expect(second.manager).toBe(fallbackManager);
      expect(createQmdManagerMock).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("lets status probes bypass and clear a full qmd open-failure cooldown", async () => {
    const agentId = "qmd-open-status-bypass";
    const cfg = createQmdCfg(agentId);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    createQmdManagerMock.mockRejectedValueOnce(new Error("Cannot find package 'chokidar'"));

    try {
      const first = await getMemorySearchManager({ cfg, agentId });
      expect(first.manager).toBe(fallbackManager);
      expect(createQmdManagerMock).toHaveBeenCalledTimes(1);

      const status = await getMemorySearchManager({ cfg, agentId, purpose: "status" });
      expect(requireManager(status).status().backend).toBe("qmd");
      expect(createQmdManagerMock).toHaveBeenCalledTimes(2);

      const full = await getMemorySearchManager({ cfg, agentId });
      expect(requireManager(full).status().backend).toBe("qmd");
      expect(createQmdManagerMock).toHaveBeenCalledTimes(3);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("probes qmd availability from the agent workspace", async () => {
    const agentId = "workspace-probe";
    const cfg = createQmdCfg(agentId);

    await getMemorySearchManager({ cfg, agentId });

    expect(checkQmdBinaryAvailability).toHaveBeenCalledWith({
      command: "qmd",
      env: process.env,
      cwd: nativePath("/tmp/workspace"),
    });
  });

  it("creates a missing agent workspace before probing qmd availability", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qmd-workspace-"));
    const workspace = path.join(tempRoot, "missing", "workspace");
    const agentId = "missing-workspace";
    const cfg = {
      memory: { backend: "qmd", qmd: {} },
      agents: { list: [{ id: agentId, default: true, workspace }] },
    } as OpenClawConfig;

    try {
      await getMemorySearchManager({ cfg, agentId });

      const stat = await fs.stat(workspace);
      expect(stat.isDirectory()).toBe(true);
      expect(checkQmdBinaryAvailability).toHaveBeenCalledWith({
        command: "qmd",
        env: process.env,
        cwd: workspace,
      });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns a cached qmd manager without probing the binary again", async () => {
    const agentId = "cached-qmd";
    const cfg = createQmdCfg(agentId);

    const first = await getMemorySearchManager({ cfg, agentId });
    const second = await getMemorySearchManager({ cfg, agentId });

    requireManager(first);
    requireManager(second);
    expect(first.manager).toBe(second.manager);
    expect(checkQmdBinaryAvailability).toHaveBeenCalledTimes(1);
  });

  it("reuses cached full qmd manager across normalized agent ids", async () => {
    const cfg = createQmdCfg("Main-Agent");

    const first = await getMemorySearchManager({ cfg, agentId: "Main-Agent" });
    const second = await getMemorySearchManager({ cfg, agentId: "main-agent" });

    requireManager(first);
    requireManager(second);
    expect(first.manager).toBe(second.manager);
    expect(createQmdManagerMock).toHaveBeenCalledTimes(1);
    const createParams = qmdCreateParams();
    expect(createParams?.agentId).toBe("main-agent");
    expect(createParams?.mode).toBe("full");
  });

  it("replaces cached full qmd manager across different workspaces", async () => {
    const agentId = "cached-qmd-workspace-reload";
    const firstCfg = createQmdCfg(agentId, "/tmp/workspace-a");
    const secondCfg = createQmdCfg(agentId, "/tmp/workspace-b");
    const firstPrimary = createManagerMock({
      backend: "qmd",
      provider: "qmd",
      model: "qmd",
      requestedProvider: "qmd",
      withMemorySourceCounts: true,
    });
    const secondPrimary = createManagerMock({
      backend: "qmd",
      provider: "qmd",
      model: "qmd",
      requestedProvider: "qmd",
      withMemorySourceCounts: true,
    });
    createQmdManagerMock
      .mockImplementationOnce(async () => firstPrimary as unknown as QmdManagerInstance)
      .mockImplementationOnce(async () => secondPrimary as unknown as QmdManagerInstance);

    const first = await getMemorySearchManager({ cfg: firstCfg, agentId });
    const firstManager = requireManager(first);
    const second = await getMemorySearchManager({ cfg: secondCfg, agentId });
    const secondManager = requireManager(second);

    expect(firstManager).not.toBe(secondManager);
    expect(createQmdManagerMock).toHaveBeenCalledTimes(2);
    expect(firstPrimary.close).toHaveBeenCalledTimes(1);
    await expect(firstManager.search("hello")).rejects.toThrow("replaced by a newer qmd manager");
    expect(() => firstManager.status()).toThrow("replaced by a newer qmd manager");
    expect(checkQmdBinaryAvailability).toHaveBeenNthCalledWith(1, {
      command: "qmd",
      env: process.env,
      cwd: nativePath("/tmp/workspace-a"),
    });
    expect(checkQmdBinaryAvailability).toHaveBeenNthCalledWith(2, {
      command: "qmd",
      env: process.env,
      cwd: nativePath("/tmp/workspace-b"),
    });
  });

  it("replaces cached full qmd manager when context limits change", async () => {
    const agentId = "cached-qmd-context-limits-reload";
    const firstCfg = createQmdCfg(agentId, "/tmp/workspace");
    const secondCfg = {
      ...createQmdCfg(agentId, "/tmp/workspace"),
      agents: {
        list: [
          {
            id: agentId,
            default: true,
            workspace: "/tmp/workspace",
            contextLimits: {
              memoryGetMaxChars: 24_000,
            },
          },
        ],
      },
    } as OpenClawConfig;
    const firstPrimary = createManagerMock({
      backend: "qmd",
      provider: "qmd",
      model: "qmd",
      requestedProvider: "qmd",
      withMemorySourceCounts: true,
    });
    const secondPrimary = createManagerMock({
      backend: "qmd",
      provider: "qmd",
      model: "qmd",
      requestedProvider: "qmd",
      withMemorySourceCounts: true,
    });
    createQmdManagerMock
      .mockImplementationOnce(async () => firstPrimary as unknown as QmdManagerInstance)
      .mockImplementationOnce(async () => secondPrimary as unknown as QmdManagerInstance);

    const first = await getMemorySearchManager({ cfg: firstCfg, agentId });
    const second = await getMemorySearchManager({ cfg: secondCfg, agentId });

    requireManager(first);
    requireManager(second);
    expect(first.manager).not.toBe(second.manager);
    expect(createQmdManagerMock).toHaveBeenCalledTimes(2);
    expect(firstPrimary.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing cached full qmd manager when replacement creation fails", async () => {
    const agentId = "cached-qmd-failed-replacement";
    const firstCfg = createQmdCfg(agentId, "/tmp/workspace-a");
    const secondCfg = createQmdCfg(agentId, "/tmp/workspace-b");
    const firstPrimary = createManagerMock({
      backend: "qmd",
      provider: "qmd",
      model: "qmd",
      requestedProvider: "qmd",
      withMemorySourceCounts: true,
    });
    createQmdManagerMock.mockImplementationOnce(
      async () => firstPrimary as unknown as QmdManagerInstance,
    );
    checkQmdBinaryAvailability
      .mockResolvedValueOnce({ available: true })
      .mockResolvedValueOnce({ available: false, reason: "binary", error: "spawn qmd ENOENT" });

    const first = await getMemorySearchManager({ cfg: firstCfg, agentId });
    const firstManager = requireManager(first);
    const replacementAttempt = await getMemorySearchManager({ cfg: secondCfg, agentId });

    expect(replacementAttempt.manager).toBe(fallbackManager);
    expect(firstPrimary.close).not.toHaveBeenCalled();
    await expect(firstManager.search("hello")).resolves.toStrictEqual([]);

    const firstAgain = await getMemorySearchManager({ cfg: firstCfg, agentId });
    expect(firstAgain.manager).toBe(firstManager);
    expect(createQmdManagerMock).toHaveBeenCalledTimes(1);
  });

  it("retains an unused qmd candidate when both replacement closes fail", async () => {
    const agentId = "cached-qmd-double-close-failure";
    const firstCfg = createQmdCfg(agentId, "/tmp/workspace-a");
    const secondCfg = createQmdCfg(agentId, "/tmp/workspace-b");
    const firstPrimary = createQmdManagerInstanceMock();
    const secondPrimary = createQmdManagerInstanceMock();
    const thirdPrimary = createQmdManagerInstanceMock();
    firstPrimary.close.mockRejectedValueOnce(new Error("old close failed"));
    secondPrimary.close.mockRejectedValueOnce(new Error("candidate close failed"));
    createQmdManagerMock
      .mockImplementationOnce(async () => firstPrimary as unknown as QmdManagerInstance)
      .mockImplementationOnce(async () => secondPrimary as unknown as QmdManagerInstance)
      .mockImplementationOnce(async () => thirdPrimary as unknown as QmdManagerInstance);

    await getMemorySearchManager({ cfg: firstCfg, agentId });
    await expect(getMemorySearchManager({ cfg: secondCfg, agentId })).rejects.toThrow(
      "old close failed",
    );
    expect(secondPrimary.close).toHaveBeenCalledTimes(1);

    const replacement = await getMemorySearchManager({ cfg: secondCfg, agentId });
    expect(replacement.manager).toBeDefined();
    expect(secondPrimary.close).toHaveBeenCalledTimes(2);
    expect(createQmdManagerMock).toHaveBeenCalledTimes(3);
  });

  it("continues scoped teardown when retained candidate cleanup still fails", async () => {
    const agentId = "cached-qmd-persistent-close-failure";
    const firstCfg = createQmdCfg(agentId, "/tmp/workspace-a");
    const secondCfg = createQmdCfg(agentId, "/tmp/workspace-b");
    const firstPrimary = createQmdManagerInstanceMock();
    const secondPrimary = createQmdManagerInstanceMock();
    firstPrimary.close.mockRejectedValueOnce(new Error("old close failed"));
    secondPrimary.close.mockRejectedValue(new Error("candidate close failed"));
    createQmdManagerMock
      .mockImplementationOnce(async () => firstPrimary as unknown as QmdManagerInstance)
      .mockImplementationOnce(async () => secondPrimary as unknown as QmdManagerInstance);

    await getMemorySearchManager({ cfg: firstCfg, agentId });
    await expect(getMemorySearchManager({ cfg: secondCfg, agentId })).rejects.toThrow(
      "old close failed",
    );

    await expect(closeMemorySearchManager({ cfg: firstCfg, agentId })).rejects.toThrow(
      "candidate close failed",
    );
    expect(secondPrimary.close).toHaveBeenCalledTimes(2);
    expect(firstPrimary.close).toHaveBeenCalledTimes(2);
    expect(mockCloseMemoryIndexManagersForAgent).toHaveBeenCalledWith({
      agentId,
    });

    secondPrimary.close.mockResolvedValue(undefined);
    await closeMemorySearchManager({ cfg: firstCfg, agentId });
  });

  it("dedupes concurrent full qmd manager creation for the same agent", async () => {
    const agentId = "pending-qmd";
    const cfg = createQmdCfg(agentId);
    const createGate = createDeferred<QmdManagerInstance>();
    createQmdManagerMock.mockImplementationOnce(async () => await createGate.promise);

    const firstPromise = getMemorySearchManager({ cfg, agentId });
    const secondPromise = getMemorySearchManager({ cfg, agentId });

    createGate.resolve(mockPrimary as unknown as QmdManagerInstance);
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    requireManager(first);
    requireManager(second);
    expect(first.manager).toBe(second.manager);
    expect(createQmdManagerMock).toHaveBeenCalledTimes(1);
    expect(checkQmdBinaryAvailability).toHaveBeenCalledTimes(1);
  });

  it("serializes pending full qmd creation before replacing it for a different workspace", async () => {
    const agentId = "pending-qmd-workspace-reload";
    const firstCfg = createQmdCfg(agentId, "/tmp/workspace-a");
    const secondCfg = createQmdCfg(agentId, "/tmp/workspace-b");
    await expectPendingQmdReplacement({
      agentId,
      firstCfg,
      secondCfg,
      firstAvailability: { command: "qmd", cwd: "/tmp/workspace-a" },
      secondAvailability: { command: "qmd", cwd: "/tmp/workspace-b" },
    });
  });

  it("serializes pending full qmd creation before replacing it for a different qmd config", async () => {
    const agentId = "pending-qmd-config-reload";
    const firstCfg = createQmdCfg(agentId, "/tmp/workspace", { command: "qmd" });
    const secondCfg = createQmdCfg(agentId, "/tmp/workspace", { command: "qmd-alt" });
    await expectPendingQmdReplacement({
      agentId,
      firstCfg,
      secondCfg,
      firstAvailability: { command: "qmd", cwd: "/tmp/workspace" },
      secondAvailability: { command: "qmd-alt", cwd: "/tmp/workspace" },
    });
  });

  it("reuses pending full qmd creation when raw cfg differs but qmd inputs match", async () => {
    const agentId = "pending-qmd-unrelated-config";
    const firstCfg = createQmdCfg(agentId);
    const secondCfg = {
      ...createQmdCfg(agentId),
      session: { store: "/tmp/alternate-session-store.json" },
    } as OpenClawConfig;
    const createGate = createDeferred<QmdManagerInstance>();
    createQmdManagerMock.mockImplementationOnce(async () => await createGate.promise);

    const firstPromise = getMemorySearchManager({ cfg: firstCfg, agentId });
    await Promise.resolve();
    const secondPromise = getMemorySearchManager({ cfg: secondCfg, agentId });

    createGate.resolve(mockPrimary as unknown as QmdManagerInstance);
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    requireManager(first);
    requireManager(second);
    expect(createQmdManagerMock).toHaveBeenCalledTimes(1);
    expect(first.manager).toBe(second.manager);
    expect(checkQmdBinaryAvailability).toHaveBeenCalledTimes(1);
  });

  it("does not cache qmd managers for status-only requests", async () => {
    const agentId = "status-agent";
    const cfg = createQmdCfg(agentId);

    const first = await getMemorySearchManager({ cfg, agentId, purpose: "status" });
    const second = await getMemorySearchManager({ cfg, agentId, purpose: "status" });

    requireManager(first);
    requireManager(second);
    const firstStatus = requireManager(first).status();
    expect(firstStatus.backend).toBe("qmd");
    expect(firstStatus.provider).toBe("qmd");
    expect(firstStatus.model).toBe("qmd");
    expect(firstStatus.requestedProvider).toBe("qmd");
    expect(createQmdManagerMock.mock.calls).toHaveLength(2);
    expect(mockMemoryIndexGet).not.toHaveBeenCalled();

    await first.manager?.close?.();
    await second.manager?.close?.();
    expect(mockPrimary.close).toHaveBeenCalledTimes(2);
  });

  it("does not reuse cached full qmd managers for one-shot CLI requests", async () => {
    const agentId = "cli-agent";
    const cfg = createQmdCfg(agentId);
    const fullPrimary = createManagerMock({
      backend: "qmd",
      provider: "qmd",
      model: "qmd",
      requestedProvider: "qmd",
      withMemorySourceCounts: true,
    });
    const cliPrimary = createManagerMock({
      backend: "qmd",
      provider: "qmd",
      model: "qmd",
      requestedProvider: "qmd",
      withMemorySourceCounts: true,
    });
    createQmdManagerMock
      .mockImplementationOnce(async () => fullPrimary as unknown as QmdManagerInstance)
      .mockImplementationOnce(async () => cliPrimary as unknown as QmdManagerInstance);

    const full = await getMemorySearchManager({ cfg, agentId });
    const cli = await getMemorySearchManager({ cfg, agentId, purpose: "cli" });
    const fullManager = requireManager(full);
    const cliManager = requireManager(cli);

    expect(cli.debug?.managerCacheState).toBe("transient-cli");
    expect(full.debug?.managerCacheState).toBe("cached-full-miss");
    expect(full.debug?.qmdIdentityHash).toMatch(/^[0-9a-f]{64}$/);
    expect(cli.debug?.qmdIdentityHash).toBe(full.debug?.qmdIdentityHash);
    expect(cliManager).toBe(cliPrimary);
    expect(cliManager).not.toBe(fullManager);
    const fullCreateParams = qmdCreateParams();
    const cliCreateParams = qmdCreateParams(1);
    expect(fullCreateParams?.agentId).toBe(agentId);
    expect(fullCreateParams?.mode).toBe("full");
    expect(cliCreateParams?.agentId).toBe(agentId);
    expect(cliCreateParams?.mode).toBe("cli");

    await cli.manager?.close?.();
    expect(cliPrimary.close).toHaveBeenCalledTimes(1);
    expect(fullPrimary.close).not.toHaveBeenCalled();

    const fullAgain = await getMemorySearchManager({ cfg, agentId });
    expect(fullAgain.manager).toBe(fullManager);
  });

  it("does not cache builtin managers for status-only requests", async () => {
    const agentId = "builtin-status-agent";
    const cfg = createBuiltinCfg(agentId);
    const firstBuiltinManager = createManagerMock({
      backend: "builtin",
      provider: "openai",
      model: "text-embedding-3-small",
      requestedProvider: "openai",
    });
    const secondBuiltinManager = createManagerMock({
      backend: "builtin",
      provider: "openai",
      model: "text-embedding-3-small",
      requestedProvider: "openai",
    });
    mockMemoryIndexGet
      .mockResolvedValueOnce(firstBuiltinManager)
      .mockResolvedValueOnce(secondBuiltinManager);

    const first = await getMemorySearchManager({ cfg, agentId, purpose: "status" });
    const second = await getMemorySearchManager({ cfg, agentId, purpose: "status" });

    expect(first.manager).toBe(firstBuiltinManager);
    expect(second.manager).toBe(secondBuiltinManager);
    expect(second.manager).not.toBe(first.manager);
    expect(mockMemoryIndexGet).toHaveBeenCalledTimes(2);

    await first.manager?.close?.();
    await second.manager?.close?.();
    expect(firstBuiltinManager.close).toHaveBeenCalledTimes(1);
    expect(secondBuiltinManager.close).toHaveBeenCalledTimes(1);
  });

  it("reports real qmd index counts for status-only requests", async () => {
    const agentId = "status-counts-agent";
    const cfg = createQmdCfg(agentId);
    mockPrimary.status.mockReturnValueOnce({
      ...createManagerStatus({
        backend: "qmd",
        provider: "qmd",
        model: "qmd",
        requestedProvider: "qmd",
        withMemorySourceCounts: true,
      }),
      files: 10,
      chunks: 42,
      sourceCounts: [{ source: "memory" as const, files: 10, chunks: 42 }],
    });

    const result = await getMemorySearchManager({ cfg, agentId, purpose: "status" });
    const manager = requireManager(result);

    const status = manager.status();
    expect(status.backend).toBe("qmd");
    expect(status.files).toBe(10);
    expect(status.chunks).toBe(42);
    expect(status.sourceCounts).toEqual([{ source: "memory", files: 10, chunks: 42 }]);
    const createParams = qmdCreateParams();
    expect(createParams?.agentId).toBe(agentId);
    expect(createParams?.mode).toBe("status");
  });

  it("reuses cached full qmd manager for status-only requests", async () => {
    const agentId = "status-reuses-full-agent";
    const cfg = createQmdCfg(agentId);

    const full = await getMemorySearchManager({ cfg, agentId });
    const status = await getMemorySearchManager({ cfg, agentId, purpose: "status" });

    requireManager(full);
    requireManager(status);
    expect(status.manager).not.toBe(full.manager);
    expect(createQmdManagerMock.mock.calls).toHaveLength(1);
    await status.manager?.close?.();
    expect(mockPrimary.close).not.toHaveBeenCalled();

    const fullAgain = await getMemorySearchManager({ cfg, agentId });
    expect(fullAgain.manager).toBe(full.manager);
  });

  it("does not borrow a cached full qmd manager for status across different workspaces", async () => {
    const agentId = "status-workspace-reload";
    const firstCfg = createQmdCfg(agentId, "/tmp/workspace-a");
    const secondCfg = createQmdCfg(agentId, "/tmp/workspace-b");
    const firstPrimary = createManagerMock({
      backend: "qmd",
      provider: "qmd",
      model: "qmd",
      requestedProvider: "qmd",
      withMemorySourceCounts: true,
    });
    const secondStatusManager = createManagerMock({
      backend: "qmd",
      provider: "qmd",
      model: "qmd",
      requestedProvider: "qmd",
      withMemorySourceCounts: true,
    });
    createQmdManagerMock
      .mockImplementationOnce(async () => firstPrimary as unknown as QmdManagerInstance)
      .mockImplementationOnce(async () => secondStatusManager as unknown as QmdManagerInstance);

    const full = await getMemorySearchManager({ cfg: firstCfg, agentId });
    const fullManager = requireManager(full);
    const status = await getMemorySearchManager({ cfg: secondCfg, agentId, purpose: "status" });

    requireManager(status);
    expect(status.manager).toBe(secondStatusManager);
    expect(createQmdManagerMock.mock.calls).toHaveLength(2);
    expect(firstPrimary.close).not.toHaveBeenCalled();
    expect(checkQmdBinaryAvailability).toHaveBeenNthCalledWith(1, {
      command: "qmd",
      env: process.env,
      cwd: nativePath("/tmp/workspace-a"),
    });
    expect(checkQmdBinaryAvailability).toHaveBeenNthCalledWith(2, {
      command: "qmd",
      env: process.env,
      cwd: nativePath("/tmp/workspace-b"),
    });

    const fullAgain = await getMemorySearchManager({ cfg: firstCfg, agentId });
    expect(fullAgain.manager).toBe(fullManager);
  });

  it("gets a fresh qmd manager for later status requests after close", async () => {
    const agentId = "status-eviction-agent";
    const cfg = createQmdCfg(agentId);

    const first = await getMemorySearchManager({ cfg, agentId, purpose: "status" });
    const firstManager = requireManager(first);
    await firstManager.close?.();

    const second = await getMemorySearchManager({ cfg, agentId, purpose: "status" });
    requireManager(second);

    expect(createQmdManagerMock.mock.calls).toHaveLength(2);
    expect(mockPrimary.close).toHaveBeenCalledTimes(1);
  });

  it("does not evict a newer cached wrapper when closing an older failed wrapper", async () => {
    const retryAgentId = "retry-agent-close";
    const {
      cfg,
      manager: firstManager,
      firstResult: first,
    } = await createFailedQmdSearchHarness({
      agentId: retryAgentId,
      errorMessage: "qmd query failed",
    });
    await firstManager.search("hello");

    const second = await getMemorySearchManager({ cfg, agentId: retryAgentId });
    const secondManager = requireManager(second);
    expect(second.manager).not.toBe(first.manager);

    await firstManager.close?.();

    const third = await getMemorySearchManager({ cfg, agentId: retryAgentId });
    expect(third.manager).toBe(secondManager);
    expect(createQmdManagerMock.mock.calls).toHaveLength(2);
  });
});
