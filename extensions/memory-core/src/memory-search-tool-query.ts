// Memory Core plugin module owns ranked search-window filtering and diagnostics.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  resolveMemoryIndexIdentityReason,
  type MemorySearchManager,
  type MemorySearchRuntimeDebug,
  type MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  MEMORY_SEARCH_DEADLINE_CONTROL,
  type MemorySearchDeadlineAction,
  type MemorySearchDeadlineControlOptions,
} from "./memory/search-deadline.js";
import { filterMemorySearchHitsBySessionVisibility } from "./session-search-visibility.js";
import { buildMemorySearchUnavailableResult } from "./tools.shared.js";

const MEMORY_SEARCH_POST_FILTER_MAX_CANDIDATES = 200;
const PAUSED_MEMORY_INDEX_WARNING =
  "Tell the user: memory search is paused because the memory index was built with a different embedding provider/model/settings.";
const PAUSED_MEMORY_INDEX_ACTION =
  "Tell the user to run: openclaw memory status --index or openclaw memory index --force.";

export function buildPausedMemoryIndexUnavailableResult(reason: string) {
  return buildMemorySearchUnavailableResult(reason, {
    warning: PAUSED_MEMORY_INDEX_WARNING,
    action: PAUSED_MEMORY_INDEX_ACTION,
  });
}

type ManagerState = {
  manager: MemorySearchManager;
  managerMs?: number;
  managerCacheState?: string;
};

type MemorySearchToolQuery = {
  text: string;
  resultLimit: number;
  minScore?: number;
  explicitSources?: MemorySource[];
  defaultSources?: MemorySource[];
  indexedSources?: MemorySource[];
  requestedCorpus?: "memory" | "wiki" | "all" | "sessions";
  sessionKey?: string;
  activeProjectKeys?: readonly string[];
  qmdSearchModeOverride?: "query" | "search" | "vsearch";
  conversationRecall?: OpenClawPluginToolContext["conversationRecall"];
};

type MemorySearchToolVisibility = {
  cfg: OpenClawConfig;
  agentId: string;
  sandboxed: boolean;
};

function isClosedMemoryStoreError(error: unknown): boolean {
  const message = formatErrorMessage(error).toLowerCase();
  return (
    message.includes("database is not open") ||
    message.includes("database connection is not open") ||
    message.includes("database handle is closed") ||
    message.includes("memory search manager is closed")
  );
}

function mergeQmdRuntimeDebug(
  entries: readonly MemorySearchRuntimeDebug[],
): MemorySearchRuntimeDebug["qmd"] | undefined {
  const merged: NonNullable<MemorySearchRuntimeDebug["qmd"]> = {};
  for (const entry of entries) {
    const qmd = entry.qmd;
    if (!qmd) {
      continue;
    }
    if (!merged.collectionValidation && qmd.collectionValidation) {
      merged.collectionValidation = qmd.collectionValidation;
    }
    if (qmd.multiCollectionProbe) {
      merged.multiCollectionProbe = qmd.multiCollectionProbe;
    }
    if (qmd.searchPlan) {
      merged.searchPlan = qmd.searchPlan;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeEmbeddingBootstrapRuntimeDebug(
  entries: readonly MemorySearchRuntimeDebug[],
): MemorySearchRuntimeDebug["embeddingBootstrap"] | undefined {
  return entries.findLast((entry) => entry.embeddingBootstrap)?.embeddingBootstrap;
}

export async function executeMemorySearchToolQuery(params: {
  initialManager: ManagerState;
  refreshManager: () => Promise<ManagerState | null>;
  query: MemorySearchToolQuery;
  visibility: MemorySearchToolVisibility;
  signal: AbortSignal;
  controlDeadline: (action: MemorySearchDeadlineAction) => void;
  oneShotCliRun?: boolean;
}) {
  const startedAt = Date.now();
  const runtimeDebug: MemorySearchRuntimeDebug[] = [];
  let active = params.initialManager;
  const { query, signal, visibility } = params;
  // Product recall may index transcripts without adding them to ordinary model search.
  // Explicit corpus selection is authorized by the tool owner before this point.
  const searchSources =
    query.explicitSources ??
    (query.requestedCorpus === "sessions"
      ? query.defaultSources
      : query.requestedCorpus == null || query.requestedCorpus === "all"
        ? query.conversationRecall?.corpus === "configured"
          ? query.indexedSources
          : query.defaultSources
        : undefined);

  const searchOnce = async () => {
    const allowedSources = searchSources ? new Set(searchSources) : undefined;
    const searchesSessions = searchSources?.includes("sessions") === true;
    const indexedCandidateCount = searchesSessions
      ? (active.manager.status().sourceCounts ?? [])
          .filter((entry) => allowedSources?.has(entry.source))
          .reduce((total, entry) => total + entry.chunks, 0)
      : query.resultLimit;
    // A zero-count index can populate during first-search bootstrap. Reserve the
    // full bounded window so that bootstrap cannot recreate post-filter starvation.
    const availableCandidates =
      indexedCandidateCount > 0 ? indexedCandidateCount : MEMORY_SEARCH_POST_FILTER_MAX_CANDIDATES;
    const searchWindow = searchesSessions
      ? Math.min(MEMORY_SEARCH_POST_FILTER_MAX_CANDIDATES, availableCandidates)
      : query.resultLimit;
    const candidates = await active.manager.search(query.text, {
      maxResults: searchWindow,
      minScore: query.minScore,
      sessionKey: query.sessionKey,
      activeProjectKeys: query.activeProjectKeys ? [...query.activeProjectKeys] : undefined,
      qmdSearchModeOverride: query.qmdSearchModeOverride,
      signal,
      onDebug: (debug) => runtimeDebug.push(debug),
      [MEMORY_SEARCH_DEADLINE_CONTROL]: params.controlDeadline,
      ...(searchSources ? { sources: searchSources } : {}),
    } as NonNullable<Parameters<MemorySearchManager["search"]>[1]> &
      MemorySearchDeadlineControlOptions);
    return { candidates, searchWindow };
  };

  let searched: Awaited<ReturnType<typeof searchOnce>>;
  try {
    searched = await searchOnce();
  } catch (error) {
    if (!isClosedMemoryStoreError(error)) {
      throw error;
    }
    const refreshed = await params.refreshManager();
    if (!refreshed) {
      throw error;
    }
    active = refreshed;
    searched = await searchOnce();
  }

  let status = active.manager.status();
  let pausedIndexIdentityReason = resolveMemoryIndexIdentityReason(status);
  if (pausedIndexIdentityReason) {
    return {
      status,
      rawResults: [],
      pausedIndexIdentityReason,
      searchMode: undefined,
      debug: undefined,
    };
  }

  // One-shot CLI managers have no background lifecycle. Preserve their QMD
  // bootstrap retry, while long-lived managers keep update work off the tool
  // hot path and builtin managers retain their current single-search behavior.
  if (
    searched.candidates.length === 0 &&
    params.oneShotCliRun === true &&
    status.backend === "qmd" &&
    active.manager.sync &&
    !runtimeDebug.some((entry) => entry.embeddingBootstrap)
  ) {
    await active.manager.sync({ reason: "search", force: true });
    searched = await searchOnce();
    status = active.manager.status();
    pausedIndexIdentityReason = resolveMemoryIndexIdentityReason(status);
    if (pausedIndexIdentityReason) {
      return {
        status,
        rawResults: [],
        pausedIndexIdentityReason,
        searchMode: undefined,
        debug: undefined,
      };
    }
  }

  let filtered = await filterMemorySearchHitsBySessionVisibility({
    cfg: visibility.cfg,
    agentId: visibility.agentId,
    requesterSessionKey: query.sessionKey,
    sandboxed: visibility.sandboxed,
    hits: searched.candidates,
    conversationRecall: query.conversationRecall,
  });
  if (searchSources) {
    const allowedSources = new Set(searchSources);
    filtered = filtered.filter((hit) => allowedSources.has(hit.source));
  }
  if (query.requestedCorpus === "sessions") {
    filtered = filtered.filter((hit) => hit.source === "sessions");
  } else if (query.requestedCorpus === "memory") {
    filtered = filtered.filter((hit) => hit.source === "memory");
  }

  const postFilterHits = filtered.length;
  const rawResults = filtered.slice(0, query.resultLimit);
  const latestDebug = runtimeDebug.at(-1);
  const embeddingBootstrap = mergeEmbeddingBootstrapRuntimeDebug(runtimeDebug);
  return {
    status,
    rawResults,
    pausedIndexIdentityReason: undefined,
    searchMode: latestDebug?.effectiveMode,
    debug: {
      backend: status.backend,
      configuredMode: latestDebug?.configuredMode,
      effectiveMode:
        status.backend === "qmd"
          ? (latestDebug?.effectiveMode ?? latestDebug?.configuredMode)
          : "n/a",
      fallback: latestDebug?.fallback,
      managerMs: active.managerMs,
      managerCacheState: active.managerCacheState,
      searchMs: Math.max(0, Date.now() - startedAt),
      embeddingBootstrap,
      qmd: mergeQmdRuntimeDebug(runtimeDebug),
      hits: rawResults.length,
      candidateHits: searched.candidates.length,
      withheldHits: Math.max(0, searched.candidates.length - postFilterHits),
      searchWindow: searched.searchWindow,
    },
  };
}
