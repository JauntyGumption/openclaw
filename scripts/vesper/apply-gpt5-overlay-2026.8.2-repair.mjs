import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const overlayUrl = new URL("../../src/agents/gpt5-prompt-overlay.ts", import.meta.url);
const runtimeUrl = new URL("../../src/plugins/provider-runtime.ts", import.meta.url);
const overlayPath = fileURLToPath(overlayUrl);
const runtimePath = fileURLToPath(runtimeUrl);

const EXPECTED_OVERLAY_BLOB_SHA = "9e8e950f5320378e68ae96bacbf085112b49f5da";
const EXPECTED_RUNTIME_BLOB_SHA = "5c10ed9f1b32604c2dd85574dce17559587013d0";

function gitBlobSha(text) {
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

function assertBlob(label, text, expected) {
  const actual = gitBlobSha(text);
  if (actual !== expected) {
    throw new Error(`Refusing to patch unexpected ${label} blob ${actual}; expected ${expected}`);
  }
}

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1) {
    throw new Error(`Missing expected block: ${label}`);
  }
  if (source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`Expected exactly one block for ${label}, found multiple`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

let overlay = await readFile(overlayPath, "utf8");
let runtime = await readFile(runtimePath, "utf8");
assertBlob("gpt5-prompt-overlay.ts", overlay, EXPECTED_OVERLAY_BLOB_SHA);
assertBlob("provider-runtime.ts", runtime, EXPECTED_RUNTIME_BLOB_SHA);

// Keep the historical export surface as a compatibility tombstone so an obscure
// importer cannot break the build, but remove every behavioral payload. The
// shared provider runtime below also stops calling this helper entirely.
overlay = `/**
 * Vesper fork compatibility tombstone for the deprecated GPT-5 prompt overlay.
 *
 * OpenClaw must not inject GPT-family-specific persona, tone, heartbeat,
 * execution, tool-discipline, output, or completion choreography. These exports
 * remain only so older internal imports fail closed to an empty contribution.
 */
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderSystemPromptContribution } from "./system-prompt-contribution.js";

const GPT5_MODEL_ID_PATTERN = /(?:^|[/:])gpt-5(?:[.-]|$)/i;
const OPENAI_FAMILY_GPT5_PROMPT_OVERLAY_PROVIDERS = new Set([
  "codex",
  "codex-cli",
  "openai",
  "azure-openai",
  "azure-openai-responses",
]);

export const GPT5_FRIENDLY_CHAT_PROMPT_OVERLAY = "";
export const GPT5_HEARTBEAT_PROMPT_OVERLAY = "";
export const GPT5_FRIENDLY_PROMPT_OVERLAY = "";
export const GPT5_BEHAVIOR_CONTRACT = "";

export type Gpt5PromptOverlayMode = "friendly" | "off";

export function normalizeGpt5PromptOverlayMode(value: unknown): Gpt5PromptOverlayMode | undefined {
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized === "off") {
    return "off";
  }
  if (normalized === "friendly" || normalized === "on") {
    return "friendly";
  }
  return undefined;
}

export function resolveGpt5PromptOverlayMode(
  config?: OpenClawConfig,
  legacyPluginConfig?: Record<string, unknown>,
  params?: { providerId?: string },
): Gpt5PromptOverlayMode {
  const providerId = normalizeOptionalLowercaseString(params?.providerId);
  const canUseOpenAiPluginFallback =
    !providerId || OPENAI_FAMILY_GPT5_PROMPT_OVERLAY_PROVIDERS.has(providerId);
  return (
    (canUseOpenAiPluginFallback
      ? normalizeGpt5PromptOverlayMode(config?.plugins?.entries?.openai?.config?.personality)
      : undefined) ??
    normalizeGpt5PromptOverlayMode(legacyPluginConfig?.personality) ??
    "off"
  );
}

export function isGpt5ModelId(modelId?: string): boolean {
  const normalized = normalizeOptionalLowercaseString(modelId);
  return normalized ? GPT5_MODEL_ID_PATTERN.test(normalized) : false;
}

export function resolveGpt5SystemPromptContribution(_params: {
  config?: OpenClawConfig;
  providerId?: string;
  modelId?: string;
  legacyPluginConfig?: Record<string, unknown>;
  enabled?: boolean;
  trigger?: "cron" | "heartbeat" | "manual" | "memory" | "overflow" | "user";
  includeHeartbeatGuidance?: boolean;
}): ProviderSystemPromptContribution | undefined {
  return undefined;
}
`;

runtime = replaceOnce(
  runtime,
  `import { resolveGpt5SystemPromptContribution } from "../agents/gpt5-prompt-overlay.js";\n`,
  "",
  "remove shared GPT-5 overlay import",
);

const oldRuntimeContribution = `export function resolveProviderSystemPromptContribution(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtimeHandle?: ProviderRuntimePluginHandle;
  context: ProviderSystemPromptContributionContext;
}): ProviderSystemPromptContribution | undefined {
  const plugin = ensureProviderRuntimePluginHandle(params).plugin;
  const baseOverlay = resolveGpt5SystemPromptContribution({
    config: params.context.config ?? params.config,
    providerId: params.context.provider ?? params.provider,
    modelId: params.context.modelId,
    trigger: params.context.trigger,
  });
  const providerOverlay =
    plugin?.resolvePromptOverlay?.({
      ...params.context,
      baseOverlay,
    }) ?? undefined;
  return mergeProviderSystemPromptContributions(
    mergeProviderSystemPromptContributions(baseOverlay, providerOverlay),
    plugin?.resolveSystemPromptContribution?.(params.context) ?? undefined,
  );
}`;

const newRuntimeContribution = `export function resolveProviderSystemPromptContribution(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtimeHandle?: ProviderRuntimePluginHandle;
  context: ProviderSystemPromptContributionContext;
}): ProviderSystemPromptContribution | undefined {
  const plugin = ensureProviderRuntimePluginHandle(params).plugin;
  const providerOverlay =
    plugin?.resolvePromptOverlay?.({
      ...params.context,
      baseOverlay: undefined,
    }) ?? undefined;
  return mergeProviderSystemPromptContributions(
    providerOverlay,
    plugin?.resolveSystemPromptContribution?.(params.context) ?? undefined,
  );
}`;

runtime = replaceOnce(
  runtime,
  oldRuntimeContribution,
  newRuntimeContribution,
  "remove shared GPT-5 base overlay from provider runtime",
);

if (runtime.includes("resolveGpt5SystemPromptContribution")) {
  throw new Error("provider-runtime.ts still references resolveGpt5SystemPromptContribution");
}
if (!runtime.includes("baseOverlay: undefined")) {
  throw new Error("provider runtime no longer makes the absence of a shared base overlay explicit");
}

for (const stale of [
  "<persona_latch>",
  "## Interaction Style",
  "### Heartbeats",
  "<execution_policy>",
  "<tool_discipline>",
  "<output_contract>",
  "<completion_contract>",
  "Keep persona/tone across turns",
  "Heartbeat = useful proactive progress",
  "Routine calls silent",
]) {
  if (overlay.includes(stale)) {
    throw new Error(`GPT-5 compatibility tombstone still contains behavioral overlay text: ${stale}`);
  }
}
if (!overlay.includes('GPT5_BEHAVIOR_CONTRACT = ""')) {
  throw new Error("GPT-5 behavior contract export is not inert");
}
if (!overlay.includes("return undefined;")) {
  throw new Error("GPT-5 overlay resolver is not inert");
}

if (process.argv.includes("--check")) {
  console.log("Complete GPT-5 overlay removal applies cleanly to exact 2026.8.2 repair blobs.");
} else {
  await writeFile(overlayPath, overlay, "utf8");
  await writeFile(runtimePath, runtime, "utf8");
  console.log("Removed GPT-5 behavioral overlay payloads and shared injection from the Vesper runtime.");
}
