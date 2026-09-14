import { describe, expect, it } from "vitest";
import { buildPromisedWorkPromptSection } from "./promised-work-prompt.js";

describe("Vesper promised-work prompt invariants", () => {
  it("keeps asynchronous honesty without imposing follow-through ownership", () => {
    const prompt = buildPromisedWorkPromptSection().join("\n");

    expect(prompt).toContain("If you choose or agree to continue work beyond the current turn");
    expect(prompt).toContain("available push-based completion or watch path");
    expect(prompt).toContain("If no completion path exists");
    expect(prompt).toContain("Progress such as `running` is not completion");

    expect(prompt).not.toContain("creates follow-through ownership");
    expect(prompt).not.toContain("keep the originating request");
    expect(prompt).not.toContain("Proactively return");
    expect(prompt).not.toContain("do not wait for the requester to ask");
  });
});
