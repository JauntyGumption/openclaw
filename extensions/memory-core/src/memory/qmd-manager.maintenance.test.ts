// QMD embedding, update, lease, and session-export maintenance.
import {
  MAX_TIMER_TIMEOUT_MS,
  PluginStateLeaseError,
  QmdMemoryManager,
  agentId,
  cfg,
  configureMemoryCoreDreamingStateForTests,
  configureQmd,
  countQmdCommand,
  createDeferred,
  createManager,
  createMockChild,
  describe,
  embedStartupJitterSpy,
  expect,
  firstEmbedLeaseCall,
  firstWriteLeaseCall,
  formatSessionTranscriptMemoryHitKey,
  fs,
  it,
  makeQmdResults,
  path,
  requireValue,
  resolveMemoryBackendConfigForTest,
  resolveQmdSessionArtifactIdentity,
  seedQmdSessionTranscript,
  setEmbedStartupJitterSpy,
  spawnMock,
  stateDir,
  trackManager,
  vi,
  waitUntil,
  withLeaseMock,
  workspaceDir,
  writeLeaseCalls,
} from "./qmd-manager.test.support.js";
import type {
  LeaseCall,
  MockChild,
  PluginStateLeaseContext,
  PluginStateLeaseOptions,
} from "./qmd-manager.test.support.js";

describe("QmdMemoryManager maintenance and leases", () => {
  it("fails closed when no managed collections are configured", async () => {
    configureQmd({ paths: [] });

    const { manager } = await createManager();

    const results = await manager.search("test", { sessionKey: "agent:main:slack:dm:u123" });
    expect(results).toStrictEqual([]);
    expect(
      spawnMock.mock.calls.some((call: unknown[]) => (call[1] as string[])?.[0] === "query"),
    ).toBe(false);
    await manager.close();
  });

  it("diversifies mixed session and memory search results so memory hits are retained", async () => {
    configureQmd({ sessions: { enabled: true } });

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "search" && args.includes("workspace-main")) {
        return makeQmdResults({ docid: "m1", score: 0.6, snippet: "@@ -1,1\nmemory fact" });
      }
      if (args[0] === "search" && args.includes("sessions-main")) {
        return makeQmdResults(
          { docid: "s1", score: 0.99, snippet: "@@ -1,1\nsession top 1" },
          { docid: "s2", score: 0.95, snippet: "@@ -1,1\nsession top 2" },
          { docid: "s3", score: 0.91, snippet: "@@ -1,1\nsession top 3" },
          { docid: "s4", score: 0.88, snippet: "@@ -1,1\nsession top 4" },
        );
      }
      return createMockChild();
    });

    const { manager } = await createManager();
    const inner = manager as unknown as {
      db: { prepare: (_query: string) => { all: (arg: unknown) => unknown }; close: () => void };
    };
    inner.db = {
      prepare: (_query: string) => ({
        all: (arg: unknown) => {
          switch (arg) {
            case "m1":
              return [{ collection: "workspace-main", path: "memory/facts.md" }];
            case "s1":
            case "s2":
            case "s3":
            case "s4":
              return [
                {
                  collection: "sessions-main",
                  path: `${arg}.md`,
                },
              ];
            default:
              return [];
          }
        },
      }),
      close: () => {},
    };

    const results = await manager.search("fact", {
      maxResults: 4,
      sessionKey: "agent:main:slack:dm:u123",
    });

    expect(results).toHaveLength(4);
    const sources = results.map((entry) => entry.source);
    expect(sources).toContain("memory");
    expect(sources).toContain("sessions");
    await manager.close();
  });

  it("logs and continues when qmd embed times out", async () => {
    vi.useFakeTimers();
    configureQmd({
      update: { interval: "0s", debounceMs: 0, onBoot: false, embedTimeoutMs: 20 },
    });
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "embed") {
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
    const resolvedSync = expect(syncPromise).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(20);
    await resolvedSync;
    await manager.close();
  });

  it("does not store qmd embed backoff when the process clock is invalid", async () => {
    configureQmd({
      searchMode: "query",
      update: { interval: "0s", debounceMs: 0, onBoot: false },
    });
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);
    const { manager } = await createManager({ mode: "status" });
    try {
      (
        manager as unknown as {
          noteEmbedFailure: (reason: string, err: unknown) => void;
        }
      ).noteEmbedFailure("manual", new Error("embed failed"));
    } finally {
      dateNowSpy.mockRestore();
    }

    const status = manager.status() as { custom?: { qmd?: { embedBackoffUntil?: number | null } } };
    expect(status.custom?.qmd?.embedBackoffUntil).toBeNull();
    await manager.close();
  });

  it("runs periodic embed maintenance even when regular update scheduling is disabled", async () => {
    vi.useFakeTimers();
    configureQmd({
      searchMode: "query",
      update: { interval: "0s", debounceMs: 0, onBoot: false, embedInterval: "5m" },
    });

    const { manager } = await createManager({ mode: "full" });

    const commandCallsBefore = spawnMock.mock.calls.filter((call: unknown[]) => {
      const args = call[1] as string[];
      return args[0] === "update" || args[0] === "embed";
    });
    expect(commandCallsBefore).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const commandCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(commandCalls).toEqual([["update"], ["embed"]]);

    await manager.close();
  });

  it("runs periodic embed maintenance when embed cadence is faster than update cadence", async () => {
    vi.useFakeTimers();
    configureQmd({
      searchMode: "query",
      update: { interval: "20m", debounceMs: 0, onBoot: false, embedInterval: "5m" },
    });

    const { manager } = await createManager({ mode: "full" });

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const commandCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(commandCalls).toEqual([["update"], ["embed"]]);

    await manager.close();
  });

  it("does not schedule redundant embed maintenance when regular updates are already more frequent", async () => {
    vi.useFakeTimers();
    configureQmd({
      searchMode: "query",
      update: { interval: "5m", debounceMs: 0, onBoot: false, embedInterval: "20m" },
    });

    const { manager } = await createManager({ mode: "full" });

    await vi.advanceTimersByTimeAsync(6 * 60_000);

    const commandCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(commandCalls).toEqual([["update"], ["embed"]]);

    await manager.close();
  });

  it("skips periodic embed maintenance in lexical search mode", async () => {
    vi.useFakeTimers();
    configureQmd({
      searchMode: "search",
      update: { interval: "0s", debounceMs: 0, onBoot: false, embedInterval: "5m" },
    });

    const { manager } = await createManager({ mode: "full" });

    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const commandCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(commandCalls).toStrictEqual([]);

    await manager.close();
  });

  it("delays the first periodic embed maintenance run by stable startup jitter", async () => {
    vi.useFakeTimers();
    embedStartupJitterSpy?.mockRestore();
    setEmbedStartupJitterSpy(
      vi
        .spyOn(
          QmdMemoryManager.prototype as unknown as {
            resolveEmbedStartupJitterMs: () => number;
          },
          "resolveEmbedStartupJitterMs",
        )
        .mockReturnValue(60_000),
    );
    configureQmd({
      searchMode: "query",
      update: { interval: "0s", debounceMs: 0, onBoot: false, embedInterval: "5m" },
    });

    const { manager } = await createManager({ mode: "full" });

    await vi.advanceTimersByTimeAsync(59_999);
    const beforeCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(beforeCalls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    const commandCalls = spawnMock.mock.calls
      .map((call: unknown[]) => call[1] as string[])
      .filter((args: string[]) => args[0] === "update" || args[0] === "embed");
    expect(commandCalls).toEqual([["update"], ["embed"]]);

    await manager.close();
  });

  it("serializes qmd embeds within a process before taking the shared SQLite lease", async () => {
    vi.useFakeTimers();
    configureQmd({
      searchMode: "query",
      update: { interval: "0s", debounceMs: 0, onBoot: false },
    });
    const embedChildren: MockChild[] = [];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "embed") {
        const child = createMockChild({ autoClose: false });
        embedChildren.push(child);
        return child;
      }
      return createMockChild();
    });

    const first = await createManager({ mode: "status" });
    const second = await createManager({ mode: "status" });
    withLeaseMock.mockClear();
    const firstSync = first.manager.sync({ reason: "manual", force: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(embedChildren).toHaveLength(1);
    const [leaseOptions, leaseTask] = firstEmbedLeaseCall();
    expect(leaseOptions).toMatchObject({
      namespace: "qmd",
      key: "embed",
      database: { scope: "shared" },
      leaseMs: 15 * 60 * 1000,
      waitMs: 15 * 60 * 1000,
    });
    expect(typeof leaseTask).toBe("function");

    const secondSync = second.manager.sync({ reason: "manual", force: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(embedChildren).toHaveLength(1);

    embedChildren[0]?.closeWith(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(embedChildren).toHaveLength(2);

    embedChildren[1]?.closeWith(0);
    await expect(firstSync).resolves.toBeUndefined();
    await expect(secondSync).resolves.toBeUndefined();
    await first.manager.close();
    await second.manager.close();
  });

  it("drops a queued embed when its manager closes", async () => {
    configureQmd({
      searchMode: "query",
      update: { interval: "0s", debounceMs: 0, onBoot: false },
    });
    const embedChildren: MockChild[] = [];
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "embed") {
        const child = createMockChild({ autoClose: false });
        embedChildren.push(child);
        return child;
      }
      return createMockChild();
    });

    const first = await createManager({ mode: "status" });
    const second = await createManager({ mode: "status" });
    withLeaseMock.mockClear();
    const firstSync = first.manager.sync({ reason: "manual", force: true });
    await waitUntil(() => embedChildren.length === 1);
    const secondSync = second.manager.sync({ reason: "manual", force: true });
    await waitUntil(() => writeLeaseCalls().length >= 3);

    await second.manager.close();
    await expect(secondSync).resolves.toBeUndefined();
    expect(embedChildren).toHaveLength(1);

    embedChildren[0]?.closeWith(0);
    await expect(firstSync).resolves.toBeUndefined();
    await first.manager.close();
  });

  it("serializes both the qmd update and embed writes on one per-agent lease (issue #66339)", async () => {
    // Regression for #66339: the update AND embed phases both write the same
    // qmd index.sqlite. A foreground `memory search` dirty-sync and a background
    // gateway update/embed run in separate processes, which the in-process queues
    // cannot serialize, so the writers collided with SQLITE_BUSY. Both writes now
    // take one per-agent SQLite write lease; embed additionally keeps the
    // global SQLite lease for ML-resource serialization.
    configureQmd({
      searchMode: "query",
      update: { interval: "0s", debounceMs: 0, onBoot: false },
    });
    spawnMock.mockImplementation(() => createMockChild());

    const { manager } = await createManager({ mode: "status" });
    withLeaseMock.mockClear();
    await expect(manager.sync({ reason: "manual", force: true })).resolves.toBeUndefined();

    const [leaseOptions, leaseTask] = firstWriteLeaseCall();
    expect(leaseOptions).toMatchObject({
      namespace: "qmd",
      key: "write",
      database: { scope: "agent", agentId },
    });
    expect(leaseOptions.leaseMs).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(leaseOptions.waitMs).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(typeof leaseTask).toBe("function");

    // A forced sync runs both the update and the embed write, so both acquire the
    // shared per-agent write lease; the embed also still takes the global embed lease.
    expect(writeLeaseCalls().length).toBeGreaterThanOrEqual(2);
    const embedLeaseTaken = withLeaseMock.mock.calls.some(
      (entry) => entry[0].database.scope === "shared" && entry[0].key === "embed",
    );
    expect(embedLeaseTaken).toBe(true);

    await manager.close();
  });

  it("clamps derived lease durations to the public timer-safe maximum", async () => {
    configureQmd({
      searchMode: "query",
      update: {
        interval: "0s",
        debounceMs: 0,
        onBoot: false,
        updateTimeoutMs: MAX_TIMER_TIMEOUT_MS,
        embedTimeoutMs: MAX_TIMER_TIMEOUT_MS,
      },
    });

    const { manager } = await createManager({ mode: "status" });
    withLeaseMock.mockClear();
    await manager.sync({ reason: "manual", force: true });

    expect(withLeaseMock).toHaveBeenCalled();
    for (const [options] of withLeaseMock.mock.calls as LeaseCall[]) {
      expect(options.leaseMs).toBeLessThanOrEqual(MAX_TIMER_TIMEOUT_MS);
      expect(options.waitMs).toBeLessThanOrEqual(MAX_TIMER_TIMEOUT_MS);
    }
    await manager.close();
  });

  it("preserves update and embed intent when the write lease fails after the callback", async () => {
    configureQmd({
      searchMode: "query",
      update: { interval: "0s", debounceMs: 0, onBoot: false },
    });
    const { manager } = await createManager({ mode: "status" });
    (manager as unknown as { dirty: boolean }).dirty = true;
    (manager as unknown as { lastEmbedAt: number | null }).lastEmbedAt = Date.now();
    let rejectAfterCallback = true;
    const leaseLost = new PluginStateLeaseError("write lease lost", {
      code: "PLUGIN_STATE_LEASE_LOST",
    });
    withLeaseMock.mockImplementation(
      async <T>(
        options: PluginStateLeaseOptions,
        run: (lease: PluginStateLeaseContext) => Promise<T>,
      ) => {
        const result = await run({
          signal: options.signal ?? new AbortController().signal,
          assertOwned: vi.fn(),
        });
        if (rejectAfterCallback && options.database.scope === "agent") {
          throw leaseLost;
        }
        return result as T;
      },
    );

    await expect(manager.sync({ reason: "manual", force: true })).rejects.toBe(leaseLost);
    expect(manager.status().dirty).toBe(true);
    expect(
      (manager.status() as { custom?: { qmd?: { lastUpdateAt?: number | null } } }).custom?.qmd
        ?.lastUpdateAt,
    ).toBeNull();
    expect(countQmdCommand((args) => args[0] === "update")).toBe(1);

    rejectAfterCallback = false;
    await manager.sync({ reason: "retry" });
    expect(manager.status().dirty).toBe(false);
    expect(
      (manager.status() as { custom?: { qmd?: { lastUpdateAt?: number | null } } }).custom?.qmd
        ?.lastUpdateAt,
    ).toEqual(expect.any(Number));
    expect(countQmdCommand((args) => args[0] === "update")).toBe(2);
    expect(countQmdCommand((args) => args[0] === "embed")).toBe(1);
    await manager.close();
  });

  it("aborts collection reconciliation when its write lease is lost", async () => {
    await configureMemoryCoreDreamingStateForTests();
    const leaseController = new AbortController();
    const leaseLost = new PluginStateLeaseError("reconciliation lease lost", {
      code: "PLUGIN_STATE_LEASE_LOST",
    });
    let listKill: ReturnType<typeof vi.fn> | undefined;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        const child = createMockChild({ autoClose: false });
        const kill = vi.fn(() => queueMicrotask(() => child.emit("close", null)));
        Object.assign(child, { kill });
        listKill = kill;
        return child;
      }
      return createMockChild();
    });
    withLeaseMock.mockImplementation(
      async <T>(
        options: PluginStateLeaseOptions,
        run: (lease: PluginStateLeaseContext) => Promise<T>,
      ) => {
        const signal = options.signal
          ? AbortSignal.any([options.signal, leaseController.signal])
          : leaseController.signal;
        return (await run({
          signal,
          assertOwned: () => signal.throwIfAborted(),
        })) as T;
      },
    );

    const creating = createManager({ mode: "cli" });
    creating.catch(() => undefined);
    await waitUntil(() => listKill !== undefined);
    leaseController.abort(leaseLost);

    await expect(creating).rejects.toBe(leaseLost);
    expect(listKill).toHaveBeenCalledWith("SIGKILL");
    expect(countQmdCommand((args) => args[0] === "collection" && args[1] === "add")).toBe(0);
  });

  it("aborts an in-flight qmd update when its write lease is lost", async () => {
    configureQmd({
      searchMode: "search",
      update: { interval: "0s", debounceMs: 0, onBoot: false },
    });
    const { manager } = await createManager({ mode: "status" });
    const leaseController = new AbortController();
    const leaseLost = new PluginStateLeaseError("update lease lost", {
      code: "PLUGIN_STATE_LEASE_LOST",
    });
    let updateKill: ReturnType<typeof vi.fn> | undefined;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "update") {
        const child = createMockChild({ autoClose: false });
        const kill = vi.fn(() => queueMicrotask(() => child.emit("close", null)));
        Object.assign(child, { kill });
        updateKill = kill;
        return child;
      }
      return createMockChild();
    });
    withLeaseMock.mockImplementation(
      async <T>(
        options: PluginStateLeaseOptions,
        run: (lease: PluginStateLeaseContext) => Promise<T>,
      ) => {
        const signal = options.signal
          ? AbortSignal.any([options.signal, leaseController.signal])
          : leaseController.signal;
        return (await run({
          signal,
          assertOwned: () => signal.throwIfAborted(),
        })) as T;
      },
    );

    const syncing = manager.sync({ reason: "manual", force: true });
    syncing.catch(() => undefined);
    await waitUntil(() => updateKill !== undefined);
    leaseController.abort(leaseLost);

    await expect(syncing).rejects.toBe(leaseLost);
    expect(updateKill).toHaveBeenCalledWith("SIGKILL");
    expect(
      (manager.status() as { custom?: { qmd?: { lastUpdateAt?: number | null } } }).custom?.qmd
        ?.lastUpdateAt,
    ).toBeNull();
    await manager.close();
  });

  it("does not hold the per-agent write lease while waiting for embed capacity", async () => {
    configureQmd(
      {
        searchMode: "query",
        update: { interval: "0s", debounceMs: 0, onBoot: false },
      },
      {
        agents: {
          ...cfg.agents,
          list: [
            { id: agentId, default: true, workspace: workspaceDir },
            { id: "other", workspace: workspaceDir },
          ],
        },
      },
    );
    spawnMock.mockImplementation(() => createMockChild());

    let releaseFirstEmbed!: () => void;
    const firstEmbedLocked = new Promise<void>((resolve) => {
      withLeaseMock.mockImplementation(
        async <T>(
          options: PluginStateLeaseOptions,
          run: (lease: PluginStateLeaseContext) => Promise<T>,
        ) => {
          if (options.database.scope === "shared" && !releaseFirstEmbed) {
            resolve();
            await new Promise<void>((release) => {
              releaseFirstEmbed = release;
            });
          }
          return await run({
            signal: options.signal ?? new AbortController().signal,
            assertOwned: vi.fn(),
          });
        },
      );
    });

    const first = await createManager({ mode: "status" });
    const second = await createManager({ mode: "status", agentId: "other" });
    withLeaseMock.mockClear();
    const firstSync = first.manager.sync({ reason: "manual", force: true });
    await firstEmbedLocked;

    const secondSync = second.manager.sync({ reason: "manual", force: true });
    try {
      await waitUntil(() => writeLeaseCalls().length >= 2);

      // The second manager may run its update, but its embed must not take a store
      // write lease while it is still queued behind the first embed.
      expect(writeLeaseCalls().length).toBe(2);
    } finally {
      releaseFirstEmbed();
    }

    await Promise.all([firstSync, secondSync]);
    expect(writeLeaseCalls().length).toBeGreaterThanOrEqual(4);

    await first.manager.close();
    await second.manager.close();
  });

  it("serializes session exports across managers for the same agent", async () => {
    configureQmd({
      update: { interval: "0s", debounceMs: 0, onBoot: false },
      sessions: { enabled: true },
    });

    const sessionsDir = path.join(stateDir, "agents", agentId, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, "session-1.jsonl"),
      '{"type":"message","message":{"role":"user","content":"hello"}}\n',
      "utf-8",
    );

    const firstEntered = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    let activeExports = 0;
    let overlapped = false;
    const exportSpy = vi
      .spyOn(
        QmdMemoryManager.prototype as unknown as {
          exportSessions: (lease: {
            signal: AbortSignal;
            assertOwned: () => void;
          }) => Promise<void>;
        },
        "exportSessions",
      )
      .mockImplementation(async (_signal) => {
        activeExports += 1;
        if (activeExports > 1) {
          overlapped = true;
        }
        if (activeExports === 1) {
          firstEntered.resolve();
          await releaseFirst.promise;
        }
        activeExports -= 1;
      });

    const first = await createManager({ mode: "status" });
    const second = await createManager({ mode: "status" });

    try {
      const firstSync = first.manager.sync({ reason: "manual", force: true });
      await firstEntered.promise;

      const secondSync = second.manager.sync({ reason: "manual", force: true });
      await Promise.resolve();

      expect(exportSpy).toHaveBeenCalledTimes(1);
      expect(overlapped).toBe(false);

      releaseFirst.resolve();
      await Promise.all([firstSync, secondSync]);

      expect(exportSpy).toHaveBeenCalledTimes(2);
      expect(overlapped).toBe(false);
    } finally {
      exportSpy.mockRestore();
      await first.manager.close();
      await second.manager.close();
    }
  });

  it("maps exported QMD artifacts to the persisted session identity", async () => {
    configureQmd({
      update: { interval: "0s", debounceMs: 0, onBoot: false },
      sessions: { enabled: true },
    });

    await seedQmdSessionTranscript({
      agentId,
      content: "hello mapped session",
      sessionId: "actual-session",
      stateDir,
      sessionKey: "agent:main:chat:thread",
    });

    const { manager } = await createManager({ mode: "status" });
    await (
      manager as unknown as {
        exportSessions: (lease: { signal: AbortSignal; assertOwned: () => void }) => Promise<void>;
      }
    ).exportSessions({ signal: new AbortController().signal, assertOwned: vi.fn() });
    const indexPath = (manager as unknown as { indexPath: string }).indexPath;
    const identity = resolveQmdSessionArtifactIdentity({
      artifactPath: "actual-session.md",
      collection: "sessions-main",
      indexPath,
      searchPath: "qmd/sessions-main/actual-session.md",
    });

    expect(identity).toEqual({
      agentId,
      archived: false,
      memoryKey: formatSessionTranscriptMemoryHitKey({
        agentId,
        sessionId: "actual-session",
      }),
      sessionId: "actual-session",
    });

    await manager.close();
  });

  it("does not publish session artifact mappings after lease ownership is lost", async () => {
    configureQmd({
      update: { interval: "0s", debounceMs: 0, onBoot: false },
      sessions: { enabled: true },
    });
    await seedQmdSessionTranscript({
      agentId,
      content: "lease guarded session",
      sessionId: "lease-guarded-session",
      stateDir,
      sessionKey: "agent:main:chat:lease-guarded",
    });
    const { manager } = await createManager({ mode: "status" });
    const leaseLost = new PluginStateLeaseError("session export lease lost", {
      code: "PLUGIN_STATE_LEASE_LOST",
    });
    let ownershipChecks = 0;

    await expect(
      (
        manager as unknown as {
          exportSessions: (lease: {
            signal: AbortSignal;
            assertOwned: () => void;
          }) => Promise<void>;
        }
      ).exportSessions({
        signal: new AbortController().signal,
        assertOwned: () => {
          ownershipChecks += 1;
          if (ownershipChecks === 3) {
            throw leaseLost;
          }
        },
      }),
    ).rejects.toBe(leaseLost);

    const indexPath = (manager as unknown as { indexPath: string }).indexPath;
    expect(
      resolveQmdSessionArtifactIdentity({
        artifactPath: "lease-guarded-session.md",
        collection: "sessions-main",
        indexPath,
        searchPath: "qmd/sessions-main/lease-guarded-session.md",
      }),
    ).toBeNull();
    await manager.close();
  });

  it("skips queued session export work after close while waiting on the shared update queue", async () => {
    configureQmd({
      update: { interval: "0s", debounceMs: 0, onBoot: false },
      sessions: { enabled: true },
    });

    const sessionsDir = path.join(stateDir, "agents", agentId, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });
    await fs.writeFile(
      path.join(sessionsDir, "session-1.jsonl"),
      '{"type":"message","message":{"role":"user","content":"hello"}}\n',
      "utf-8",
    );

    const firstEntered = createDeferred<void>();
    const releaseFirst = createDeferred<void>();
    const exportSpy = vi
      .spyOn(
        QmdMemoryManager.prototype as unknown as {
          exportSessions: (lease: {
            signal: AbortSignal;
            assertOwned: () => void;
          }) => Promise<void>;
        },
        "exportSessions",
      )
      .mockImplementation(async (_signal) => {
        if (exportSpy.mock.calls.length === 1) {
          firstEntered.resolve();
          await releaseFirst.promise;
        }
      });

    const first = await createManager({ mode: "status" });
    const second = await createManager({ mode: "status" });

    try {
      const firstSync = first.manager.sync({ reason: "manual", force: true });
      await firstEntered.promise;

      const secondSync = second.manager.sync({ reason: "manual", force: true });
      await Promise.resolve();

      const closeSecond = second.manager.close();
      await expect(closeSecond).resolves.toBeUndefined();

      releaseFirst.resolve();
      await Promise.all([firstSync, secondSync]);

      expect(exportSpy).toHaveBeenCalledTimes(1);
      const updateCalls = spawnMock.mock.calls
        .map((call: unknown[]) => call[1] as string[])
        .filter((args: string[]) => args[0] === "update");
      expect(updateCalls).toHaveLength(1);
    } finally {
      exportSpy.mockRestore();
      await first.manager.close();
      await second.manager.close();
    }
  });

  it.each(["shared", "agent"] as const)(
    "fails closed when the %s embed lease is lost",
    async (lostScope) => {
      configureQmd({
        searchMode: "query",
        update: { interval: "0s", debounceMs: 0, onBoot: false },
      });
      const { manager } = await createManager({ mode: "status" });
      // A forced sync must retain explicit embed intent after lease loss even
      // when the normal embed interval would consider a recent embed fresh.
      (manager as unknown as { lastEmbedAt: number | null }).lastEmbedAt = Date.now();
      const leaseLost = new PluginStateLeaseError(`${lostScope} embed lease lost`, {
        code: "PLUGIN_STATE_LEASE_LOST",
      });
      let embedPhase = false;
      let targetController: AbortController | undefined;
      let embedKill: ReturnType<typeof vi.fn> | undefined;
      spawnMock.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === "embed") {
          const child = createMockChild({ autoClose: false });
          const kill = vi.fn(() => queueMicrotask(() => child.emit("close", null)));
          Object.assign(child, { kill });
          embedKill = kill;
          return child;
        }
        return createMockChild();
      });
      withLeaseMock.mockImplementation(
        async <T>(
          options: PluginStateLeaseOptions,
          run: (lease: PluginStateLeaseContext) => Promise<T>,
        ) => {
          const isSharedEmbed = options.database.scope === "shared" && options.key === "embed";
          if (isSharedEmbed) {
            embedPhase = true;
          }
          const isTarget = lostScope === "shared" ? isSharedEmbed : embedPhase && !isSharedEmbed;
          const controller = isTarget ? new AbortController() : undefined;
          if (controller) {
            targetController = controller;
          }
          const signals = [options.signal, controller?.signal].filter(
            (signal): signal is AbortSignal => signal !== undefined,
          );
          const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0]!;
          return (await run({
            signal,
            assertOwned: () => signal.throwIfAborted(),
          })) as T;
        },
      );

      const syncing = manager.sync({ reason: "manual", force: true });
      syncing.catch(() => undefined);
      await waitUntil(() => embedKill !== undefined && targetController !== undefined);
      targetController?.abort(leaseLost);

      await expect(syncing).rejects.toBe(leaseLost);
      expect(embedKill).toHaveBeenCalledWith("SIGKILL");
      expect(manager.status().dirty).toBe(true);
      expect(
        (manager.status() as { custom?: { qmd?: { lastUpdateAt?: number | null } } }).custom?.qmd
          ?.lastUpdateAt,
      ).toBeNull();

      spawnMock.mockImplementation(() => createMockChild());
      withLeaseMock.mockImplementation(
        async <T>(
          options: PluginStateLeaseOptions,
          run: (lease: PluginStateLeaseContext) => Promise<T>,
        ) =>
          await run({
            signal: options.signal ?? new AbortController().signal,
            assertOwned: vi.fn(),
          }),
      );
      await expect(manager.sync({ reason: "retry" })).resolves.toBeUndefined();
      expect(countQmdCommand((args) => args[0] === "embed")).toBe(2);
      expect(manager.status().dirty).toBe(false);
      await manager.close();
    },
  );
});
