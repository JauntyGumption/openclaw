// Shared process cache and lifecycle state for memory search managers.
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemorySearchManager } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

const MEMORY_SEARCH_MANAGER_CACHE_KEY = Symbol.for("openclaw.memorySearchManagerCache");

type Maybe<T> = T | null;

type CachedQmdManagerEntry = {
  identityKey: string;
  manager: MemorySearchManager;
};

type PendingQmdManagerCreate = {
  identityKey: string;
  promise: Promise<Maybe<MemorySearchManager>>;
};

type QmdManagerOpenFailure = {
  identityKey: string;
  reason: string;
  retryAfterMs: number;
};

type MemorySearchManagerCacheStore = {
  qmdManagerCache: Map<string, CachedQmdManagerEntry>;
  pendingQmdManagerCreates: Map<string, PendingQmdManagerCreate>;
  qmdManagerOpenFailures: Map<string, QmdManagerOpenFailure>;
  retainedQmdManagers: Map<string, Set<MemorySearchManager>>;
  scopeLifecycleTails: Map<string, Promise<void>>;
  globalClosePromise: Promise<void> | null;
};

const QMD_MANAGER_OPEN_FAILURE_COOLDOWN_MS = 60_000;

function createMemorySearchManagerCacheStore(): MemorySearchManagerCacheStore {
  return {
    qmdManagerCache: new Map<string, CachedQmdManagerEntry>(),
    pendingQmdManagerCreates: new Map<string, PendingQmdManagerCreate>(),
    qmdManagerOpenFailures: new Map<string, QmdManagerOpenFailure>(),
    retainedQmdManagers: new Map<string, Set<MemorySearchManager>>(),
    scopeLifecycleTails: new Map<string, Promise<void>>(),
    globalClosePromise: null,
  };
}

function getMemorySearchManagerCacheStore(): MemorySearchManagerCacheStore {
  // Keep caches reachable across `vi.resetModules()` so later cleanup can close older instances.
  const resolved = resolveGlobalSingleton<unknown>(
    MEMORY_SEARCH_MANAGER_CACHE_KEY,
    createMemorySearchManagerCacheStore,
  );
  if (
    typeof resolved === "object" &&
    resolved !== null &&
    // SAFETY: resolved is a non-null object; this property is accepted only when it is a Map.
    (resolved as Partial<MemorySearchManagerCacheStore>).qmdManagerCache instanceof Map &&
    // SAFETY: resolved is a non-null object; this property is accepted only when it is a Map.
    (resolved as Partial<MemorySearchManagerCacheStore>).pendingQmdManagerCreates instanceof Map
  ) {
    // SAFETY: The object guard permits a partial view; every remaining member is normalized below.
    const cacheStore = resolved as Partial<MemorySearchManagerCacheStore>;
    if (!(cacheStore.qmdManagerOpenFailures instanceof Map)) {
      cacheStore.qmdManagerOpenFailures = new Map<string, QmdManagerOpenFailure>();
    }
    if (!(cacheStore.scopeLifecycleTails instanceof Map)) {
      cacheStore.scopeLifecycleTails = new Map<string, Promise<void>>();
    }
    if (!(cacheStore.retainedQmdManagers instanceof Map)) {
      cacheStore.retainedQmdManagers = new Map<string, Set<MemorySearchManager>>();
    }
    if (
      cacheStore.globalClosePromise !== null &&
      !(cacheStore.globalClosePromise instanceof Promise)
    ) {
      cacheStore.globalClosePromise = null;
    }
    // SAFETY: Required maps were guarded and every optional legacy member was initialized or normalized.
    return cacheStore as MemorySearchManagerCacheStore;
  }
  const repaired = createMemorySearchManagerCacheStore();
  // SAFETY: globalThis is property-bearing; the symbol key intentionally stores this process singleton.
  (globalThis as Record<PropertyKey, unknown>)[MEMORY_SEARCH_MANAGER_CACHE_KEY] = repaired;
  return repaired;
}

const MEMORY_SEARCH_MANAGER_CACHE_STORE = getMemorySearchManagerCacheStore();

const {
  qmdManagerCache: QMD_MANAGER_CACHE,
  pendingQmdManagerCreates: PENDING_QMD_MANAGER_CREATES,
  qmdManagerOpenFailures: QMD_MANAGER_OPEN_FAILURES,
} = MEMORY_SEARCH_MANAGER_CACHE_STORE;

export {
  MEMORY_SEARCH_MANAGER_CACHE_STORE,
  PENDING_QMD_MANAGER_CREATES,
  QMD_MANAGER_CACHE,
  QMD_MANAGER_OPEN_FAILURES,
  QMD_MANAGER_OPEN_FAILURE_COOLDOWN_MS,
};
export type { CachedQmdManagerEntry, PendingQmdManagerCreate, QmdManagerOpenFailure };
