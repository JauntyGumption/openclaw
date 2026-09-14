import { resolveSessionAgentIdsStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import {
  resolveMemorySearchConfig,
  type MemoryPromptSectionBuilder,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateLeaseRunner } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { TSchema } from "typebox";
import type { MemoryCoreAcquireLocalService } from "./memory/embedding-local-service.js";

export type MemoryToolOptions = {
  config?: OpenClawConfig;
  getConfig?: () => OpenClawConfig | undefined;
  agentId?: string;
  agentSessionKey?: string;
  sandboxed?: boolean;
  oneShotCliRun?: boolean;
  conversationRecall?: OpenClawPluginToolContext["conversationRecall"];
  activeProjectKeys?: readonly string[];
  acquireLocalService?: MemoryCoreAcquireLocalService;
  withLease?: PluginStateLeaseRunner;
};

const MemorySearchSchema = {
  type: "object",
  properties: {
    query: { type: "string" },
    maxResults: { type: "integer", minimum: 1 },
    minScore: { type: "number" },
    corpus: { type: "string", enum: ["memory", "wiki", "all", "sessions"] },
  },
  required: ["query"],
  additionalProperties: false,
} as const satisfies TSchema;

const MemoryGetSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    from: { type: "integer", minimum: 1 },
    lines: { type: "integer", minimum: 1 },
    corpus: { type: "string", enum: ["memory", "wiki", "all"] },
  },
  required: ["path"],
  additionalProperties: false,
} as const satisfies TSchema;

type MemorySourceContract = Readonly<{ files: string; search: string }>;

function resolveMemorySourceContract(
  settings: NonNullable<ReturnType<typeof resolveMemorySearchConfig>>,
): MemorySourceContract {
  const files = [
    "MEMORY.md, USER.md, Markdown files recursively under memory/",
    settings.extraPaths.length > 0 ? "configured extra paths" : "",
  ]
    .filter(Boolean)
    .join(", ");
  return {
    files,
    search: settings.searchSources.includes("sessions")
      ? `${files}, indexed session transcripts`
      : files,
  };
}

export function resolveMemoryToolContext(options: MemoryToolOptions) {
  const cfg = options.getConfig ? options.getConfig() : options.config;
  if (!cfg) {
    return null;
  }
  const { sessionAgentId: agentId } = resolveSessionAgentIdsStrict({
    sessionKey: options.agentSessionKey,
    config: cfg,
    agentId: options.agentId,
  });
  const settings = resolveMemorySearchConfig(cfg, agentId);
  return settings
    ? { cfg, agentId, settings, sources: resolveMemorySourceContract(settings) }
    : null;
}

const SEARCH_CORPUS_OUTCOME_GUIDANCE =
  "Corpus outcomes cover each requested corpus; a corpus warning means results are partial and must be surfaced to the user.";
const GET_READ_OUTCOME_GUIDANCE =
  "status=ok means the requested excerpt was read; status=not_found means every requested available corpus missed.";

export const MEMORY_SEARCH_TOOL_CONTRACT = {
  label: "Memory Search",
  name: "memory_search",
  parameters: MemorySearchSchema,
  describe: ({ search }: MemorySourceContract) =>
    `Semantically search ${search} for durable context, prior work, decisions, dates, people, preferences, todos, and other continuity-relevant material. Optional \`corpus=wiki\` or \`corpus=all\` also searches registered compiled-wiki supplements. \`corpus=memory\` restricts hits to indexed memory files (excludes session transcript chunks from ranking). \`corpus=sessions\` restricts hits to the session corpus under the same visibility rules as session history tools. ${SEARCH_CORPUS_OUTCOME_GUIDANCE} If response has disabled=true or stale=true, tell the user and include the warning/action guidance.`,
} as const;

export const MEMORY_GET_TOOL_CONTRACT = {
  label: "Memory Get",
  name: "memory_get",
  parameters: MemoryGetSchema,
  describe: ({ files }: MemorySourceContract) =>
    `Safe exact excerpt read from ${files}. Defaults to a bounded excerpt when lines are omitted and includes truncation/continuation info when more content exists. \`corpus=wiki\` reads registered compiled-wiki supplements. ${GET_READ_OUTCOME_GUIDANCE} ${SEARCH_CORPUS_OUTCOME_GUIDANCE}`,
} as const;

export type MemoryToolContract =
  | typeof MEMORY_SEARCH_TOOL_CONTRACT
  | typeof MEMORY_GET_TOOL_CONTRACT;

export function buildMemoryPromptSection({
  availableTools,
  citationsMode,
  sources,
}: Parameters<MemoryPromptSectionBuilder>[0] & { sources: MemorySourceContract }): string[] {
  const hasMemorySearch = availableTools.has("memory_search");
  const hasMemoryGet = availableTools.has("memory_get");
  if (!hasMemorySearch && !hasMemoryGet) {
    return [];
  }

  let guidance: string;
  if (hasMemorySearch && hasMemoryGet) {
    guidance = `memory_search searches ${sources.search}; memory_get retrieves exact excerpts from ${sources.files}. Use them whenever context beyond the current turn may help with continuity, orientation, understanding, recall, or action. ${SEARCH_CORPUS_OUTCOME_GUIDANCE} For memory_get, ${GET_READ_OUTCOME_GUIDANCE}`;
  } else if (hasMemorySearch) {
    guidance = `memory_search searches ${sources.search}. Use it whenever context beyond the current turn may help with continuity, orientation, understanding, recall, or action. ${SEARCH_CORPUS_OUTCOME_GUIDANCE}`;
  } else {
    guidance = `memory_get retrieves exact excerpts from ${sources.files}. Use it whenever known memory context beyond the current turn may help with continuity, orientation, understanding, recall, or action. ${GET_READ_OUTCOME_GUIDANCE} ${SEARCH_CORPUS_OUTCOME_GUIDANCE}`;
  }
  const citationGuidance =
    citationsMode === "off"
      ? "Memory citation paths and line numbers are omitted from replies unless the user explicitly asks for them."
      : "Citations: include Source: <path#line> when it helps the user verify memory snippets.";
  return ["## Memory", guidance, citationGuidance, ""];
}
