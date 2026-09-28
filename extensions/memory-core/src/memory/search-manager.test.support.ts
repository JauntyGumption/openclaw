// Shared fixtures and mocks for the split memory-manager test suites.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { checkQmdBinaryAvailability as checkQmdBinaryAvailabilityFn } from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import type {
  PluginStateLeaseContext,
  PluginStateLeaseOptions,
  PluginStateLeaseRunner,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QmdMemoryManager } from "./qmd-manager.js";
import {
  MEMORY_SEARCH_DEADLINE_CONTROL,
  runMemorySearchWithDeadline,
  type MemorySearchDeadlineControlOptions,
} from "./search-deadline.js";
import {
  closeAllMemorySearchManagers,
  closeMemorySearchManager,
  getMemorySearchManager as getMemorySearchManagerWithoutLease,
} from "./search-manager.js";

// Memory Core tests cover search manager plugin behavior.

type CheckQmdBinaryAvailability = typeof checkQmdBinaryAvailabilityFn;

function createManagerStatus(params: {
  backend: "qmd" | "builtin";
  provider: string;
  model: string;
  requestedProvider: string;
  withMemorySourceCounts?: boolean;
}) {
  const base = {
    backend: params.backend,
    provider: params.provider,
    model: params.model,
    requestedProvider: params.requestedProvider,
    files: 0,
    chunks: 0,
    dirty: false,
    workspaceDir: "/tmp",
    dbPath: "/tmp/index.sqlite",
  };
  if (!params.withMemorySourceCounts) {
    return base;
  }
  return {
    ...base,
    sources: ["memory" as const],
    sourceCounts: [{ source: "memory" as const, files: 0, chunks: 0 }],
  };
}

function nativePath(candidate: string): string {
  return path.resolve(candidate);
}

type ManagerSearchParams = Parameters<SearchManager["search"]>;

type ManagerSearchResult = Awaited<ReturnType<SearchManager["search"]>>;

function createManagerMock(params: {
  backend: "qmd" | "builtin";
  provider: string;
  model: string;
  requestedProvider: string;
  searchResults?: Array<{
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    snippet: string;
    source: "memory";
    projectKey?: string;
  }>;
  withMemorySourceCounts?: boolean;
}) {
  return {
    search: vi.fn(
      async (
        _query: ManagerSearchParams[0],
        _opts?: ManagerSearchParams[1],
      ): Promise<ManagerSearchResult> => params.searchResults ?? [],
    ),
    readFile: vi.fn(async () => ({ text: "", path: "MEMORY.md" })),
    listCuratedProjectCandidates: vi.fn(async () => params.searchResults ?? []),
    status: vi.fn(() =>
      createManagerStatus({
        backend: params.backend,
        provider: params.provider,
        model: params.model,
        requestedProvider: params.requestedProvider,
        withMemorySourceCounts: params.withMemorySourceCounts,
      }),
    ),
    sync: vi.fn(async () => {}),
    probeEmbeddingAvailability: vi.fn(async () => ({ ok: true })),
    probeVectorAvailability: vi.fn(async () => true),
    close: vi.fn(async () => {}),
  };
}

function createQmdManagerInstanceMock() {
  return createManagerMock({
    backend: "qmd",
    provider: "qmd",
    model: "qmd",
    requestedProvider: "qmd",
    withMemorySourceCounts: true,
  });
}

const mockPrimary = vi.hoisted(() => ({
  ...createQmdManagerInstanceMock(),
}));

const fallbackManager = vi.hoisted(() => ({
  ...createManagerMock({
    backend: "builtin",
    provider: "openai",
    model: "text-embedding-3-small",
    requestedProvider: "openai",
    searchResults: [
      {
        path: "MEMORY.md",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "fallback",
        source: "memory",
      },
    ],
  }),
}));

const fallbackSearch = fallbackManager.search;

const mockMemoryIndexGet = vi.hoisted(() => vi.fn(async () => fallbackManager));

const mockCloseAllMemoryIndexManagers = vi.hoisted(() => vi.fn(async () => {}));

const mockCloseMemoryIndexManagersForAgent = vi.hoisted(() => vi.fn(async () => {}));

const checkQmdBinaryAvailability = vi.hoisted(() =>
  vi.fn<CheckQmdBinaryAvailability>(async () => ({ available: true })),
);

vi.mock("./qmd-manager.js", () => ({
  QmdMemoryManager: {
    create: vi.fn(async () => mockPrimary),
  },
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-qmd", () => ({
  checkQmdBinaryAvailability,
  resolveQmdBinaryUnavailableReason: (result: { reason?: string }) => result.reason ?? "binary",
}));

vi.mock("../../manager-runtime.js", () => ({
  MemoryIndexManager: {
    get: mockMemoryIndexGet,
  },
  closeAllMemoryIndexManagers: mockCloseAllMemoryIndexManagers,
  closeMemoryIndexManagersForAgent: mockCloseMemoryIndexManagersForAgent,
}));

const withLease: PluginStateLeaseRunner = async <T>(
  options: PluginStateLeaseOptions,
  run: (lease: PluginStateLeaseContext) => Promise<T>,
) =>
  await run({
    signal: options.signal ?? new AbortController().signal,
    assertOwned: vi.fn(),
  });

const createLeaseHost = (): PluginStateLeaseRunner =>
  async function leaseHost<T>(
    options: PluginStateLeaseOptions,
    run: (lease: PluginStateLeaseContext) => Promise<T>,
  ): Promise<T> {
    return await withLease(options, run);
  };

const getMemorySearchManager = (params: Parameters<typeof getMemorySearchManagerWithoutLease>[0]) =>
  getMemorySearchManagerWithoutLease({ ...params, withLease: params.withLease ?? withLease });

const createQmdManagerMock = vi.mocked(QmdMemoryManager["create"]);

type QmdManagerInstance = Awaited<ReturnType<typeof QmdMemoryManager.create>>;

type SearchManagerResult = Awaited<ReturnType<typeof getMemorySearchManager>>;

type SearchManager = NonNullable<SearchManagerResult["manager"]>;

function createQmdCfg(
  agentId: string,
  workspace = "/tmp/workspace",
  qmd: Record<string, unknown> = {},
): OpenClawConfig {
  return {
    memory: { backend: "qmd", qmd },
    agents: { list: [{ id: agentId, default: true, workspace }] },
  };
}

function createBuiltinCfg(agentId: string): OpenClawConfig {
  return {
    memory: {
      search: {
        provider: "openai",
        model: "text-embedding-3-small",
        store: {
          path: "/tmp/index.sqlite",
          vector: { enabled: false },
        },
        sync: { watch: false, onSessionStart: false, onSearch: false },
        query: { minScore: 0, hybrid: { enabled: false } },
        sources: ["memory"],
        experimental: { sessionMemory: false },
      },
    },

    agents: {
      defaults: {
        workspace: "/tmp/workspace",
      },
      list: [{ id: agentId, default: true, workspace: "/tmp/workspace" }],
    },
  } as OpenClawConfig; // SAFETY: This focused fixture supplies the exact builtin-memory config fields consumed by the search manager.
}

function requireManager(result: SearchManagerResult): SearchManager {
  if (!result.manager) {
    throw new Error("manager missing");
  }
  return result.manager;
}

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

async function createFailedQmdSearchHarness(params: { agentId: string; errorMessage: string }) {
  const cfg = createQmdCfg(params.agentId);
  mockPrimary.search.mockRejectedValueOnce(new Error(params.errorMessage));
  const first = await getMemorySearchManager({ cfg, agentId: params.agentId });
  return { cfg, manager: requireManager(first), firstResult: first };
}

function qmdCreateParams(index = 0): Record<string, unknown> {
  const call = createQmdManagerMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected QMD manager create call ${index}`);
  }
  const params = call.at(0);
  if (!params || typeof params !== "object") {
    throw new Error(`expected QMD manager create params ${index}`);
  }
  // SAFETY: the mocked create call receives a plain object params bag; the guards above exclude missing and non-object values.
  return params as Record<string, unknown>;
}

async function expectPendingQmdReplacement(params: {
  agentId: string;
  firstCfg: OpenClawConfig;
  secondCfg: OpenClawConfig;
  firstAvailability: { command: string; cwd: string };
  secondAvailability: { command: string; cwd: string };
}) {
  const firstPrimary = createQmdManagerInstanceMock();
  const secondPrimary = createQmdManagerInstanceMock();
  const firstGate = createDeferred<QmdManagerInstance>();
  const secondGate = createDeferred<QmdManagerInstance>();
  createQmdManagerMock
    .mockImplementationOnce(async () => await firstGate.promise)
    .mockImplementationOnce(async () => await secondGate.promise);

  const firstPromise = getMemorySearchManager({
    cfg: params.firstCfg,
    agentId: params.agentId,
  });
  await Promise.resolve();
  const secondPromise = getMemorySearchManager({
    cfg: params.secondCfg,
    agentId: params.agentId,
  });
  await vi.waitFor(() => {
    expect(createQmdManagerMock).toHaveBeenCalledTimes(1);
  });

  // SAFETY: these manager doubles are created from the same mocked QmdMemoryManager contract and satisfy the awaited instance shape used by the harness.
  firstGate.resolve(firstPrimary as unknown as QmdManagerInstance);
  await vi.waitFor(() => {
    expect(createQmdManagerMock).toHaveBeenCalledTimes(2);
  });

  // SAFETY: these manager doubles are created from the same mocked QmdMemoryManager contract and satisfy the awaited instance shape used by the harness.
  secondGate.resolve(secondPrimary as unknown as QmdManagerInstance);
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  requireManager(first);
  requireManager(second);
  expect(first.manager).not.toBe(second.manager);
  expect(firstPrimary.close).toHaveBeenCalledTimes(1);
  expect(checkQmdBinaryAvailability).toHaveBeenNthCalledWith(1, {
    command: params.firstAvailability.command,
    env: process.env,
    cwd: nativePath(params.firstAvailability.cwd),
  });
  expect(checkQmdBinaryAvailability).toHaveBeenNthCalledWith(2, {
    command: params.secondAvailability.command,
    env: process.env,
    cwd: nativePath(params.secondAvailability.cwd),
  });
}

beforeEach(async () => {
  await closeAllMemorySearchManagers();
  mockPrimary.search.mockClear();
  mockPrimary.readFile.mockClear();
  mockPrimary.listCuratedProjectCandidates.mockClear();
  mockPrimary.status.mockClear();
  mockPrimary.sync.mockClear();
  mockPrimary.probeEmbeddingAvailability.mockClear();
  mockPrimary.probeVectorAvailability.mockClear();
  mockPrimary.close.mockClear();
  fallbackSearch.mockClear();
  fallbackManager.readFile.mockClear();
  fallbackManager.listCuratedProjectCandidates.mockClear();
  fallbackManager.status.mockClear();
  fallbackManager.sync.mockClear();
  fallbackManager.probeEmbeddingAvailability.mockClear();
  fallbackManager.probeVectorAvailability.mockClear();
  fallbackManager.close.mockClear();
  mockCloseAllMemoryIndexManagers.mockClear();
  mockCloseMemoryIndexManagersForAgent.mockClear();
  mockMemoryIndexGet.mockClear();
  mockMemoryIndexGet.mockResolvedValue(fallbackManager);
  checkQmdBinaryAvailability.mockClear();
  checkQmdBinaryAvailability.mockResolvedValue({ available: true });
  createQmdManagerMock.mockClear();
});

const testExportMEMORY_SEARCH_DEADLINE_CONTROL = MEMORY_SEARCH_DEADLINE_CONTROL;
const testExportCloseAllMemorySearchManagers = closeAllMemorySearchManagers;
const testExportCloseMemorySearchManager = closeMemorySearchManager;
const testExportDescribe = describe;
const testExportExpect = expect;
const testExportFs = fs;
const testExportGetMemorySearchManagerWithoutLease = getMemorySearchManagerWithoutLease;
const testExportIt = it;
const testExportOs = os;
const testExportPath = path;
const testExportRunMemorySearchWithDeadline = runMemorySearchWithDeadline;
const testExportVi = vi;

export {
  testExportMEMORY_SEARCH_DEADLINE_CONTROL as MEMORY_SEARCH_DEADLINE_CONTROL,
  checkQmdBinaryAvailability,
  testExportCloseAllMemorySearchManagers as closeAllMemorySearchManagers,
  testExportCloseMemorySearchManager as closeMemorySearchManager,
  createBuiltinCfg,
  createDeferred,
  createFailedQmdSearchHarness,
  createLeaseHost,
  createManagerMock,
  createManagerStatus,
  createQmdCfg,
  createQmdManagerInstanceMock,
  createQmdManagerMock,
  testExportDescribe as describe,
  testExportExpect as expect,
  expectPendingQmdReplacement,
  fallbackManager,
  fallbackSearch,
  testExportFs as fs,
  getMemorySearchManager,
  testExportGetMemorySearchManagerWithoutLease as getMemorySearchManagerWithoutLease,
  testExportIt as it,
  mockCloseAllMemoryIndexManagers,
  mockCloseMemoryIndexManagersForAgent,
  mockMemoryIndexGet,
  mockPrimary,
  nativePath,
  testExportOs as os,
  testExportPath as path,
  qmdCreateParams,
  requireManager,
  testExportRunMemorySearchWithDeadline as runMemorySearchWithDeadline,
  testExportVi as vi,
  withLease,
};

export type {
  ManagerSearchParams,
  MemorySearchDeadlineControlOptions,
  OpenClawConfig,
  QmdManagerInstance,
  SearchManager,
};
