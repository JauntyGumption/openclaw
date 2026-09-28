/**
 * System prompt report builder.
 *
 * Session metadata uses this report to account for prompt size, bootstrap file
 * injection, skills, and tool schema footprint without storing raw prompt text.
 */
import { createHash } from "node:crypto";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import type { SessionSystemPromptReport } from "../config/sessions/types.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import type { BootstrapInjectionStat } from "./bootstrap-budget.types.js";
import type { AgentTool } from "./runtime/index.js";

type ToolReportEntry = SessionSystemPromptReport["tools"]["entries"][number];

// Finalization rebuilds tool objects, while Code Mode updates retained descriptions.
// Cache only the summary digest, with bounded key size and entry count.
const toolSummaryHashCache = new Map<string, string>();
const MAX_TOOL_SUMMARY_HASHES = 512;
const MAX_CACHED_TOOL_SUMMARY_CHARS = 4_096;
const toolSchemaStatsCache = new WeakMap<
  object,
  Pick<ToolReportEntry, "propertiesCount" | "schemaChars" | "schemaHash">
>();

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function parseSkillBlocks(skillsPrompt: string): Array<{ name: string; blockChars: number }> {
  const prompt = skillsPrompt.trim();
  if (!prompt) {
    return [];
  }
  const blocks = Array.from(prompt.matchAll(/<skill>[\s\S]*?<\/skill>/gi)).map(
    (match) => match[0] ?? "",
  );
  return blocks
    .map((block) => {
      const name = block.match(/<name>\s*([^<]+?)\s*<\/name>/i)?.[1]?.trim() || "(unknown)";
      return { name, blockChars: block.length };
    })
    .filter((b) => b.blockChars > 0);
}

function buildToolSchemaStats(
  parameters: AgentTool["parameters"],
): Pick<ToolReportEntry, "propertiesCount" | "schemaChars" | "schemaHash"> {
  if (!parameters || typeof parameters !== "object") {
    return { schemaChars: 0, schemaHash: sha256(""), propertiesCount: null };
  }
  const cached = toolSchemaStatsCache.get(parameters);
  if (cached) {
    return cached;
  }
  let schemaJson;
  try {
    schemaJson = JSON.stringify(parameters);
  } catch {
    schemaJson = "";
  }
  const stats = {
    schemaChars: schemaJson.length,
    schemaHash: sha256(schemaJson),
    propertiesCount: (() => {
      const schema = parameters as Record<string, unknown>;
      const props = typeof schema.properties === "object" ? schema.properties : null;
      if (!props || typeof props !== "object") {
        return null;
      }
      return Object.keys(props as Record<string, unknown>).length;
    })(),
  };
  // Tool parameter objects are reused across runs; cache their stable size/hash
  // so report generation stays cheap during frequent prompt rebuilds.
  toolSchemaStatsCache.set(parameters, stats);
  return stats;
}

function resolveSummaryHash(summary: string): string {
  if (summary.length > MAX_CACHED_TOOL_SUMMARY_CHARS) {
    return sha256(summary);
  }
  const cached = toolSummaryHashCache.get(summary);
  if (cached !== undefined) {
    return cached;
  }
  const hash = sha256(summary);
  toolSummaryHashCache.set(summary, hash);
  pruneMapToMaxSize(toolSummaryHashCache, MAX_TOOL_SUMMARY_HASHES);
  return hash;
}

function buildToolsEntries(tools: AgentTool[]): SessionSystemPromptReport["tools"]["entries"] {
  return tools.map((tool) => {
    const name = tool.name;
    const summary = tool.description?.trim() || tool.label?.trim() || "";
    const summaryChars = summary.length;
    const schemaStats = buildToolSchemaStats(tool.parameters);
    return { name, summaryChars, summaryHash: resolveSummaryHash(summary), ...schemaStats };
  });
}

function measureRenderedSectionChars(params: {
  input: string;
  startMarkers: string[];
  endMarkers: string[];
  searchStart: number;
  searchEnd: number;
}): number {
  const starts = params.startMarkers
    .map((marker) => ({ marker, index: params.input.indexOf(marker, params.searchStart) }))
    .filter((entry) => entry.index >= params.searchStart && entry.index < params.searchEnd)
    .toSorted((a, b) => a.index - b.index);
  const start = starts[0];
  if (!start) {
    return 0;
  }
  const contentStart = start.index + start.marker.length;
  const end = Math.min(
    params.searchEnd,
    ...params.endMarkers
      // Workspace files are rendered verbatim and may contain section-like
      // headings. Callers therefore pass complete prompt-owned section openings
      // where possible, and the last matching opening wins over an earlier copy
      // inside a file.
      .map((marker) => params.input.lastIndexOf(marker, params.searchEnd - 1))
      .filter((index) => index >= contentStart && index <= params.searchEnd),
  );
  return Math.max(0, end - start.index);
}

function measureRenderedProjectContextChars(systemPrompt: string): number {
  const boundaryIndex = systemPrompt.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY);
  const stableEnd = boundaryIndex === -1 ? systemPrompt.length : boundaryIndex;
  const stableChars = measureRenderedSectionChars({
    input: systemPrompt,
    startMarkers: ["\n# Project Context\n"],
    endMarkers: [
      `\n## Delivery Suppression\nUse ${SILENT_REPLY_TOKEN} only when an explicit transport or delivery path requires a silent terminal response.`,
    ],
    searchStart: 0,
    searchEnd: stableEnd,
  });
  if (boundaryIndex === -1) {
    return stableChars;
  }
  const dynamicChars = measureRenderedSectionChars({
    input: systemPrompt,
    startMarkers: ["\n# Dynamic Project Context\n", "\n# Project Context\n"],
    endMarkers: [
      "\n## Temporal Context\nCurrent date: ",
      "\nexec approval-pending:",
      "\n## Authorized Senders\nAllowlisted senders: ",
      "\n## Control UI Embed\n`[embed ...]`:",
      "\n## Control UI Session Companion\n- Operator has ",
      "\n## Messaging\n- Current-session final text normally routes to source.",
      "\n## Messaging\n- Current source visible reply MUST use ",
      "\n## Messaging\n- Current source visible reply unavailable;",
      "\n## Collapsible Details\nThis surface renders ",
      "\n## Voice (TTS)\n",
      "\n## Conversation Context\n",
      "\n## Subagent Context\n",
      "\n## Reactions\n",
      "\n## Watched Sessions\n",
      "\n## Runtime\nRuntime: ",
    ],
    searchStart: boundaryIndex + SYSTEM_PROMPT_CACHE_BOUNDARY.length,
    searchEnd: systemPrompt.length,
  });
  return stableChars + dynamicChars;
}

/** Builds the stored report for a rendered system prompt and its inputs. */
export function buildSystemPromptReport(params: {
  source: SessionSystemPromptReport["source"];
  generatedAt: number;
  sessionId?: string;
  sessionKey?: string;
  provider?: string;
  model?: string;
  workspaceDir?: string;
  bootstrapMaxChars: number;
  bootstrapTotalMaxChars?: number;
  bootstrapTruncation?: SessionSystemPromptReport["bootstrapTruncation"];
  sandbox?: SessionSystemPromptReport["sandbox"];
  systemPrompt: string;
  injectedWorkspaceFiles: BootstrapInjectionStat[];
  skillsPrompt: string;
  tools: AgentTool[];
  currentTurn?: SessionSystemPromptReport["currentTurn"];
}): SessionSystemPromptReport {
  const systemPromptChars = params.systemPrompt.length;
  const projectContextChars = measureRenderedProjectContextChars(params.systemPrompt);
  const toolsEntries = buildToolsEntries(params.tools);
  const toolsSchemaChars = toolsEntries.reduce((sum, t) => sum + (t.schemaChars ?? 0), 0);
  const skillsEntries = parseSkillBlocks(params.skillsPrompt);

  return {
    source: params.source,
    generatedAt: params.generatedAt,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    model: params.model,
    workspaceDir: params.workspaceDir,
    bootstrapMaxChars: params.bootstrapMaxChars,
    bootstrapTotalMaxChars: params.bootstrapTotalMaxChars,
    ...(params.bootstrapTruncation ? { bootstrapTruncation: params.bootstrapTruncation } : {}),
    sandbox: params.sandbox,
    systemPrompt: {
      chars: systemPromptChars,
      hash: sha256(params.systemPrompt),
      projectContextChars,
      nonProjectContextChars: Math.max(0, systemPromptChars - projectContextChars),
    },
    ...(params.currentTurn ? { currentTurn: params.currentTurn } : {}),
    injectedWorkspaceFiles: params.injectedWorkspaceFiles,
    skills: {
      promptChars: params.skillsPrompt.length,
      hash: sha256(params.skillsPrompt),
      entries: skillsEntries,
    },
    tools: {
      listChars: 0,
      schemaChars: toolsSchemaChars,
      entries: toolsEntries,
    },
  };
}
