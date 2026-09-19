import type { OpenClawConfig } from "../config/types.openclaw.js";

/**
 * Vesper fork: progress_card remains available as a capability, but the runtime
 * does not impose an ambient obligation to maintain it. Context-specific skills
 * or workflows can decide when the durable status artifact is useful.
 *
 * Keep this seam explicit so upstream call sites remain easy to reconcile while
 * preserving the fork's policy boundary.
 */
export function appendProgressCardSystemPrompt(params: {
  agentId: string;
  authProfileId?: string;
  config?: OpenClawConfig;
  extraSystemPrompt?: string;
  modelId: string;
  provider: string;
  sessionKey?: string;
  toolsAllow?: string[];
}): Promise<string | undefined> {
  return Promise.resolve(params.extraSystemPrompt);
}
