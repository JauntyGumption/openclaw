// Shared abort and command-matrix scenarios for split QMD manager search suites.
import {
  configureQmd,
  createManager,
  createMockChild,
  expect,
  fs,
  isMcporterCommand,
  makeQmdChild,
  path,
  requireValue,
  spawnMock,
  tmpRoot,
  vi,
  waitUntil,
  workspaceDir,
} from "./qmd-manager.test.support.js";
import type { MockChild } from "./qmd-manager.test.support.js";

type AbortSearchScenario = {
  name: string;
  qmd: Record<string, unknown> | (() => Record<string, unknown>);
  isTarget: (cmd: string, args: string[]) => boolean;
  preAborted?: boolean;
  outputFor?: (
    cmd: string,
    args: string[],
  ) => { stream: "stdout" | "stderr"; data: string; code?: number } | undefined;
  neverSpawns?: (cmd: string, args: string[]) => boolean;
};

type QmdCommandMatrixScenario = {
  name: string;
  configure: () => void | Promise<void>;
  supportsMultiCollection?: boolean;
  rejectSearchFlags?: boolean;
  expectedCommands: (maxResults: number) => string[][];
};

function createAbortChildHarness() {
  let child: MockChild | undefined;
  let kill: ReturnType<typeof vi.fn> | undefined;

  return {
    createChild(): MockChild {
      const current = createMockChild({ autoClose: false });
      const currentKill = vi.fn(() => {
        // Closing only after SIGKILL proves the caller abort reached this child.
        queueMicrotask(() => current.emit("close", null));
        return true;
      });
      Object.assign(current, { kill: currentKill });
      child ??= current;
      kill ??= currentKill;
      return current;
    },
    async waitForSpawn(): Promise<void> {
      await waitUntil(() => kill !== undefined);
    },
    expectKilled(): void {
      expect(child).toBeDefined();
      expect(kill).toHaveBeenCalledWith("SIGKILL");
    },
  };
}

async function runAbortSearchScenario(scenario: AbortSearchScenario): Promise<void> {
  configureQmd(typeof scenario.qmd === "function" ? scenario.qmd() : scenario.qmd);
  const abortChild = createAbortChildHarness();
  spawnMock.mockImplementation((cmd: string, args: string[]) => {
    if (scenario.isTarget(cmd, args)) {
      return abortChild.createChild();
    }
    const output = scenario.outputFor?.(cmd, args);
    if (output) {
      return makeQmdChild(output);
    }
    return createMockChild();
  });

  const { manager } = await createManager();
  const controller = new AbortController();
  if (scenario.preAborted) {
    controller.abort(new Error("memory_search timed out after 15s"));
  }
  const targetCallsBefore = spawnMock.mock.calls.filter((call: unknown[]) =>
    // SAFETY: spawnMock records child_process.spawn calls as [command, args, options], so index 1 is the string[] argv array under test.
    scenario.isTarget(String(call[0]), call[1] as string[]),
  ).length;
  const searchPromise = manager.search("test", {
    sessionKey: "agent:main:slack:dm:u123",
    signal: controller.signal,
  });
  searchPromise.catch(() => undefined);

  if (scenario.preAborted) {
    await expect(searchPromise).rejects.toThrow("memory_search timed out after 15s");
    const targetCallsAfter = spawnMock.mock.calls.filter((call: unknown[]) =>
      // SAFETY: spawnMock records child_process.spawn calls as [command, args, options], so index 1 is the string[] argv array under test.
      scenario.isTarget(String(call[0]), call[1] as string[]),
    ).length;
    expect(targetCallsAfter).toBe(targetCallsBefore);
    await manager.close();
    return;
  }

  await abortChild.waitForSpawn();
  controller.abort(new Error("memory_search timed out after 15s"));

  await expect(searchPromise).rejects.toThrow("memory_search timed out after 15s");
  abortChild.expectKilled();
  if (scenario.neverSpawns) {
    expect(
      spawnMock.mock.calls.some((call: unknown[]) =>
        // SAFETY: spawnMock records child_process.spawn calls as [command, args, options], so index 1 is the string[] argv array under test.
        scenario.neverSpawns?.(String(call[0]), call[1] as string[]),
      ),
    ).toBe(false);
  }
  await manager.close();
}

function qmdQueryArgs(
  command: "query" | "search",
  maxResults: number,
  ...collections: string[]
): string[] {
  return [
    command,
    "test",
    "--json",
    "-n",
    String(maxResults),
    ...collections.flatMap((collection) => ["-c", collection]),
  ];
}

function qmdCommandCalls(): string[][] {
  // SAFETY: spawnMock records child_process.spawn calls as [command, args, options], so index 1 is the string[] argv array for each recorded call.
  return spawnMock.mock.calls.map((call: unknown[]) => call[1] as string[]);
}

async function runQmdCommandMatrixScenario(scenario: QmdCommandMatrixScenario): Promise<void> {
  await scenario.configure();
  spawnMock.mockImplementation((_cmd: string, args: string[]) => {
    if (args[0] === "--help" && scenario.supportsMultiCollection) {
      return makeQmdChild({
        data: "-c, --collection <name>    Filter by one or more collections",
      });
    }
    if (args[0] === "search" && scenario.rejectSearchFlags) {
      return makeQmdChild({ stream: "stderr", data: "unknown flag: --json", code: 2 });
    }
    if (args[0] === "search" || args[0] === "query") {
      return makeQmdChild();
    }
    return createMockChild();
  });

  const { manager, resolved } = await createManager();
  const maxResults = requireValue(resolved.qmd?.limits.maxResults, "qmd maxResults missing");
  await expect(
    manager.search("test", { sessionKey: "agent:main:slack:dm:u123" }),
  ).resolves.toStrictEqual([]);
  const commandCalls = qmdCommandCalls().filter(
    (args) => args[0] === "search" || args[0] === "query",
  );
  expect(commandCalls).toEqual(scenario.expectedCommands(maxResults));
  await manager.close();
}

const abortSearchScenarios = [
  {
    name: "aborts the in-flight qmd search subprocess when the caller signal aborts",
    qmd: { searchMode: "query" },
    isTarget: (_cmd, args) => args[0] === "query",
  },
  {
    name: "rejects the qmd search before spawning when the caller signal is already aborted",
    qmd: { searchMode: "query" },
    isTarget: (_cmd, args) => args[0] === "query",
    preAborted: true,
  },
  {
    name: "aborts the in-flight grouped qmd search subprocess when the caller signal aborts",
    qmd: { sessions: { enabled: true } },
    isTarget: (_cmd, args) => args[0] === "search",
    outputFor: (_cmd, args) =>
      args[0] === "--help"
        ? {
            stream: "stdout",
            data: "-c, --collection <name>    Filter by one or more collections",
          }
        : undefined,
  },
  {
    name: "aborts the multi-collection capability probe without caching a failure",
    qmd: () => ({
      paths: [
        { path: workspaceDir, pattern: "**/*.md", name: "workspace" },
        { path: path.join(workspaceDir, "notes"), pattern: "**/*.md", name: "notes" },
      ],
    }),
    isTarget: (_cmd, args) => args[0] === "--help",
    outputFor: (_cmd, args) =>
      args[0] === "search" ? { stream: "stdout", data: "[]" } : undefined,
    neverSpawns: (_cmd, args) => args[0] === "search",
  },
  {
    name: "aborts the in-flight mcporter search subprocess when the caller signal aborts",
    qmd: {
      searchMode: "query",
      mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
    },
    isTarget: (cmd, args) => isMcporterCommand(cmd) && args[0] === "call",
  },
  {
    name: "rejects the mcporter search before spawning a call subprocess when the caller signal is already aborted",
    qmd: {
      searchMode: "query",
      mcporter: { enabled: true, serverName: "qmd", startDaemon: false },
    },
    isTarget: (cmd, args) => isMcporterCommand(cmd) && args[0] === "call",
    preAborted: true,
  },
] satisfies AbortSearchScenario[];

const qmdCommandMatrixScenarios = [
  {
    name: "scopes qmd queries to managed collections",
    configure: () =>
      configureQmd({
        paths: [
          { path: workspaceDir, pattern: "**/*.md", name: "workspace" },
          { path: path.join(workspaceDir, "notes"), pattern: "**/*.md", name: "notes" },
        ],
      }),
    expectedCommands: (maxResults) => [
      qmdQueryArgs("search", maxResults, "workspace-main"),
      qmdQueryArgs("search", maxResults, "notes-main"),
    ],
  },
  {
    name: "groups same-source qmd queries when the installed qmd supports multiple collection filters",
    configure: () =>
      configureQmd({
        paths: [
          { path: workspaceDir, pattern: "**/*.md", name: "workspace" },
          { path: path.join(workspaceDir, "notes"), pattern: "**/*.md", name: "notes" },
        ],
      }),
    supportsMultiCollection: true,
    expectedCommands: (maxResults) => [
      qmdQueryArgs("search", maxResults, "workspace-main", "notes-main"),
    ],
  },
  {
    name: "keeps mixed-source qmd queries in separate source groups",
    configure: () => configureQmd({ sessions: { enabled: true } }),
    supportsMultiCollection: true,
    expectedCommands: (maxResults) => [
      qmdQueryArgs("search", maxResults, "workspace-main"),
      qmdQueryArgs("search", maxResults, "sessions-main"),
    ],
  },
  {
    name: "does not query phantom memory-alt collections when MEMORY.md exists",
    configure: async () => {
      await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# canonical root");
      configureQmd({ includeDefaultMemory: true, paths: [] });
    },
    expectedCommands: (maxResults) => [
      qmdQueryArgs("search", maxResults, "memory-root-main"),
      qmdQueryArgs("search", maxResults, "memory-dir-main"),
    ],
  },
  {
    name: "uses explicit external custom collection names verbatim at query time",
    configure: async () => {
      const sharedMirrorDir = path.join(tmpRoot, "shared-notion-mirror");
      await fs.mkdir(sharedMirrorDir);
      configureQmd({
        paths: [{ path: sharedMirrorDir, pattern: "**/*.md", name: "notion-mirror" }],
      });
    },
    expectedCommands: (maxResults) => [qmdQueryArgs("search", maxResults, "notion-mirror")],
  },
  {
    name: "runs qmd query per collection when query mode has multiple collection filters",
    configure: () =>
      configureQmd({
        searchMode: "query",
        paths: [
          { path: workspaceDir, pattern: "**/*.md", name: "workspace" },
          { path: path.join(workspaceDir, "notes"), pattern: "**/*.md", name: "notes" },
        ],
      }),
    expectedCommands: (maxResults) => [
      qmdQueryArgs("query", maxResults, "workspace-main"),
      qmdQueryArgs("query", maxResults, "notes-main"),
    ],
  },
  {
    name: "uses per-collection query fallback when search mode rejects flags",
    configure: () =>
      configureQmd({
        searchMode: "search",
        paths: [
          { path: workspaceDir, pattern: "**/*.md", name: "workspace" },
          { path: path.join(workspaceDir, "notes"), pattern: "**/*.md", name: "notes" },
        ],
      }),
    rejectSearchFlags: true,
    expectedCommands: (maxResults) => [
      qmdQueryArgs("search", maxResults, "workspace-main"),
      qmdQueryArgs("query", maxResults, "workspace-main"),
      qmdQueryArgs("query", maxResults, "notes-main"),
    ],
  },
] satisfies QmdCommandMatrixScenario[];

export {
  abortSearchScenarios,
  qmdCommandMatrixScenarios,
  runAbortSearchScenario,
  runQmdCommandMatrixScenario,
};
