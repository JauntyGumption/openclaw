/**
 * Runtime contract coverage for the deprecated GPT-5 prompt overlay shim.
 * All compatibility inputs must fail closed without adding prompt text.
 */
import {
  CODEX_CONTRACT_PROVIDER_ID,
  GPT5_CONTRACT_MODEL_ID,
  GPT5_PREFIXED_CONTRACT_MODEL_ID,
  NON_GPT5_CONTRACT_MODEL_ID,
  NON_OPENAI_CONTRACT_PROVIDER_ID,
  OPENAI_CONTRACT_PROVIDER_ID,
  openAiPluginPersonalityConfig,
  sharedGpt5PersonalityConfig,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { describe, expect, it } from "vitest";
import {
  GPT5_BEHAVIOR_CONTRACT,
  GPT5_FRIENDLY_CHAT_PROMPT_OVERLAY,
  GPT5_FRIENDLY_PROMPT_OVERLAY,
  GPT5_HEARTBEAT_PROMPT_OVERLAY,
  resolveGpt5SystemPromptContribution,
} from "./gpt5-prompt-overlay.js";

describe("GPT-5 prompt overlay runtime contract", () => {
  it("keeps deprecated prompt payload exports empty", () => {
    expect(GPT5_BEHAVIOR_CONTRACT).toBe("");
    expect(GPT5_FRIENDLY_CHAT_PROMPT_OVERLAY).toBe("");
    expect(GPT5_FRIENDLY_PROMPT_OVERLAY).toBe("");
    expect(GPT5_HEARTBEAT_PROMPT_OVERLAY).toBe("");
  });

  it.each([
    {
      name: "default OpenAI GPT-5 route",
      params: { providerId: OPENAI_CONTRACT_PROVIDER_ID, modelId: GPT5_CONTRACT_MODEL_ID },
    },
    {
      name: "heartbeat guidance request",
      params: {
        providerId: OPENAI_CONTRACT_PROVIDER_ID,
        modelId: GPT5_CONTRACT_MODEL_ID,
        trigger: "heartbeat" as const,
        includeHeartbeatGuidance: true,
      },
    },
    {
      name: "retired shared personality switch",
      params: {
        providerId: NON_OPENAI_CONTRACT_PROVIDER_ID,
        modelId: GPT5_PREFIXED_CONTRACT_MODEL_ID,
        config: sharedGpt5PersonalityConfig("off"),
      },
    },
    {
      name: "OpenAI plugin personality fallback",
      params: {
        providerId: OPENAI_CONTRACT_PROVIDER_ID,
        modelId: GPT5_CONTRACT_MODEL_ID,
        config: openAiPluginPersonalityConfig("friendly"),
      },
    },
    {
      name: "Codex virtual provider",
      params: {
        providerId: CODEX_CONTRACT_PROVIDER_ID,
        modelId: GPT5_CONTRACT_MODEL_ID,
        config: openAiPluginPersonalityConfig("on"),
      },
    },
    {
      name: "non-GPT-5 model",
      params: {
        providerId: OPENAI_CONTRACT_PROVIDER_ID,
        modelId: NON_GPT5_CONTRACT_MODEL_ID,
      },
    },
  ])("returns no contribution for $name", ({ params }) => {
    expect(resolveGpt5SystemPromptContribution(params)).toBeUndefined();
  });
});
