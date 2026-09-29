// Borrowed and failover wrappers around concrete memory search managers.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  MemoryEmbeddingProbeResult,
  MemorySearchManager,
  MemorySyncParams,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  DEFAULT_MEMORY_SEARCH_TIMEOUT_MS,
  MEMORY_SEARCH_DEADLINE_CONTROL,
  runMemorySearchWithDeadline,
  type MemorySearchDeadlineControlOptions,
} from "./search-deadline.js";

type Maybe<T> = T | null;
type MemoryManagerSearchOptions = Parameters<MemorySearchManager["search"]>[1];

class BorrowedMemoryManager implements MemorySearchManager {
  readonly probeVectorStoreAvailability?: () => Promise<boolean>;

  constructor(private readonly inner: MemorySearchManager) {
    if (inner.probeVectorStoreAvailability) {
      const probeVectorStoreAvailability = inner.probeVectorStoreAvailability.bind(inner);
      this.probeVectorStoreAvailability = async () => await probeVectorStoreAvailability();
    }
  }

  async search(query: string, opts?: MemoryManagerSearchOptions) {
    return await this.inner.search(query, opts);
  }

  async readFile(params: { relPath: string; from?: number; lines?: number }) {
    return await this.inner.readFile(params);
  }

  async listCuratedProjectCandidates(opts: { activeProjectKeys: string[]; limit?: number }) {
    return (await this.inner.listCuratedProjectCandidates?.(opts)) ?? [];
  }

  status() {
    return this.inner.status();
  }

  async sync(params?: MemorySyncParams) {
    await this.inner.sync?.(params);
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    return await this.inner.probeEmbeddingAvailability();
  }

  getCachedEmbeddingAvailability(): MemoryEmbeddingProbeResult | null {
    return this.inner.getCachedEmbeddingAvailability?.() ?? null;
  }

  async probeVectorAvailability() {
    return await this.inner.probeVectorAvailability();
  }

  async close() {}
}

class FallbackMemoryManager implements MemorySearchManager {
  private fallback: Maybe<MemorySearchManager> = null;
  private fallbackInitPromise: Promise<Maybe<MemorySearchManager>> | null = null;
  private primaryFailed = false;
  private lastError?: string;
  private cacheEvicted = false;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private closeReason = "memory search manager is closed";

  constructor(
    private readonly deps: {
      primary: MemorySearchManager;
      retirePrimary: () => void;
      fallbackFactory: () => Promise<Maybe<MemorySearchManager>>;
      log: { warn: (message: string) => void };
    },
    private readonly onClose?: () => void,
  ) {}

  async search(query: string, opts?: MemoryManagerSearchOptions) {
    this.ensureOpen();
    if (!this.primaryFailed) {
      try {
        return await this.deps.primary.search(query, opts);
      } catch (err) {
        // Caller cancellation is request-scoped, not a QMD health failure.
        // Keep the shared manager active for concurrent and later searches.
        if (opts?.signal?.aborted) {
          throw err;
        }
        this.primaryFailed = true;
        this.lastError = formatErrorMessage(err);
        this.deps.log.warn(`qmd memory failed; switching to builtin index: ${this.lastError}`);
        this.deps.retirePrimary();
        // Evict the failed wrapper so the next request can retry QMD with a fresh manager.
        this.evictCacheEntry();
      }
    }
    // The fallback owns a fresh default budget. Release any outer QMD clock
    // before builtin setup so earlier QMD maintenance cannot shorten it.
    // SAFETY: The optional symbol extension is injected by this module's search wrapper; absent values are ignored.
    (opts as MemorySearchDeadlineControlOptions | undefined)?.[MEMORY_SEARCH_DEADLINE_CONTROL]?.(
      "handoff",
    );
    // Expose the backend transition before fallback setup starts. This must run
    // for concurrent and later calls that observe an already-failed primary too.
    opts?.onDebug?.({ backend: "builtin" });
    // Calls already queued on this failed wrapper must receive the same
    // bounded builtin setup and search budget as the first fallback call.
    return await runMemorySearchWithDeadline({
      timeoutMs: DEFAULT_MEMORY_SEARCH_TIMEOUT_MS,
      parentSignal: opts?.signal,
      run: async (signal) => {
        const fallback = await this.ensureFallback();
        if (!fallback) {
          throw new Error(this.lastError ?? "memory search unavailable");
        }
        return await fallback.search(query, { ...opts, signal });
      },
    });
  }

  async readFile(params: { relPath: string; from?: number; lines?: number }) {
    this.ensureOpen();
    if (!this.primaryFailed) {
      return await this.deps.primary.readFile(params);
    }
    const fallback = await this.ensureFallback();
    if (fallback) {
      return await fallback.readFile(params);
    }
    throw new Error(this.lastError ?? "memory read unavailable");
  }

  async listCuratedProjectCandidates(opts: { activeProjectKeys: string[]; limit?: number }) {
    this.ensureOpen();
    if (!this.primaryFailed && this.deps.primary.listCuratedProjectCandidates) {
      try {
        return await this.deps.primary.listCuratedProjectCandidates(opts);
      } catch (err) {
        this.primaryFailed = true;
        this.lastError = formatErrorMessage(err);
        this.deps.log.warn(`qmd memory failed; switching to builtin index: ${this.lastError}`);
        this.deps.retirePrimary();
        this.evictCacheEntry();
      }
    }
    const fallback = await this.ensureFallback();
    return (await fallback?.listCuratedProjectCandidates?.(opts)) ?? [];
  }

  status() {
    this.ensureOpen();
    if (!this.primaryFailed) {
      return this.deps.primary.status();
    }
    const fallbackStatus = this.fallback?.status() ?? this.deps.primary.status();
    const fallbackInfo = { from: "qmd", reason: this.lastError ?? "unknown" };
    return {
      ...fallbackStatus,
      fallback: fallbackInfo,
      custom: {
        ...fallbackStatus.custom,
        fallback: { disabled: true, reason: this.lastError ?? "unknown" },
      },
    };
  }

  async sync(params?: MemorySyncParams) {
    this.ensureOpen();
    if (!this.primaryFailed) {
      await this.deps.primary.sync?.(params);
      return;
    }
    const fallback = await this.ensureFallback();
    await fallback?.sync?.(params);
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    this.ensureOpen();
    if (!this.primaryFailed) {
      return await this.deps.primary.probeEmbeddingAvailability();
    }
    const fallback = await this.ensureFallback();
    if (fallback) {
      return await fallback.probeEmbeddingAvailability();
    }
    return { ok: false, error: this.lastError ?? "memory embeddings unavailable" };
  }

  getCachedEmbeddingAvailability(): MemoryEmbeddingProbeResult | null {
    this.ensureOpen();
    if (!this.primaryFailed) {
      return this.deps.primary.getCachedEmbeddingAvailability?.() ?? null;
    }
    return this.fallback?.getCachedEmbeddingAvailability?.() ?? null;
  }

  async probeVectorStoreAvailability() {
    this.ensureOpen();
    if (!this.primaryFailed) {
      return await (this.deps.primary.probeVectorStoreAvailability?.() ??
        this.deps.primary.probeVectorAvailability());
    }
    const fallback = await this.ensureFallback();
    return (
      (await (fallback?.probeVectorStoreAvailability?.() ?? fallback?.probeVectorAvailability())) ??
      false
    );
  }

  async probeVectorAvailability() {
    this.ensureOpen();
    if (!this.primaryFailed) {
      return await this.deps.primary.probeVectorAvailability();
    }
    const fallback = await this.ensureFallback();
    return (await fallback?.probeVectorAvailability()) ?? false;
  }

  async close() {
    const existingClose = this.closePromise;
    if (existingClose) {
      await existingClose;
      return;
    }
    const closeOperation = this.closeOnce();
    this.closePromise = closeOperation;
    try {
      await closeOperation;
    } catch (err) {
      if (this.closePromise === closeOperation) {
        this.closePromise = null;
      }
      throw err;
    }
  }

  private async closeOnce(): Promise<void> {
    this.closed = true;
    const pendingFallback = this.fallbackInitPromise;
    await this.deps.primary.close?.();
    await pendingFallback;
    await this.fallback?.close?.();
    this.fallback = null;
    this.evictCacheEntry();
  }

  async invalidate(reason: string) {
    this.closeReason = reason;
    await this.close();
  }

  private async ensureFallback(): Promise<Maybe<MemorySearchManager>> {
    this.ensureOpen();
    if (this.fallback) {
      return this.fallback;
    }
    const pending = this.fallbackInitPromise;
    if (pending) {
      const fallback = await pending;
      this.ensureOpen();
      return fallback;
    }
    const initialization = (async (): Promise<Maybe<MemorySearchManager>> => {
      let fallback: Maybe<MemorySearchManager>;
      try {
        fallback = await this.deps.fallbackFactory();
        if (!fallback) {
          this.deps.log.warn("memory fallback requested but builtin index is unavailable");
          return null;
        }
      } catch (err) {
        const message = formatErrorMessage(err);
        this.deps.log.warn(`memory fallback unavailable: ${message}`);
        return null;
      }
      this.fallback = fallback;
      if (this.closed) {
        await fallback.close?.();
        if (this.fallback === fallback) {
          this.fallback = null;
        }
        return null;
      }
      return fallback;
    })();
    this.fallbackInitPromise = initialization;
    try {
      const fallback = await initialization;
      this.ensureOpen();
      return fallback;
    } finally {
      if (this.fallbackInitPromise === initialization) {
        this.fallbackInitPromise = null;
      }
    }
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new Error(this.closeReason);
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  private evictCacheEntry(): void {
    if (this.cacheEvicted) {
      return;
    }
    this.cacheEvicted = true;
    this.onClose?.();
  }
}

async function closeQmdManagerForReplacement(manager: MemorySearchManager): Promise<void> {
  if (manager instanceof FallbackMemoryManager) {
    await manager.invalidate("memory search manager was replaced by a newer qmd manager");
    return;
  }
  await manager.close?.();
}

export { BorrowedMemoryManager, FallbackMemoryManager, closeQmdManagerForReplacement };
