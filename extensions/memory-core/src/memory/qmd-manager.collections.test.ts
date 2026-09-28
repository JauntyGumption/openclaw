// QMD collection migration and reconciliation behavior.
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
  expectMockMessageContains,
  expectMockMessageNotContains,
  fs,
  it,
  logWarnMock,
  makeQmdChild,
  path,
  requireValue,
  resolveMemoryBackendConfigForTest,
  spawnMock,
  stateDir,
  tmpRoot,
  trackManager,
  withLeaseMock,
  workspaceDir,
} from "./qmd-manager.test.support.js";

describe("QmdMemoryManager collection reconciliation", () => {
  it("rebinds sessions collection when existing collection path targets another agent", async () => {
    const devAgentId = "dev";
    const devWorkspaceDir = path.join(tmpRoot, "workspace-dev");
    await fs.mkdir(devWorkspaceDir);
    configureQmd(
      {
        paths: [{ path: devWorkspaceDir, pattern: "**/*.md", name: "workspace" }],
        sessions: { enabled: true },
      },
      {
        agents: {
          list: [
            { id: agentId, default: true, workspace: workspaceDir },
            { id: devAgentId, workspace: devWorkspaceDir },
          ],
        },
      },
    );

    const sessionCollectionName = `sessions-${devAgentId}`;
    const wrongSessionsPath = path.join(stateDir, "agents", agentId, "qmd", "sessions");
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        return makeQmdChild({
          data: JSON.stringify([
            { name: sessionCollectionName, path: wrongSessionsPath, mask: "**/*.md" },
          ]),
        });
      }
      return createMockChild();
    });

    const resolved = resolveMemoryBackendConfigForTest(cfg, devAgentId);
    const manager = trackManager(
      await QmdMemoryManager.create({
        cfg,
        agentId: devAgentId,
        resolved,
        withLease: withLeaseMock,
        mode: "full",
      }),
    );
    await requireValue(manager, "manager missing").close();

    const commands = spawnMock.mock.calls.map((call: unknown[]) => call[1] as string[]);
    const removeSessions = commands.find(
      (args) =>
        args[0] === "collection" && args[1] === "remove" && args[2] === sessionCollectionName,
    );
    requireValue(removeSessions, "sessions collection remove command missing");

    const addSessions = commands.find((args) => {
      if (args[0] !== "collection" || args[1] !== "add") {
        return false;
      }
      const nameIdx = args.indexOf("--name");
      return nameIdx >= 0 && args[nameIdx + 1] === sessionCollectionName;
    });
    expect(requireValue(addSessions, "sessions collection add command missing")[2]).toBe(
      path.join(stateDir, "agents", devAgentId, "qmd", "sessions"),
    );
  });

  it("avoids destructive rebind when qmd only reports collection names", async () => {
    configureQmd({ sessions: { enabled: true } });

    const sessionCollectionName = `sessions-${agentId}`;
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        return makeQmdChild({
          data: JSON.stringify([`workspace-${agentId}`, sessionCollectionName]),
        });
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    const commands = spawnMock.mock.calls.map((call: unknown[]) => call[1] as string[]);
    const removeCalls = commands.filter((args) => args[0] === "collection" && args[1] === "remove");
    expect(removeCalls).toHaveLength(0);

    const addCalls = commands.filter((args) => args[0] === "collection" && args[1] === "add");
    expect(addCalls).toHaveLength(0);
  });

  it("rebinds collection when qmd text output exposes a changed pattern without a path", async () => {
    configureQmd();

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        return makeQmdChild({
          data: [
            "workspace-main (qmd://workspace-main/)",
            "  Pattern:  *.txt",
            "  Files:    17",
          ].join("\n"),
        });
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    const commands = spawnMock.mock.calls.map((call: unknown[]) => call[1] as string[]);
    const removeCalls = commands.filter(
      (args) => args[0] === "collection" && args[1] === "remove" && args[2] === "workspace-main",
    );
    expect(removeCalls).toHaveLength(1);

    const addCall = commands.find((args) => {
      if (args[0] !== "collection" || args[1] !== "add") {
        return false;
      }
      const nameIdx = args.indexOf("--name");
      return nameIdx >= 0 && args[nameIdx + 1] === "workspace-main";
    });
    const workspaceAddCall = requireValue(addCall, "workspace collection add command missing");
    expect(workspaceAddCall[2]).toBe(workspaceDir);
    expect(workspaceAddCall).toContain("**/*.md");
  });

  it("migrates unscoped legacy collections before adding scoped names", async () => {
    configureQmd({ includeDefaultMemory: true, paths: [] });

    const legacyCollections = new Map<
      string,
      {
        path: string;
        pattern: string;
      }
    >([
      ["memory-root", { path: workspaceDir, pattern: "MEMORY.md" }],
      ["memory-dir", { path: path.join(workspaceDir, "memory"), pattern: "**/*.md" }],
    ]);
    const removeCalls: string[] = [];

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        return makeQmdChild({
          data: JSON.stringify(
            [...legacyCollections.entries()].map(([name, info]) => ({
              name,
              path: info.path,
              mask: info.pattern,
            })),
          ),
        });
      }
      if (args[0] === "collection" && args[1] === "remove") {
        const child = createMockChild({ autoClose: false });
        const name = args[2] ?? "";
        removeCalls.push(name);
        legacyCollections.delete(name);
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      if (args[0] === "collection" && args[1] === "add") {
        const child = createMockChild({ autoClose: false });
        const pathArg = args[2] ?? "";
        const name = args[args.indexOf("--name") + 1] ?? "";
        const globIdx = args.indexOf("--glob");
        const maskIdx = args.indexOf("--mask");
        const pattern =
          (globIdx !== -1 ? args[globIdx + 1] : maskIdx !== -1 ? args[maskIdx + 1] : "") ?? "";
        const hasConflict = [...legacyCollections.entries()].some(
          ([existingName, info]) =>
            existingName !== name && info.path === pathArg && info.pattern === pattern,
        );
        if (hasConflict) {
          emitAndClose(child, "stderr", "collection already exists", 1);
          return child;
        }
        legacyCollections.set(name, { path: pathArg, pattern });
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    expect(removeCalls).toEqual(["memory-root", "memory-dir"]);
    expect(legacyCollections.has("memory-root-main")).toBe(true);
    expect(legacyCollections.has("memory-dir-main")).toBe(true);
    expect(legacyCollections.has("memory-root")).toBe(false);
    expect(legacyCollections.has("memory-dir")).toBe(false);
    expect(legacyCollections.has("memory-alt-main")).toBe(false);
    expect(legacyCollections.has("memory-alt")).toBe(false);
  });

  it("rebinds conflicting collection name when path+pattern slot is already occupied", async () => {
    configureQmd({ includeDefaultMemory: true, paths: [] });

    const listedCollections = new Map<
      string,
      {
        path: string;
        pattern: string;
      }
    >([["memory-root-sonnet", { path: workspaceDir, pattern: "MEMORY.md" }]]);
    const removeCalls: string[] = [];

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        return makeQmdChild({
          data: JSON.stringify(
            [...listedCollections.entries()].map(([name, info]) => ({
              name,
              path: info.path,
              mask: info.pattern,
            })),
          ),
        });
      }
      if (args[0] === "collection" && args[1] === "remove") {
        const child = createMockChild({ autoClose: false });
        const name = args[2] ?? "";
        removeCalls.push(name);
        listedCollections.delete(name);
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      if (args[0] === "collection" && args[1] === "add") {
        const child = createMockChild({ autoClose: false });
        const pathArg = args[2] ?? "";
        const name = args[args.indexOf("--name") + 1] ?? "";
        const globIdx = args.indexOf("--glob");
        const maskIdx = args.indexOf("--mask");
        const pattern =
          (globIdx !== -1 ? args[globIdx + 1] : maskIdx !== -1 ? args[maskIdx + 1] : "") ?? "";
        const hasConflict = [...listedCollections.entries()].some(
          ([existingName, info]) =>
            existingName !== name && info.path === pathArg && info.pattern === pattern,
        );
        if (hasConflict) {
          emitAndClose(child, "stderr", "A collection already exists for this path and pattern", 1);
          return child;
        }
        listedCollections.set(name, { path: pathArg, pattern });
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    expect(removeCalls).toContain("memory-root-sonnet");
    expect(listedCollections.has("memory-root-main")).toBe(true);
    expectMockMessageContains(logWarnMock, "rebinding");
  });

  it("adds canonical memory-root without treating legacy memory-alt as equivalent", async () => {
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# canonical root");
    configureQmd({ includeDefaultMemory: true, paths: [] });

    const listedCollections = new Map<
      string,
      {
        path: string;
        pattern: string;
      }
    >([["memory-alt", { path: workspaceDir, pattern: "memory.md" }]]);
    const removeCalls: string[] = [];

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        return makeQmdChild({
          data: JSON.stringify(
            [...listedCollections.entries()].map(([name, info]) => ({
              name,
              path: info.path,
              mask: info.pattern,
            })),
          ),
        });
      }
      if (args[0] === "collection" && args[1] === "remove") {
        const child = createMockChild({ autoClose: false });
        const name = args[2] ?? "";
        removeCalls.push(name);
        listedCollections.delete(name);
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      if (args[0] === "collection" && args[1] === "add") {
        const child = createMockChild({ autoClose: false });
        const pathArg = args[2] ?? "";
        const name = args[args.indexOf("--name") + 1] ?? "";
        const patternIndex = args.includes("--glob")
          ? args.indexOf("--glob") + 1
          : args.includes("--mask")
            ? args.indexOf("--mask") + 1
            : -1;
        const pattern = patternIndex >= 0 ? (args[patternIndex] ?? "") : "";
        const hasConflict = [...listedCollections.entries()].some(
          ([existingName, info]) =>
            existingName !== name && info.path === pathArg && info.pattern === pattern,
        );
        if (hasConflict) {
          emitAndClose(child, "stderr", "A collection already exists for this path and pattern", 1);
          return child;
        }
        listedCollections.set(name, { path: pathArg, pattern });
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    expect(removeCalls).not.toContain("memory-alt");
    expect(listedCollections.has("memory-root-main")).toBe(true);
    expect(listedCollections.has("memory-alt")).toBe(true);
    expectMockMessageNotContains(logWarnMock, "rebinding");
  });

  it("warns instead of silently succeeding when add conflict metadata is unavailable", async () => {
    configureQmd();

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        // Name-only rows do not expose path/mask metadata.
        return makeQmdChild({ data: JSON.stringify(["workspace-legacy"]) });
      }
      if (args[0] === "collection" && args[1] === "add") {
        return makeQmdChild({ stream: "stderr", data: "collection already exists", code: 1 });
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    expectMockMessageContains(logWarnMock, "qmd collection add skipped for workspace-main");
  });

  it("surfaces a manual repair hint for stderr-only path-pattern conflicts", async () => {
    configureQmd();

    let staleCollectionExists = true;
    const removeCalls: string[] = [];
    const addCalls: string[] = [];

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        // Older qmd output may expose only names, so path/pattern matching cannot find this.
        return makeQmdChild({ data: JSON.stringify(["workspace-legacy"]) });
      }
      if (args[0] === "collection" && args[1] === "remove") {
        const child = createMockChild({ autoClose: false });
        const name = args[2] ?? "";
        removeCalls.push(name);
        if (name === "workspace-legacy") {
          staleCollectionExists = false;
        }
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      if (args[0] === "collection" && args[1] === "add") {
        const child = createMockChild({ autoClose: false });
        const name = args[args.indexOf("--name") + 1] ?? "";
        addCalls.push(name);
        if (staleCollectionExists && name === "workspace-main") {
          emitAndClose(
            child,
            "stderr",
            [
              "A collection already exists for this path and pattern:",
              "  Name: workspace-legacy (qmd://workspace-legacy/)",
              "  Pattern: **/*.md",
              "",
              "Use 'qmd update' to re-index it, or remove it first with 'qmd collection remove workspace-legacy'",
            ].join("\n"),
            1,
          );
          return child;
        }
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    expect(removeCalls).toEqual([]);
    expect(addCalls).toEqual(["workspace-main"]);
    expectMockMessageNotContains(logWarnMock, "rebinding");
    expectMockMessageContains(
      logWarnMock,
      "qmd reported existing collection workspace-legacy, but list output did not include verifiable path/pattern metadata",
    );
    expectMockMessageContains(logWarnMock, "qmd collection remove workspace-legacy");
    expectMockMessageContains(logWarnMock, "qmd collection add skipped for workspace-main");
  });

  it("recreates a managed collection when list fails but add reports the same name exists", async () => {
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# canonical root");
    configureQmd({ includeDefaultMemory: true, paths: [] });

    const removed: string[] = [];
    const added = new Map<string, string>();
    const addAttempts = new Map<string, number>();
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        return makeQmdChild({ stream: "stderr", data: "temporary qmd list failure", code: 1 });
      }
      if (args[0] === "collection" && args[1] === "remove") {
        const child = createMockChild({ autoClose: false });
        const name = args[2] ?? "";
        removed.push(name);
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      if (args[0] === "collection" && args[1] === "add") {
        const child = createMockChild({ autoClose: false });
        const name = args[args.indexOf("--name") + 1] ?? "";
        const patternIndex = args.includes("--glob")
          ? args.indexOf("--glob") + 1
          : args.includes("--mask")
            ? args.indexOf("--mask") + 1
            : -1;
        const pattern = patternIndex >= 0 ? (args[patternIndex] ?? "") : "";
        const attempts = addAttempts.get(name) ?? 0;
        addAttempts.set(name, attempts + 1);
        if (name === "memory-root-main" && attempts === 0) {
          emitAndClose(child, "stderr", "Collection 'memory-root-main' already exists.", 1);
          return child;
        }
        added.set(name, pattern);
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    expect(removed).toContain("memory-root-main");
    expect(added.get("memory-root-main")).toBe("MEMORY.md");
    expectMockMessageContains(
      logWarnMock,
      "qmd collection add conflict for memory-root-main: collection name already exists",
    );
    expectMockMessageNotContains(logWarnMock, "qmd collection add skipped for memory-root-main");
  });

  it("rebinds memory-root when qmd table output has a stale broad pattern", async () => {
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# canonical root");
    configureQmd({ includeDefaultMemory: true, paths: [] });

    const removed: string[] = [];
    const added = new Map<string, string>();
    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "collection" && args[1] === "list") {
        return makeQmdChild({
          data: [
            "Collections (2):",
            "",
            "memory-dir-main (qmd://memory-dir-main/)",
            "  Pattern:  **/*.md",
            "",
            "memory-root-main (qmd://memory-root-main/)",
            "  Pattern:  **/*.md",
            "",
          ].join("\n"),
        });
      }
      if (args[0] === "collection" && args[1] === "remove") {
        const child = createMockChild({ autoClose: false });
        const name = args[2] ?? "";
        removed.push(name);
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      if (args[0] === "collection" && args[1] === "add") {
        const child = createMockChild({ autoClose: false });
        const name = args[args.indexOf("--name") + 1] ?? "";
        const patternIndex = args.includes("--glob")
          ? args.indexOf("--glob") + 1
          : args.includes("--mask")
            ? args.indexOf("--mask") + 1
            : -1;
        const pattern = patternIndex >= 0 ? (args[patternIndex] ?? "") : "";
        added.set(name, pattern);
        queueMicrotask(() => child.closeWith(0));
        return child;
      }
      return createMockChild();
    });

    const { manager } = await createManager({ mode: "full" });
    await manager.close();

    expect(removed).toContain("memory-root-main");
    expect(added.get("memory-root-main")).toBe("MEMORY.md");
    expect(removed).not.toContain("memory-dir-main");
  });
});
