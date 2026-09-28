/**
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

/** @deprecated Compatibility-only empty export; GPT-5 prompt overlays are no longer injected. */
export const GPT5_FRIENDLY_CHAT_PROMPT_OVERLAY = "";
/** @deprecated Compatibility-only empty export; GPT-5 prompt overlays are no longer injected. */
export const GPT5_HEARTBEAT_PROMPT_OVERLAY = "";
/** @deprecated Compatibility-only empty export; GPT-5 prompt overlays are no longer injected. */
export const GPT5_FRIENDLY_PROMPT_OVERLAY = "";
/** @deprecated Compatibility-only empty export; GPT-5 prompt overlays are no longer injected. */
export const GPT5_BEHAVIOR_CONTRACT = "";

/** @deprecated Compatibility-only mode accepted by legacy OpenAI plugin configuration. */
export type Gpt5PromptOverlayMode = "friendly" | "off";

/** @deprecated Compatibility-only normalization; the resolved mode does not inject prompt text. */
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

/** @deprecated Compatibility-only resolution; the resolved mode does not inject prompt text. */
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

/** @deprecated Compatibility-only model matcher; GPT-5 ids no longer trigger a shared overlay. */
export function isGpt5ModelId(modelId?: string): boolean {
  const normalized = normalizeOptionalLowercaseString(modelId);
  return normalized ? GPT5_MODEL_ID_PATTERN.test(normalized) : false;
}

/** @deprecated Compatibility-only no-op; always returns undefined. */
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
