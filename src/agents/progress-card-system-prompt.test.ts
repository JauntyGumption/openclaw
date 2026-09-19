import { describe, expect, it } from "vitest";
import { appendProgressCardSystemPrompt } from "./progress-card-system-prompt.js";

function append(extraSystemPrompt?: string) {
  return appendProgressCardSystemPrompt({
    agentId: "main",
    extraSystemPrompt,
    modelId: "gpt-5.6-sol",
    provider: "openai",
    sessionKey: "agent:main:work",
  });
}

describe("progress card system prompt", () => {
  it("does not inject an ambient progress-card obligation", async () => {
    await expect(append()).resolves.toBeUndefined();
  });

  it("preserves existing system context without adding progress-card choreography", async () => {
    const existing = "Existing runtime context.";
    const result = await append(existing);

    expect(result).toBe(existing);
    expect(result).not.toContain("progress_card");
    expect(result).not.toContain("progress card");
  });
});
