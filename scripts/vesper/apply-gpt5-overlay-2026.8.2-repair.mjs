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

const oldResolver = `export function resolveGpt5SystemPromptContribution(params: {
  config?: OpenClawConfig;
  providerId?: string;
  modelId?: string;
  legacyPluginConfig?: Record<string, unknown>;
  enabled?: boolean;
  trigger?: "cron" | "heartbeat" | "manual" | "memory" | "overflow" | "user";
  includeHeartbeatGuidance?: boolean;
}): ProviderSystemPromptContribution | undefined {
  if (params.enabled === false || !isGpt5ModelId(params.modelId)) {
    return undefined;
  }
  const mode = resolveGpt5PromptOverlayMode(params.config, params.legacyPluginConfig, {
    providerId: params.providerId,
  });
  const interactionStyle =
    params.includeHeartbeatGuidance === true
      ? GPT5_FRIENDLY_PROMPT_OVERLAY
      : GPT5_FRIENDLY_CHAT_PROMPT_OVERLAY;
  return {
    stablePrefix: GPT5_BEHAVIOR_CONTRACT,
    sectionOverrides: mode === "friendly" ? { interaction_style: interactionStyle } : {},
  };
}`;

const newResolver = `export function resolveGpt5SystemPromptContribution(_params: {
  config?: OpenClawConfig;
  providerId?: string;
  modelId?: string;
  legacyPluginConfig?: Record<string, unknown>;
  enabled?: boolean;
  trigger?: "cron" | "heartbeat" | "manual" | "memory" | "overflow" | "user";
  includeHeartbeatGuidance?: boolean;
}): ProviderSystemPromptContribution | undefined {
  // Vesper fork: GPT-family behavior overlays are not runtime policy.
  // Continuity, tone, execution style, and tool discipline come from authored
  // workspace context, explicit skills, and the normal OpenClaw capability layer.
  return undefined;
}`;

overlay = replaceOnce(overlay, oldResolver, newResolver, "neutralize GPT-5 overlay resolver");

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
if (overlay.includes("stablePrefix: GPT5_BEHAVIOR_CONTRACT")) {
  throw new Error("gpt5-prompt-overlay.ts still returns the GPT-5 behavior contract");
}

if (process.argv.includes("--check")) {
  console.log("GPT-5 overlay removal applies cleanly to exact 2026.8.2 repair blobs.");
} else {
  await writeFile(overlayPath, overlay, "utf8");
  await writeFile(runtimePath, runtime, "utf8");
  console.log("Removed shared GPT-5 behavior overlay injection from the Vesper runtime.");
}
