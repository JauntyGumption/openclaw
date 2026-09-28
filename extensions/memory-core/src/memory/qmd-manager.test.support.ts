import { spawn as mockedSpawn } from "node:child_process";
// Shared fixtures and mocks for the split memory-manager test suites.
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setTimeout as scheduleNativeTimeout } from "node:timers";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  type MemorySearchRuntimeDebug,
  requireNodeSqlite,
  resolveMemoryBackendConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import type {
  PluginStateLeaseContext,
  PluginStateLeaseOptions,
  PluginStateLeaseRunner,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { PluginStateLeaseError } from "openclaw/plugin-sdk/plugin-state-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { formatSessionTranscriptMemoryHitKey } from "openclaw/plugin-sdk/session-transcript-hit";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withMockedWindowsPlatform } from "openclaw/plugin-sdk/test-node-mocks";
import type { Mock } from "vitest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { configureMemoryCoreDreamingState } from "../dreaming-state.js";
import { resolveQmdSessionArtifactIdentity } from "../qmd-session-artifacts.js";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";
import { parseListedQmdCollections, parseShownQmdCollection } from "./qmd-collection-metadata.js";
import { QmdMemoryManager, resolveQmdMcporterSearchProcessTimeoutMs } from "./qmd-manager.js";
import { MEMORY_SEARCH_DEADLINE_CONTROL } from "./search-deadline.js";

// Memory Core tests cover qmd manager plugin behavior.

const { logWarnMock, logDebugMock, logInfoMock } = vi.hoisted(() => ({
  logWarnMock: vi.fn(),
  logDebugMock: vi.fn(),
  logInfoMock: vi.fn(),
}));

const { watchMock } = vi.hoisted(() => ({
  watchMock: vi.fn(() => {
    // SAFETY: the watcher fixture intentionally augments a plain EventEmitter with the minimal chokidar-like members exercised by these tests.
    const watcher = new EventEmitter() as EventEmitter & {
      watchedEntries: Record<string, string[]>;
    };
    watcher.watchedEntries = {};
    return Object.assign(watcher, {
      close: vi.fn(async () => undefined),
      getWatched: vi.fn(() => watcher.watchedEntries),
    });
  }),
}));

const { withLeaseMock } = vi.hoisted(() => {
  const implementation: PluginStateLeaseRunner = async <T>(
    options: PluginStateLeaseOptions,
    run: (lease: PluginStateLeaseContext) => Promise<T>,
  ) =>
    await run({
      signal: options.signal ?? new AbortController().signal,
      assertOwned: vi.fn(),
    });
  return {
    // SAFETY: vi.fn wraps the lease runner implementation while preserving the same callable contract used by the manager under test.
    withLeaseMock: vi.fn(implementation) as Mock<PluginStateLeaseRunner> & PluginStateLeaseRunner,
  };
});

const MEMORY_EMBEDDING_PROVIDERS_KEY = Symbol.for("openclaw.memoryEmbeddingProviders");

const MCPORTER_STATE_KEY = Symbol.for("openclaw.mcporterState");

const QMD_EMBED_QUEUE_KEY = Symbol.for("openclaw.qmdEmbedQueueTail");

const QMD_UPDATE_QUEUE_KEY = Symbol.for("openclaw.qmdUpdateQueueState");

const BUILT_IN_WATCH_DEBOUNCE_MS = 1_500;

type WatchOptions = {
  ignored?: (watchPath: string) => boolean;
};

type LeaseCall = Parameters<PluginStateLeaseRunner>;

type QmdTestConfig = NonNullable<NonNullable<OpenClawConfig["memory"]>["qmd"]> & {
  mcporter?: { enabled?: boolean; serverName?: string; startDaemon?: boolean };
  update?: {
    commandTimeoutMs?: number;
    debounceMs?: number;
    embedInterval?: string;
    embedTimeoutMs?: number;
    interval?: string;
    onBoot?: boolean;
    startup?: "off" | "idle" | "blocking";
    startupDelayMs?: number;
    updateTimeoutMs?: number;
    waitForBootSync?: boolean;
  };
};

type QmdConfigOverrides = {
  agents?: OpenClawConfig["agents"];
  search?: NonNullable<NonNullable<OpenClawConfig["memory"]>["search"]> & {
    sync?: { watch?: boolean; onSessionStart?: boolean; onSearch?: boolean };
  };
};

type MockStream = EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };

interface MockChild extends EventEmitter {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdout: MockStream;
  stderr: MockStream;
  kill: (signal?: NodeJS.Signals) => boolean;
  closeWith: (code?: number | null) => void;
}

function createMockChild(params?: { autoClose?: boolean; closeDelayMs?: number }): MockChild {
  const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
  const child: MockChild = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    stdout,
    stderr,
    closeWith: (code: number | null = 0) => {
      child.exitCode = code;
      child.emit("close", code, child.signalCode);
    },
    kill: (signal: NodeJS.Signals = "SIGTERM") => {
      child.signalCode = signal;
      // Let timeout rejection win in tests that simulate hung QMD commands.
      return true;
    },
  });
  if (params?.autoClose !== false) {
    const delayMs = params?.closeDelayMs ?? 0;
    if (delayMs <= 0) {
      queueMicrotask(() => {
        child.emit("close", 0);
      });
    } else {
      scheduleNativeTimeout(() => {
        child.emit("close", 0);
      }, delayMs);
    }
  }
  return child;
}

function emitAndClose(child: MockChild, stream: "stdout" | "stderr", data: string, code = 0) {
  queueMicrotask(() => {
    child[stream].emit("data", data);
    child.closeWith(code);
  });
}

function makeQmdChild(
  overrides: {
    stream?: "stdout" | "stderr";
    data?: string;
    code?: number;
  } = {},
): MockChild {
  const output = { stream: "stdout" as const, data: "[]", code: 0, ...overrides };
  const child = createMockChild({ autoClose: false });
  emitAndClose(child, output.stream, output.data, output.code);
  return child;
}

function makeMcporterChild(results: unknown[] = []): MockChild {
  return makeQmdChild({ data: JSON.stringify({ results }) });
}

function makeQmdResults(...results: unknown[]): MockChild {
  return makeQmdChild({ data: JSON.stringify(results) });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => {
      scheduleNativeTimeout(resolve, 10);
    });
  }
}

function isMcporterCommand(cmd: unknown): boolean {
  if (typeof cmd !== "string") {
    return false;
  }
  return /(^|[\\/])mcporter(?:\.cmd)?$/i.test(cmd);
}

function firstWatchOptions(): WatchOptions {
  // SAFETY: the first watchMock call in these tests always passes [paths, options]; this helper throws when no such call exists.
  const call = watchMock.mock.calls[0] as unknown as [string[], WatchOptions] | undefined;
  if (!call) {
    throw new Error("Expected watch call");
  }
  return call[1];
}

function firstWatchPaths(): string[] {
  // SAFETY: the first watchMock call in these tests always passes [paths, options]; this helper throws when no such call exists.
  const call = watchMock.mock.calls[0] as unknown as [string[], WatchOptions] | undefined;
  if (!call) {
    throw new Error("Expected watch call");
  }
  return call[0];
}

function firstEmbedLeaseCall(): LeaseCall {
  const call = withLeaseMock.mock.calls.find(
    (entry) => entry[0].database.scope === "shared" && entry[0].key === "embed",
    // SAFETY: withLeaseMock stores its recorded invocations in the PluginStateLeaseRunner parameter tuple shape; undefined is handled below.
  ) as LeaseCall | undefined;
  if (!call) {
    throw new Error("Expected qmd embed lease call");
  }
  return call;
}

function writeLeaseCalls(): LeaseCall[] {
  return withLeaseMock.mock.calls.filter(
    (entry) => entry[0].database.scope === "agent" && entry[0].key === "write",
    // SAFETY: withLeaseMock stores its recorded invocations in the PluginStateLeaseRunner parameter tuple shape, so filtered entries can be treated as LeaseCall tuples.
  ) as LeaseCall[];
}

function firstWriteLeaseCall(): LeaseCall {
  const call = writeLeaseCalls()[0];
  if (!call) {
    throw new Error("Expected qmd store write lease call");
  }
  return call;
}

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-foundation", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/memory-core-host-engine-foundation")
  >("openclaw/plugin-sdk/memory-core-host-engine-foundation");
  return {
    ...actual,
    createSubsystemLogger: () => {
      const logger = {
        warn: logWarnMock,
        debug: logDebugMock,
        info: logInfoMock,
        child: () => logger,
      };
      return logger;
    },
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

vi.mock("chokidar", () => ({
  default: { watch: watchMock },
  watch: watchMock,
}));

// SAFETY: the child_process mock above replaces spawn with vi.fn(), so the imported binding is the same spy instance used throughout these tests.
const spawnMock = mockedSpawn as unknown as Mock;

const originalPath = process.env.PATH;

const originalPathExt = process.env.PATHEXT;

const originalWindowsPath = process.env.Path;

const originalQmdStateDir = process.env.OPENCLAW_STATE_DIR;

function expectedQmdProvenance(originClass: "agent" | "untrusted") {
  return {
    originClass,
    sessionKind: "unknown",
    observedAt: expect.any(Number),
  };
}

function setQmdStateDir(stateDir: string): void {
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", stateDir);
}

async function seedQmdSessionTranscript(params: {
  agentId: string;
  content: string;
  sessionId: string;
  stateDir: string;
  sessionKey?: string;
  timestamp?: number | string;
}): Promise<void> {
  const sessionsDir = path.join(params.stateDir, "agents", params.agentId, "sessions");
  const storePath = path.join(sessionsDir, "sessions.json");
  const sessionKey = params.sessionKey ?? `agent:${params.agentId}:qmd:${params.sessionId}`;
  const timestamp =
    typeof params.timestamp === "number"
      ? params.timestamp
      : params.timestamp
        ? Date.parse(params.timestamp)
        : Date.now();
  await fs.mkdir(sessionsDir, { recursive: true });
  await upsertSessionEntry({
    agentId: params.agentId,
    sessionKey,
    storePath,
    entry: {
      sessionId: params.sessionId,
      updatedAt: timestamp,
    },
  });
  await appendSessionTranscriptMessageByIdentity({
    agentId: params.agentId,
    sessionId: params.sessionId,
    sessionKey,
    storePath,
    message: {
      role: "user",
      content: params.content,
      timestamp,
    },
  });
}

function restoreQmdStateDir(): void {
  if (originalQmdStateDir === undefined) {
    Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
  } else {
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", originalQmdStateDir);
  }
}

let fixtureRoot: string;

let fixtureCount = 0;

let tmpRoot: string;

let workspaceDir: string;

let stateDir: string;

let cfg: OpenClawConfig;

const agentId = "main";

const openManagers = new Set<QmdMemoryManager>();

let embedStartupJitterSpy: { mockRestore: () => void } | null = null;

function setEmbedStartupJitterSpy(spy: { mockRestore: () => void } | null): void {
  embedStartupJitterSpy = spy;
}

function setWorkspaceDir(nextWorkspaceDir: string): void {
  workspaceDir = nextWorkspaceDir;
}

function seedMemoryEmbeddingProviders(): void {
  // SAFETY: this test-only singleton key is intentionally used as a property bag for embedding provider fixtures.
  (globalThis as Record<PropertyKey, unknown>)[MEMORY_EMBEDDING_PROVIDERS_KEY] = new Map([
    [
      "openai",
      {
        adapter: {
          id: "openai",
          defaultModel: "text-embedding-3-small",
          transport: "remote",
          create: async () => ({ provider: null }),
        },
      },
    ],
  ]);
}

function trackManager<T extends QmdMemoryManager | null>(manager: T): T {
  if (manager) {
    openManagers.add(manager);
  }
  return manager;
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}

function requireArgAfter(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0) {
    throw new Error(`expected ${flag} argument`);
  }
  return expectDefined(args[index + 1], `${flag} argument value`);
}

function mockMessages(mock: Mock): string[] {
  return mock.mock.calls.map((call: unknown[]) => String(call[0]));
}

function qmdCommandCalls(): string[][] {
  // SAFETY: spawnMock records child_process.spawn calls as [command, args, options], so index 1 is the string[] argv array for each recorded call.
  return spawnMock.mock.calls.map((call: unknown[]) => call[1] as string[]);
}

function countQmdCommand(predicate: (args: string[]) => boolean): number {
  return qmdCommandCalls().filter(predicate).length;
}

function expectMockMessageContains(mock: Mock, text: string): void {
  expect(mockMessages(mock).join("\n")).toContain(text);
}

function expectMockMessageNotContains(mock: Mock, text: string): void {
  expect(mockMessages(mock).join("\n")).not.toContain(text);
}

function configureQmd(qmd: QmdTestConfig = {}, overrides: QmdConfigOverrides = {}): void {
  cfg = {
    ...cfg,
    ...(overrides.agents ? { agents: overrides.agents } : {}),
    memory: {
      backend: "qmd",
      qmd: {
        includeDefaultMemory: false,
        update: { interval: "0s", debounceMs: 60_000, onBoot: false },
        paths: [{ path: workspaceDir, pattern: "**/*.md", name: "workspace" }],
        ...qmd,
      },
      ...(overrides.search ? { search: overrides.search } : {}),
    },
  } as OpenClawConfig; // SAFETY: This helper constructs the exact config fragment consumed by the QMD resolver tests.
}

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.lstat(targetPath);
  } catch (error) {
    // SAFETY: fs.lstat rejects with a NodeJS.ErrnoException for missing-path checks in this Node test runtime.
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`expected missing path ${targetPath}`);
}

function qmdIndexConfigPath(selectedAgentId = agentId): string {
  return path.join(stateDir, "agents", selectedAgentId, "qmd", "xdg-config", "qmd", "index.yml");
}

function resolveMemoryBackendConfigForTest(sourceCfg: OpenClawConfig, selectedAgentId: string) {
  const resolved = resolveMemoryBackendConfig({ cfg: sourceCfg, agentId: selectedAgentId });
  // SAFETY: Focused tests author this optional QMD fragment and read only the listed legacy test knobs.
  const qmdTestConfig = sourceCfg.memory?.qmd as
    | {
        mcporter?: { enabled?: boolean; serverName?: string; startDaemon?: boolean };
        update?: {
          commandTimeoutMs?: number;
          debounceMs?: number;
          embedInterval?: string;
          embedTimeoutMs?: number;
          interval?: string;
          onBoot?: boolean;
          startup?: "off" | "idle" | "blocking";
          startupDelayMs?: number;
          updateTimeoutMs?: number;
          waitForBootSync?: boolean;
        };
      }
    | undefined;
  if (!resolved.qmd) {
    return resolved;
  }

  // Removed config knobs still drive focused manager mechanics in this test file only.
  Object.assign(resolved.qmd.mcporter, qmdTestConfig?.mcporter);
  const update = qmdTestConfig?.update;
  if (!update) {
    return resolved;
  }
  const parseInterval = (value: string | undefined, defaultUnitMs: number) => {
    if (!value) {
      return undefined;
    }
    const match = /^(\d+)(ms|s|m|h)?$/.exec(value.trim());
    if (!match) {
      return undefined;
    }
    const amount = Number(match[1]);
    const unitMsBySuffix: Record<string, number> = {
      ms: 1,
      s: 1_000,
      m: 60_000,
      h: 3_600_000,
    };
    return amount * (unitMsBySuffix[match[2] ?? ""] ?? defaultUnitMs);
  };
  Object.assign(resolved.qmd.update, {
    ...(update.interval !== undefined
      ? { intervalMs: parseInterval(update.interval, 60_000) }
      : {}),
    ...(update.debounceMs !== undefined ? { debounceMs: update.debounceMs } : {}),
    ...(update.onBoot !== undefined ? { onBoot: update.onBoot } : {}),
    ...(update.startup !== undefined ? { startup: update.startup } : {}),
    ...(update.startupDelayMs !== undefined ? { startupDelayMs: update.startupDelayMs } : {}),
    ...(update.waitForBootSync !== undefined ? { waitForBootSync: update.waitForBootSync } : {}),
    ...(update.embedInterval !== undefined
      ? { embedIntervalMs: parseInterval(update.embedInterval, 60_000) }
      : {}),
    ...(update.commandTimeoutMs !== undefined ? { commandTimeoutMs: update.commandTimeoutMs } : {}),
    ...(update.updateTimeoutMs !== undefined ? { updateTimeoutMs: update.updateTimeoutMs } : {}),
    ...(update.embedTimeoutMs !== undefined ? { embedTimeoutMs: update.embedTimeoutMs } : {}),
  });
  return resolved;
}

async function createManager(params?: {
  mode?: "full" | "status" | "cli";
  cfg?: OpenClawConfig;
  agentId?: string;
}) {
  const sourceCfg = params?.cfg ?? cfg;
  const cfgToUse: OpenClawConfig = {
    ...sourceCfg,
    memory: {
      ...sourceCfg.memory,
      search: {
        rememberAcrossConversations: false,
        ...sourceCfg.memory?.search,
      },
    },

    agents: {
      ...sourceCfg.agents,
      defaults: {
        ...sourceCfg.agents?.defaults,
      },
    },
  };
  const selectedAgentId = params?.agentId ?? agentId;
  const resolved = resolveMemoryBackendConfigForTest(cfgToUse, selectedAgentId);
  const manager = trackManager(
    await QmdMemoryManager.create({
      cfg: cfgToUse,
      agentId: selectedAgentId,
      resolved,
      withLease: withLeaseMock,
      mode: params?.mode ?? "status",
    }),
  );
  return { manager: requireValue(manager, "manager missing"), resolved };
}

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qmd-manager-test-fixtures-"));
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  // SAFETY: these test-only singleton keys are intentionally stored on globalThis and may be deleted between cases to reset shared state.
  delete (globalThis as Record<PropertyKey, unknown>)[MCPORTER_STATE_KEY];
  // SAFETY: these test-only singleton keys are intentionally stored on globalThis and may be deleted between cases to reset shared state.
  delete (globalThis as Record<PropertyKey, unknown>)[QMD_EMBED_QUEUE_KEY];
  // SAFETY: these test-only singleton keys are intentionally stored on globalThis and may be deleted between cases to reset shared state.
  delete (globalThis as Record<PropertyKey, unknown>)[QMD_UPDATE_QUEUE_KEY];
  // SAFETY: these test-only singleton keys are intentionally stored on globalThis and may be deleted between cases to reset shared state.
  delete (globalThis as Record<PropertyKey, unknown>)[MEMORY_EMBEDDING_PROVIDERS_KEY];
  spawnMock.mockClear();
  spawnMock.mockImplementation(() => createMockChild());
  watchMock.mockClear();
  withLeaseMock.mockReset();
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
  logWarnMock.mockClear();
  logDebugMock.mockClear();
  logInfoMock.mockClear();
  tmpRoot = path.join(fixtureRoot, `case-${fixtureCount++}`);
  workspaceDir = path.join(tmpRoot, "workspace");
  stateDir = path.join(tmpRoot, "state");
  // Only workspace must exist for configured collection paths; state paths are
  // created lazily by manager code when needed.
  await fs.mkdir(workspaceDir, { recursive: true });
  setQmdStateDir(stateDir);
  // Keep the default Windows path unresolved for most tests so spawn mocks can
  // match the logical package command. Tests that verify wrapper resolution
  // install explicit shim fixtures inline.
  configureQmd(
    {},
    {
      agents: {
        defaults: { workspace: workspaceDir },
        list: [{ id: agentId, default: true, workspace: workspaceDir }],
      },
      search: {
        provider: "openai",
        model: "mock-embed",
        rememberAcrossConversations: false,
        store: { vector: { enabled: false } },
        sync: { watch: false, onSessionStart: false, onSearch: false },
      },
    },
  );
  seedMemoryEmbeddingProviders();
  embedStartupJitterSpy = vi
    .spyOn(
      // SAFETY: the production prototype does expose resolveEmbedStartupJitterMs at runtime; this narrowed test view names only the spied method.
      QmdMemoryManager.prototype as unknown as {
        resolveEmbedStartupJitterMs: () => number;
      },
      "resolveEmbedStartupJitterMs",
    )
    .mockReturnValue(0);
});

afterEach(async () => {
  await Promise.all(
    Array.from(openManagers, async (manager) => {
      await manager.close();
    }),
  );
  openManagers.clear();
  embedStartupJitterSpy?.mockRestore();
  embedStartupJitterSpy = null;
  vi.useRealTimers();
  restoreQmdStateDir();
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  if (originalPathExt === undefined) {
    delete process.env.PATHEXT;
  } else {
    process.env.PATHEXT = originalPathExt;
  }
  if (originalWindowsPath === undefined) {
    delete process.env.Path;
  } else {
    process.env.Path = originalWindowsPath;
  }
  // SAFETY: these test-only singleton keys are intentionally stored on globalThis and may be deleted between cases to reset shared state.
  delete (globalThis as Record<PropertyKey, unknown>)[MCPORTER_STATE_KEY];
  // SAFETY: these test-only singleton keys are intentionally stored on globalThis and may be deleted between cases to reset shared state.
  delete (globalThis as Record<PropertyKey, unknown>)[QMD_EMBED_QUEUE_KEY];
  // SAFETY: these test-only singleton keys are intentionally stored on globalThis and may be deleted between cases to reset shared state.
  delete (globalThis as Record<PropertyKey, unknown>)[MEMORY_EMBEDDING_PROVIDERS_KEY];
  resetMemoryCoreDreamingStateForTests();
  closeOpenClawAgentDatabasesForTest();
});

function createDeferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  if (!resolve || !reject) {
    throw new Error("Expected deferred callbacks to be initialized");
  }
  return { promise, resolve, reject };
}

const testExportMAX_TIMER_TIMEOUT_MS = MAX_TIMER_TIMEOUT_MS;
const testExportMEMORY_SEARCH_DEADLINE_CONTROL = MEMORY_SEARCH_DEADLINE_CONTROL;
const testExportPluginStateLeaseError = PluginStateLeaseError;
const testExportQmdMemoryManager = QmdMemoryManager;
const testExportAfterEach = afterEach;
const testExportBeforeEach = beforeEach;
const testExportConfigureMemoryCoreDreamingState = configureMemoryCoreDreamingState;
const testExportConfigureMemoryCoreDreamingStateForTests = configureMemoryCoreDreamingStateForTests;
const testExportDescribe = describe;
const testExportExpect = expect;
const testExportExpectDefined = expectDefined;
const testExportFormatSessionTranscriptMemoryHitKey = formatSessionTranscriptMemoryHitKey;
const testExportFs = fs;
const testExportIt = it;
const testExportParseListedQmdCollections = parseListedQmdCollections;
const testExportParseShownQmdCollection = parseShownQmdCollection;
const testExportPath = path;
const testExportRequireNodeSqlite = requireNodeSqlite;
const testExportResolveQmdMcporterSearchProcessTimeoutMs = resolveQmdMcporterSearchProcessTimeoutMs;
const testExportResolveQmdSessionArtifactIdentity = resolveQmdSessionArtifactIdentity;
const testExportVi = vi;
const testExportWithMockedWindowsPlatform = withMockedWindowsPlatform;

export {
  BUILT_IN_WATCH_DEBOUNCE_MS,
  testExportMAX_TIMER_TIMEOUT_MS as MAX_TIMER_TIMEOUT_MS,
  testExportMEMORY_SEARCH_DEADLINE_CONTROL as MEMORY_SEARCH_DEADLINE_CONTROL,
  testExportPluginStateLeaseError as PluginStateLeaseError,
  testExportQmdMemoryManager as QmdMemoryManager,
  testExportAfterEach as afterEach,
  agentId,
  testExportBeforeEach as beforeEach,
  cfg,
  testExportConfigureMemoryCoreDreamingState as configureMemoryCoreDreamingState,
  testExportConfigureMemoryCoreDreamingStateForTests as configureMemoryCoreDreamingStateForTests,
  configureQmd,
  countQmdCommand,
  createDeferred,
  createManager,
  createMockChild,
  testExportDescribe as describe,
  embedStartupJitterSpy,
  emitAndClose,
  testExportExpect as expect,
  testExportExpectDefined as expectDefined,
  expectMockMessageContains,
  expectMockMessageNotContains,
  expectPathMissing,
  expectedQmdProvenance,
  firstEmbedLeaseCall,
  firstWatchOptions,
  firstWatchPaths,
  firstWriteLeaseCall,
  testExportFormatSessionTranscriptMemoryHitKey as formatSessionTranscriptMemoryHitKey,
  testExportFs as fs,
  isMcporterCommand,
  testExportIt as it,
  logDebugMock,
  logWarnMock,
  makeMcporterChild,
  makeQmdChild,
  makeQmdResults,
  testExportParseListedQmdCollections as parseListedQmdCollections,
  testExportParseShownQmdCollection as parseShownQmdCollection,
  testExportPath as path,
  qmdIndexConfigPath,
  requireArgAfter,
  testExportRequireNodeSqlite as requireNodeSqlite,
  requireValue,
  resolveMemoryBackendConfigForTest,
  testExportResolveQmdMcporterSearchProcessTimeoutMs as resolveQmdMcporterSearchProcessTimeoutMs,
  testExportResolveQmdSessionArtifactIdentity as resolveQmdSessionArtifactIdentity,
  seedQmdSessionTranscript,
  setEmbedStartupJitterSpy,
  setWorkspaceDir,
  spawnMock,
  stateDir,
  tmpRoot,
  trackManager,
  testExportVi as vi,
  waitUntil,
  watchMock,
  withLeaseMock,
  testExportWithMockedWindowsPlatform as withMockedWindowsPlatform,
  workspaceDir,
  writeLeaseCalls,
};

export type {
  DatabaseSync,
  LeaseCall,
  MemorySearchRuntimeDebug,
  Mock,
  MockChild,
  OpenClawConfig,
  PluginStateLeaseContext,
  PluginStateLeaseOptions,
};
