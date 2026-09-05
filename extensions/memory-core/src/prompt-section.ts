// Memory Core plugin module implements prompt section behavior.
import type { MemoryPromptSectionBuilder } from "openclaw/plugin-sdk/memory-core-host-runtime-core";

export const buildPromptSection: MemoryPromptSectionBuilder = ({
  availableTools,
  citationsMode,
}) => {
  const hasMemorySearch = availableTools.has("memory_search");
  const hasMemoryGet = availableTools.has("memory_get");

  if (!hasMemorySearch && !hasMemoryGet) {
    return [];
  }

  let toolGuidance: string;
  if (hasMemorySearch && hasMemoryGet) {
    toolGuidance =
      "memory_search searches durable memory and indexed session history; memory_get retrieves specific memory content. Use them whenever context beyond the current turn may help with continuity, orientation, understanding, recall, or action.";
  } else if (hasMemorySearch) {
    toolGuidance =
      "memory_search searches durable memory and indexed session history. Use it whenever context beyond the current turn may help with continuity, orientation, understanding, recall, or action.";
  } else {
    toolGuidance =
      "memory_get retrieves specific durable memory content. Use it whenever known memory context beyond the current turn may help with continuity, orientation, understanding, recall, or action.";
  }

  const lines = ["## Memory", toolGuidance];
  if (citationsMode === "off") {
    lines.push(
      "Memory citation paths and line numbers are omitted from replies unless the user explicitly asks for them.",
    );
  } else {
    lines.push(
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
  }
  lines.push("");
  return lines;
};
