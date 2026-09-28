import { createHash } from "node:crypto";
// Memory Core plugin module implements search manager behavior.
import fs from "node:fs/promises";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  createSubsystemLogger,
  resolveAgentContextLimits,
  resolveAgentWorkspaceDir,
  resolveMemorySearchSyncConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  checkQmdBinaryAvailability,
  resolveQmdBinaryUnavailableReason,
} from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import {
  resolveMemoryBackendConfig,
  type MemorySearchManager,
  type ResolvedQmdConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { PluginStateLeaseRunner } from "openclaw/plugin-sdk/plugin-state-runtime";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import {
  resolveMemoryCoreLocalServiceHostIdentity,
  type MemoryCoreAcquireLocalService,
} from "./embedding-local-service.js";
import { resolveMemoryCoreLeaseHostIdentity } from "./runtime-host.js";
import {
  MEMORY_SEARCH_MANAGER_CACHE_STORE,
  PENDING_QMD_MANAGER_CREATES,
  QMD_MANAGER_CACHE,
  QMD_MANAGER_OPEN_FAILURES,
  QMD_MANAGER_OPEN_FAILURE_COOLDOWN_MS,
  type CachedQmdManagerEntry,
  type PendingQmdManagerCreate,
  type QmdManagerOpenFailure,
} from "./search-manager-cache.js";
import {
  BorrowedMemoryManager,
  FallbackMemoryManager,
  closeQmdManagerForReplacement,
} from "./search-manager-wrappers.js";

type Maybe<T> = T | null;
type QmdManagerRuntimeConfig = {
  workspaceDir: string;
  syncSettings: ReturnType<typeof resolveMemorySearchSyncConfig>;
  contextLimits: ReturnType<typeof resolveAgentContextLimits>;
};

type MemorySearchManagerCacheState =
  | "cached-full-hit"
  | "cached-full-miss"
  | "transient-cli"
  | "transient-status"
  | "pending-create-wait"
  | "fallback-builtin"
  | "qmd-unavailable"
  | "recent-failure-cooldown";

type MemorySearchManagerDebug = {
  backend?: "builtin" | "qmd";
  purpose?: MemorySearchManagerPurpose;
  managerMs?: number;
  managerCacheState?: MemorySearchManagerCacheState;
  qmdIdentityHash?: string;
  failureCode?: "qmd-unavailable";
};

const log = createSubsystemLogger("memory");

function retainQmdManagerForCleanup(scopeKey: string, manager: MemorySearchManager): void {
  const retained = MEMORY_SEARCH_MANAGER_CACHE_STORE.retainedQmdManagers.get(scopeKey) ?? new Set();
  retained.add(manager);
  MEMORY_SEARCH_MANAGER_CACHE_STORE.retainedQmdManagers.set(scopeKey, retained);
}

function releaseRetainedQmdManager(scopeKey: string, manager: MemorySearchManager): void {
  const retained = MEMORY_SEARCH_MANAGER_CACHE_STORE.retainedQmdManagers.get(scopeKey);
  if (!retained) {
    return;
  }
  retained.delete(manager);
  if (retained.size === 0) {
    MEMORY_SEARCH_MANAGER_CACHE_STORE.retainedQmdManagers.delete(scopeKey);
  }
}

async function drainRetainedQmdManagers(scopeKey: string): Promise<void> {
  const retained = MEMORY_SEARCH_MANAGER_CACHE_STORE.retainedQmdManagers.get(scopeKey);
  if (!retained) {
    return;
  }
  let firstError: unknown;
  let closeFailed = false;
  for (const manager of retained) {
    try {
      await manager.close?.();
      retained.delete(manager);
    } catch (err) {
      if (!closeFailed) {
        firstError = err;
      }
      closeFailed = true;
    }
  }
  if (retained.size === 0) {
    MEMORY_SEARCH_MANAGER_CACHE_STORE.retainedQmdManagers.delete(scopeKey);
  }
  if (closeFailed) {
    throw firstError;
  }
}

async function runMemorySearchManagerScopeOperation<T>(
  scopeKey: string,
  operation: () => Promise<T>,
  options: { drainRetained?: boolean } = {},
): Promise<T> {
  while (MEMORY_SEARCH_MANAGER_CACHE_STORE.globalClosePromise) {
    const globalClose = MEMORY_SEARCH_MANAGER_CACHE_STORE.globalClosePromise;
    try {
      await globalClose;
    } catch {
      if (MEMORY_SEARCH_MANAGER_CACHE_STORE.globalClosePromise === globalClose) {
        await closeAllMemorySearchManagers();
      }
    }
  }
  const previous =
    MEMORY_SEARCH_MANAGER_CACHE_STORE.scopeLifecycleTails.get(scopeKey) ?? Promise.resolve();
  const run = async () => {
    if (options.drainRetained !== false) {
      await drainRetainedQmdManagers(scopeKey);
    }
    return await operation();
  };
  const result = previous.then(run, run);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  MEMORY_SEARCH_MANAGER_CACHE_STORE.scopeLifecycleTails.set(scopeKey, tail);
  try {
    return await result;
  } finally {
    if (MEMORY_SEARCH_MANAGER_CACHE_STORE.scopeLifecycleTails.get(scopeKey) === tail) {
      MEMORY_SEARCH_MANAGER_CACHE_STORE.scopeLifecycleTails.delete(scopeKey);
    }
  }
}

async function runMemorySearchManagerGlobalClose(operation: () => Promise<void>): Promise<void> {
  const previous = MEMORY_SEARCH_MANAGER_CACHE_STORE.globalClosePromise ?? Promise.resolve();
  const closePromise = previous.then(operation, operation);
  MEMORY_SEARCH_MANAGER_CACHE_STORE.globalClosePromise = closePromise;
  await closePromise;
  if (MEMORY_SEARCH_MANAGER_CACHE_STORE.globalClosePromise === closePromise) {
    MEMORY_SEARCH_MANAGER_CACHE_STORE.globalClosePromise = null;
  }
}

function retireQmdManagerInScope(scopeKey: string, manager: MemorySearchManager): void {
  retainQmdManagerForCleanup(scopeKey, manager);
  void runMemorySearchManagerScopeOperation(
    scopeKey,
    async () => {
      await manager.close?.();
      releaseRetainedQmdManager(scopeKey, manager);
    },
    { drainRetained: false },
  ).catch((err: unknown) => {
    log.warn(`failed to retire qmd memory manager: ${formatErrorMessage(err)}`);
  });
}
const managerRuntimeLoader = createLazyRuntimeModule(() => import("../../manager-runtime.js"));
const loadManagerRuntime = managerRuntimeLoader;

const loadQmdManagerModule = createLazyRuntimeModule(() => import("./qmd-manager.js"));

type MemorySearchManagerResult = {
  manager: Maybe<MemorySearchManager>;
  error?: string;
  debug?: MemorySearchManagerDebug;
};

type MemorySearchManagerPurpose = "default" | "status" | "cli";
type MemorySearchManagerParams = {
  cfg: OpenClawConfig;
  agentId: string;
  purpose?: MemorySearchManagerPurpose;
  inspectSources?: boolean;
  acquireLocalService?: MemoryCoreAcquireLocalService;
  withLease?: PluginStateLeaseRunner;
};

function isClosedMemorySearchManager(manager: MemorySearchManager): boolean {
  const isClosed = Reflect.get(manager, "isClosed");
  return typeof isClosed === "function" && isClosed.call(manager) === true;
}

function getActiveQmdManagerOpenFailure(
  scopeKey: string,
  identityKey: string,
  nowMs = Date.now(),
): QmdManagerOpenFailure | null {
  const failure = QMD_MANAGER_OPEN_FAILURES.get(scopeKey);
  if (!failure) {
    return null;
  }
  if (failure.identityKey !== identityKey || failure.retryAfterMs <= nowMs) {
    QMD_MANAGER_OPEN_FAILURES.delete(scopeKey);
    return null;
  }
  return failure;
}

function recordQmdManagerOpenFailure(
  scopeKey: string,
  identityKey: string,
  reason: string,
  nowMs = Date.now(),
): void {
  QMD_MANAGER_OPEN_FAILURES.set(scopeKey, {
    identityKey,
    reason,
    retryAfterMs: nowMs + QMD_MANAGER_OPEN_FAILURE_COOLDOWN_MS,
  });
}

function clearQmdManagerOpenFailure(scopeKey: string, identityKey: string): void {
  const failure = QMD_MANAGER_OPEN_FAILURES.get(scopeKey);
  if (failure?.identityKey === identityKey) {
    QMD_MANAGER_OPEN_FAILURES.delete(scopeKey);
  }
}

function hashQmdManagerIdentity(identityKey: string): string {
  return createHash("sha256").update(identityKey).digest("hex");
}

function applyManagerDebug(
  result: MemorySearchManagerResult,
  debug: MemorySearchManagerDebug,
): MemorySearchManagerResult {
  if (result.debug && Object.keys(result.debug).length > 0 && Object.keys(debug).length === 0) {
    return result;
  }
  return {
    ...result,
    debug: {
      ...result.debug,
      ...debug,
    },
  };
}

export async function getMemorySearchManager(
  params: MemorySearchManagerParams,
): Promise<MemorySearchManagerResult> {
  const scopeKey = buildQmdManagerScopeKey(normalizeAgentId(params.agentId));
  const resolved = resolveMemoryBackendConfig(params);
  return await runMemorySearchManagerScopeOperation(
    scopeKey,
    async () => await getMemorySearchManagerWithinLifecycle(params),
    { drainRetained: resolved.backend === "qmd" },
  );
}

async function getMemorySearchManagerWithinLifecycle(
  params: MemorySearchManagerParams,
): Promise<MemorySearchManagerResult> {
  const acquireStartedAt = Date.now();
  const purpose = params.purpose ?? "default";
  const finish = (
    result: MemorySearchManagerResult,
    debug: MemorySearchManagerDebug,
  ): MemorySearchManagerResult =>
    applyManagerDebug(result, {
      purpose,
      managerMs: Math.max(0, Date.now() - acquireStartedAt),
      ...debug,
    });
  const resolved = resolveMemoryBackendConfig(params);
  if (resolved.backend === "qmd" && resolved.qmd) {
    const qmdResolved = resolved.qmd;
    const normalizedAgentId = normalizeAgentId(params.agentId);
    const runtimeConfig = resolveQmdManagerRuntimeConfig(params.cfg, normalizedAgentId);
    const { workspaceDir } = runtimeConfig;
    const transient = params.purpose === "status" || params.purpose === "cli";
    const scopeKey = buildQmdManagerScopeKey(normalizedAgentId);
    const identityKey = buildQmdManagerIdentityKey(
      normalizedAgentId,
      qmdResolved,
      runtimeConfig,
      params.acquireLocalService,
      params.withLease,
    );
    const debugIdentityHash = hashQmdManagerIdentity(identityKey);

    const createPrimaryQmdManager = async (
      mode: "full" | "status" | "cli",
    ): Promise<{ manager: Maybe<MemorySearchManager>; failureReason?: string }> => {
      if (!params.withLease) {
        const message = "memory-core host does not provide SQLite lease coordination";
        log.warn(
          qmdResolved.fallback === "builtin"
            ? `qmd memory unavailable; falling back to builtin: ${message}`
            : `qmd memory unavailable; builtin fallback disabled: ${message}`,
        );
        return { manager: null, failureReason: `qmd memory unavailable: ${message}` };
      }
      try {
        await fs.mkdir(workspaceDir, { recursive: true });
      } catch (err) {
        const message = formatErrorMessage(err);
        log.warn(
          qmdResolved.fallback === "builtin"
            ? `qmd workspace unavailable (${workspaceDir}); falling back to builtin: ${message}`
            : `qmd workspace unavailable (${workspaceDir}); builtin fallback disabled: ${message}`,
        );
        return {
          manager: null,
          failureReason: `qmd workspace unavailable (${workspaceDir}): ${message}`,
        };
      }

      const qmdBinary = await checkQmdBinaryAvailability({
        command: qmdResolved.command,
        env: process.env,
        cwd: workspaceDir,
      });
      if (!qmdBinary.available) {
        const message = qmdBinary.error;
        const failurePrefix =
          resolveQmdBinaryUnavailableReason(qmdBinary) === "workspace-cwd"
            ? `qmd workspace unavailable (${workspaceDir})`
            : `qmd binary unavailable (${qmdResolved.command})`;
        log.warn(
          qmdResolved.fallback === "builtin"
            ? `${failurePrefix}; falling back to builtin: ${message}`
            : `${failurePrefix}; builtin fallback disabled: ${message}`,
        );
        return {
          manager: null,
          failureReason: `${failurePrefix}: ${message}`,
        };
      }
      try {
        const { QmdMemoryManager } = await loadQmdManagerModule();
        const primary = await QmdMemoryManager.create({
          cfg: params.cfg,
          agentId: normalizedAgentId,
          resolved: { ...resolved, qmd: qmdResolved },
          mode,
          runtimeConfig,
          withLease: params.withLease,
        });
        if (primary) {
          clearQmdManagerOpenFailure(scopeKey, identityKey);
          return { manager: primary };
        }
      } catch (err) {
        const message = formatErrorMessage(err);
        log.warn(
          qmdResolved.fallback === "builtin"
            ? `qmd memory unavailable; falling back to builtin: ${message}`
            : `qmd memory unavailable; builtin fallback disabled: ${message}`,
        );
        return { manager: null, failureReason: `qmd memory unavailable: ${message}` };
      }
      return { manager: null, failureReason: "qmd memory unavailable: no manager returned" };
    };

    const createFullQmdManager = async (
      expectedIdentityKey: string,
    ): Promise<{ entry: Maybe<CachedQmdManagerEntry>; failureReason?: string }> => {
      const { manager: primary, failureReason } = await createPrimaryQmdManager("full");
      if (!primary) {
        return { entry: null, failureReason };
      }
      const wrapper = new FallbackMemoryManager(
        {
          primary,
          retirePrimary: () => retireQmdManagerInScope(scopeKey, primary),
          fallbackMode: qmdResolved.fallback,
          fallbackFactory: async () => {
            const { MemoryIndexManager } = await loadManagerRuntime();
            return await MemoryIndexManager.get(params);
          },
          log,
        },
        () => {
          const current = QMD_MANAGER_CACHE.get(scopeKey);
          if (current === cacheEntry) {
            QMD_MANAGER_CACHE.delete(scopeKey);
          }
        },
      );
      const cacheEntry: CachedQmdManagerEntry = {
        identityKey: expectedIdentityKey,
        manager: wrapper,
      };
      return { entry: cacheEntry };
    };

    let cached = QMD_MANAGER_CACHE.get(scopeKey);
    if (cached && isClosedMemorySearchManager(cached.manager)) {
      await cached.manager.close?.();
      if (QMD_MANAGER_CACHE.get(scopeKey) === cached) {
        QMD_MANAGER_CACHE.delete(scopeKey);
      }
      cached = undefined;
    }
    const cachedMatchesIdentity = cached?.identityKey === identityKey;
    if (cachedMatchesIdentity && cached) {
      if (params.purpose === "status") {
        // Status callers often close the manager they receive. Wrap the live
        // full manager with a no-op close so health/status probes do not tear
        // down the active QMD manager for the process.
        return finish(
          { manager: new BorrowedMemoryManager(cached.manager) },
          {
            backend: "qmd",
            managerCacheState: "cached-full-hit",
            qmdIdentityHash: debugIdentityHash,
          },
        );
      }
      if (params.purpose !== "cli") {
        return finish(
          { manager: cached.manager },
          {
            backend: "qmd",
            managerCacheState: "cached-full-hit",
            qmdIdentityHash: debugIdentityHash,
          },
        );
      }
    }

    if (transient) {
      const { manager, failureReason } = await createPrimaryQmdManager(
        params.purpose === "cli" ? "cli" : "status",
      );
      return manager
        ? finish(
            { manager },
            {
              backend: "qmd",
              managerCacheState: params.purpose === "cli" ? "transient-cli" : "transient-status",
              qmdIdentityHash: debugIdentityHash,
            },
          )
        : finish(await getMemorySearchManagerAfterQmdFailure(params, qmdResolved.fallback, failureReason), {
            backend: "qmd",
            managerCacheState: qmdResolved.fallback === "builtin" ? "fallback-builtin" : "qmd-unavailable",
            qmdIdentityHash: debugIdentityHash,
            failureCode: "qmd-unavailable",
          });
    }

    const recentFailure = getActiveQmdManagerOpenFailure(scopeKey, identityKey);
    if (recentFailure) {
      log.debug?.(
        qmdResolved.fallback === "builtin"
          ? `qmd memory unavailable; using builtin during cooldown: ${recentFailure.reason}`
          : `qmd memory unavailable during cooldown; builtin fallback disabled: ${recentFailure.reason}`,
      );
      return finish(
        await getMemorySearchManagerAfterQmdFailure(params, qmdResolved.fallback, recentFailure.reason),
        {
          backend: "qmd",
          managerCacheState: "recent-failure-cooldown",
          qmdIdentityHash: debugIdentityHash,
          failureCode: "qmd-unavailable",
        },
      );
    }

    const pending = PENDING_QMD_MANAGER_CREATES.get(scopeKey);
    if (pending) {
      await pending.promise;
      return finish(await getMemorySearchManagerWithinLifecycle(params), {
        backend: "qmd",
        managerCacheState: "pending-create-wait",
        qmdIdentityHash: debugIdentityHash,
      });
    }

    let pendingFailureReason: string | undefined;
    const pendingCreate: PendingQmdManagerCreate = {
      identityKey,
      promise: (async () => {
        const created = await createFullQmdManager(identityKey);
        if (!created.entry) {
          pendingFailureReason = created.failureReason ?? "qmd memory unavailable";
          recordQmdManagerOpenFailure(scopeKey, identityKey, pendingFailureReason);
          return null;
        }
        if (cached) {
          try {
            await closeQmdManagerForReplacement(cached.manager);
          } catch (err) {
            retainQmdManagerForCleanup(scopeKey, created.entry.manager);
            try {
              await created.entry.manager.close?.();
              releaseRetainedQmdManager(scopeKey, created.entry.manager);
            } catch (closeErr) {
              log.warn(
                `failed to close unused qmd memory manager: ${formatErrorMessage(closeErr)}`,
              );
            }
            throw err;
          }
        }
        QMD_MANAGER_CACHE.set(scopeKey, created.entry);
        return created.entry.manager;
      })().finally(() => {
        const currentPending = PENDING_QMD_MANAGER_CREATES.get(scopeKey);
        if (currentPending === pendingCreate) {
          PENDING_QMD_MANAGER_CREATES.delete(scopeKey);
        }
      }),
    };
    PENDING_QMD_MANAGER_CREATES.set(scopeKey, pendingCreate);
    const manager = await pendingCreate.promise;
    return manager
      ? finish(
          { manager },
          {
            backend: "qmd",
            managerCacheState: "cached-full-miss",
            qmdIdentityHash: debugIdentityHash,
          },
        )
      : finish(await getMemorySearchManagerAfterQmdFailure(params, qmdResolved.fallback, pendingFailureReason), {
          backend: "qmd",
          managerCacheState: "fallback-builtin",
          qmdIdentityHash: debugIdentityHash,
          failureCode: "qmd-unavailable",
        });
  }

  return finish(await getBuiltinMemorySearchManager(params), {
    backend: "builtin",
  });
}

async function getMemorySearchManagerAfterQmdFailure(
  params: MemorySearchManagerParams,
  fallbackMode: "builtin" | "none",
  qmdFailureReason: string | undefined,
): Promise<MemorySearchManagerResult> {
  if (fallbackMode === "none") {
    return {
      manager: null,
      error: qmdFailureReason ?? "qmd memory unavailable",
    };
  }
  const fallback = await getBuiltinMemorySearchManager(params);
  if (fallback.manager || !qmdFailureReason) {
    return fallback;
  }
  const fallbackError = fallback.error?.trim();
  return {
    manager: null,
    error: fallbackError
      ? `${qmdFailureReason}; builtin fallback unavailable: ${fallbackError}`
      : qmdFailureReason,
  };
}

async function getBuiltinMemorySearchManager(
  params: MemorySearchManagerParams,
): Promise<MemorySearchManagerResult> {
  try {
    const { MemoryIndexManager } = await loadManagerRuntime();
    const manager = await MemoryIndexManager.get(params);
    return { manager };
  } catch (err) {
    const message = formatErrorMessage(err);
    return { manager: null, error: message };
  }
}

export async function closeAllMemorySearchManagers(): Promise<void> {
  await runMemorySearchManagerGlobalClose(closeAllMemorySearchManagersWithinLifecycle);
}

async function closeAllMemorySearchManagersWithinLifecycle(): Promise<void> {
  const scopeTails = Array.from(MEMORY_SEARCH_MANAGER_CACHE_STORE.scopeLifecycleTails.values());
  if (scopeTails.length > 0) {
    await Promise.allSettled(scopeTails);
  }
  const pendingCreates = Array.from(PENDING_QMD_MANAGER_CREATES.values(), (entry) => entry.promise);
  await Promise.allSettled(pendingCreates);
  const entries = Array.from(QMD_MANAGER_CACHE.entries());
  QMD_MANAGER_OPEN_FAILURES.clear();
  let firstError: unknown;
  let closeFailed = false;
  for (const scopeKey of Array.from(MEMORY_SEARCH_MANAGER_CACHE_STORE.retainedQmdManagers.keys())) {
    try {
      await drainRetainedQmdManagers(scopeKey);
    } catch (err) {
      if (!closeFailed) {
        firstError = err;
      }
      closeFailed = true;
    }
  }
  for (const [scopeKey, entry] of entries) {
    try {
      await entry.manager.close?.();
      if (QMD_MANAGER_CACHE.get(scopeKey) === entry) {
        QMD_MANAGER_CACHE.delete(scopeKey);
      }
    } catch (err) {
      if (!closeFailed) {
        firstError = err;
      }
      closeFailed = true;
      log.warn(`failed to close qmd memory manager: ${String(err)}`);
    }
  }
  if (managerRuntimeLoader.peek()) {
    try {
      const { closeAllMemoryIndexManagers } = await loadManagerRuntime();
      await closeAllMemoryIndexManagers();
    } catch (err) {
      if (!closeFailed) {
        firstError = err;
      }
      closeFailed = true;
    }
  }
  if (closeFailed) {
    throw firstError;
  }
}

export async function closeMemorySearchManager(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<void> {
  const scopeKey = buildQmdManagerScopeKey(normalizeAgentId(params.agentId));
  await runMemorySearchManagerScopeOperation(
    scopeKey,
    async () => await closeMemorySearchManagerWithinLifecycle(params),
    { drainRetained: false },
  );
}

async function closeMemorySearchManagerWithinLifecycle(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<void> {
  const normalizedAgentId = normalizeAgentId(params.agentId);
  const scopeKey = buildQmdManagerScopeKey(normalizedAgentId);
  let closeError: unknown;
  let closeFailed = false;
  try {
    await drainRetainedQmdManagers(scopeKey);
  } catch (err) {
    closeError = err;
    closeFailed = true;
  }
  const pending = PENDING_QMD_MANAGER_CREATES.get(scopeKey);
  if (pending) {
    await Promise.allSettled([pending.promise]);
  }
  const cached = QMD_MANAGER_CACHE.get(scopeKey);
  if (cached) {
    try {
      await cached.manager.close?.();
      if (QMD_MANAGER_CACHE.get(scopeKey) === cached) {
        QMD_MANAGER_CACHE.delete(scopeKey);
      }
      QMD_MANAGER_OPEN_FAILURES.delete(scopeKey);
    } catch (err) {
      closeError = err;
      closeFailed = true;
      log.warn(`failed to close qmd memory manager for agent ${normalizedAgentId}: ${String(err)}`);
    }
  }
  if (managerRuntimeLoader.peek()) {
    try {
      const { closeMemoryIndexManagersForAgent } = await loadManagerRuntime();
      await closeMemoryIndexManagersForAgent({ agentId: normalizedAgentId });
    } catch (err) {
      if (!closeFailed) {
        closeError = err;
      }
      closeFailed = true;
    }
  }
  if (closeFailed) {
    throw closeError;
  }
}

function buildQmdManagerScopeKey(agentId: string): string {
  return agentId;
}

function buildQmdManagerIdentityKey(
  agentId: string,
  config: ResolvedQmdConfig,
  runtimeConfig: QmdManagerRuntimeConfig,
  acquireLocalService: MemoryCoreAcquireLocalService | undefined,
  withLease: PluginStateLeaseRunner | undefined,
): string {
  // ResolvedQmdConfig is assembled in a stable field order in resolveMemoryBackendConfig.
  // Fast stringify avoids deep key-sorting overhead on this hot path.
  const localServiceHostId = resolveMemoryCoreLocalServiceHostIdentity(acquireLocalService);
  const leaseHostId = resolveMemoryCoreLeaseHostIdentity(withLease);
  return `${agentId}:${JSON.stringify(config)}:${JSON.stringify(runtimeConfig.syncSettings ?? null)}:${JSON.stringify(runtimeConfig.contextLimits ?? null)}:${runtimeConfig.workspaceDir}:${localServiceHostId}:${leaseHostId}`;
}

function resolveQmdManagerRuntimeConfig(
  cfg: OpenClawConfig,
  agentId: string,
): QmdManagerRuntimeConfig {
  return {
    workspaceDir: resolveAgentWorkspaceDir(cfg, agentId),
    syncSettings: resolveMemorySearchSyncConfig(cfg, agentId),
    contextLimits: resolveAgentContextLimits(cfg, agentId),
  };
}
