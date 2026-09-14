import { describe, expect, it } from "vitest";
import { HEARTBEAT_PROMPT, HEARTBEAT_RESPONSE_TOOL_PROMPT } from "./heartbeat.js";

describe("Vesper heartbeat prompt invariants", () => {
  it("keeps heartbeat orientation open to continuity and notification choice", () => {
    expect(HEARTBEAT_PROMPT).toContain(
      "Use HEARTBEAT.md standing guidance and heartbeat monitor scratch as the current heartbeat context when provided.",
    );
    expect(HEARTBEAT_PROMPT).toContain(
      "when you choose not to send a user-visible message.",
    );
    expect(HEARTBEAT_PROMPT).not.toContain("Do not infer or repeat old tasks from prior chats");
    expect(HEARTBEAT_PROMPT).not.toContain("If nothing needs attention");

    expect(HEARTBEAT_RESPONSE_TOOL_PROMPT).toContain(
      "Set notify=true with notificationText when you choose to send a user-visible message",
    );
    expect(HEARTBEAT_RESPONSE_TOOL_PROMPT).toContain(
      "set notify=false when you choose not to",
    );
    expect(HEARTBEAT_RESPONSE_TOOL_PROMPT).not.toContain("user should be interrupted");
    expect(HEARTBEAT_RESPONSE_TOOL_PROMPT).not.toContain("nothing needs the user's attention");
  });
});
