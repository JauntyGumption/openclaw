// System prompt report tests cover prompt accounting, bootstrap injection
// matching, and hash output used to compare prompt/tool parity.
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { describe, expect, it } from "vitest";
import { buildBootstrapInjectionStats } from "./bootstrap-budget.js";
import { buildSystemPromptReport } from "./system-prompt-report.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

function makeBootstrapFile(overrides: Partial<WorkspaceBootstrapFile>): WorkspaceBootstrapFile {
  return {
    name: "AGENTS.md",
    path: "/tmp/workspace/AGENTS.md",
    content: "alpha",
    missing: false,
    ...overrides,
  };
}

describe("buildSystemPromptReport", () => {
  const makeReport = (params: {
    file: WorkspaceBootstrapFile;
    injectedPath: string;
    injectedContent: string;
    bootstrapMaxChars?: number;
    bootstrapTotalMaxChars?: number;
  }) =>
    buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: params.bootstrapMaxChars ?? 20_000,
      bootstrapTotalMaxChars: params.bootstrapTotalMaxChars,
      systemPrompt: "system",
      injectedWorkspaceFiles: buildBootstrapInjectionStats({
        bootstrapFiles: [params.file],
        injectedFiles: [{ path: params.injectedPath, content: params.injectedContent }],
      }),
      skillsPrompt: "",
      tools: [],
    });

  it("counts injected chars when injected file paths are absolute", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = makeReport({
      file,
      injectedPath: "/tmp/workspace/policies/AGENTS.md",
      injectedContent: "trimmed",
    });

    expect(report.injectedWorkspaceFiles[0]?.injectedChars).toBe("trimmed".length);
  });

  it("keeps legacy basename matching for injected files", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = makeReport({
      file,
      injectedPath: "AGENTS.md",
      injectedContent: "trimmed",
    });

    expect(report.injectedWorkspaceFiles[0]?.injectedChars).toBe("trimmed".length);
  });

  it("marks workspace files truncated when injected chars are smaller than raw chars", () => {
    const file = makeBootstrapFile({
      path: "/tmp/workspace/policies/AGENTS.md",
      content: "abcdefghijklmnopqrstuvwxyz",
    });
    const report = makeReport({
      file,
      injectedPath: "/tmp/workspace/policies/AGENTS.md",
      injectedContent: "trimmed",
    });

    expect(report.injectedWorkspaceFiles[0]?.truncated).toBe(true);
  });

  it("includes both bootstrap caps in the report payload", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = makeReport({
      file,
      injectedPath: "AGENTS.md",
      injectedContent: "trimmed",
      bootstrapMaxChars: 11_111,
      bootstrapTotalMaxChars: 22_222,
    });

    expect(report.bootstrapMaxChars).toBe(11_111);
    expect(report.bootstrapTotalMaxChars).toBe(22_222);
  });

  it("reports zero in-band tool list chars when tool info stays structured", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = makeReport({
      file,
      injectedPath: "AGENTS.md",
      injectedContent: "trimmed",
    });

    expect(report.tools.listChars).toBe(0);
  });

  it("reports injectedChars=0 when injected file does not match by path or basename", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = makeReport({
      file,
      injectedPath: "/tmp/workspace/policies/OTHER.md",
      injectedContent: "trimmed",
    });

    expect(report.injectedWorkspaceFiles[0]?.injectedChars).toBe(0);
    expect(report.injectedWorkspaceFiles[0]?.truncated).toBe(true);
  });

  it("ignores malformed injected file paths and still matches valid entries", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/policies/AGENTS.md" });
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: "system",
      injectedWorkspaceFiles: buildBootstrapInjectionStats({
        bootstrapFiles: [file],
        injectedFiles: [
          { path: 123 as unknown as string, content: "bad" },
          { path: "/tmp/workspace/policies/AGENTS.md", content: "trimmed" },
        ],
      }),
      skillsPrompt: "",
      tools: [],
    });

    expect(report.injectedWorkspaceFiles[0]?.injectedChars).toBe("trimmed".length);
  });

  it("does not count injected files as project context when the rendered prompt omits them", () => {
    const file = makeBootstrapFile({
      path: "/tmp/workspace/AGENTS.md",
      content: "raw bootstrap context",
    });
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: "custom override",
      injectedWorkspaceFiles: buildBootstrapInjectionStats({
        bootstrapFiles: [file],
        injectedFiles: [{ path: "/tmp/workspace/AGENTS.md", content: "rendered context" }],
      }),
      skillsPrompt: "",
      tools: [],
    });

    expect(report.systemPrompt.chars).toBe("custom override".length);
    expect(report.systemPrompt.projectContextChars).toBe(0);
    expect(report.systemPrompt.nonProjectContextChars).toBe("custom override".length);
  });

  it("stops project-context accounting at the delivery-suppression heading", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/AGENTS.md" });
    const projectContext = "\n# Project Context\n## AGENTS.md\n\nrendered context\n";
    const systemPrompt = [
      "Runtime: OpenClaw.",
      projectContext,
      "## Delivery Suppression\nUse NO_REPLY only when an explicit transport or delivery path requires a silent terminal response.",
      SYSTEM_PROMPT_CACHE_BOUNDARY,
      "## Temporal Context\nCurrent date: 2026-09-20",
    ].join("\n");
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt,
      injectedWorkspaceFiles: buildBootstrapInjectionStats({
        bootstrapFiles: [file],
        injectedFiles: [{ path: file.path, content: "rendered context" }],
      }),
      skillsPrompt: "",
      tools: [],
    });

    expect(report.systemPrompt.projectContextChars).toBe(projectContext.length);
    expect(report.systemPrompt.nonProjectContextChars).toBe(
      systemPrompt.length - projectContext.length,
    );
  });

  it("does not treat a delivery-suppression heading inside a workspace file as the boundary", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/AGENTS.md" });
    const projectContext =
      "\n# Project Context\n## AGENTS.md\n\npolicy notes\n## Delivery Suppression\nthis heading is file content\n";
    const systemPrompt = [
      "Runtime: OpenClaw.",
      projectContext,
      "## Delivery Suppression\nUse NO_REPLY only when an explicit transport or delivery path requires a silent terminal response.",
      SYSTEM_PROMPT_CACHE_BOUNDARY,
      "## Runtime\nRuntime: host=test",
    ].join("\n");
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt,
      injectedWorkspaceFiles: buildBootstrapInjectionStats({
        bootstrapFiles: [file],
        injectedFiles: [{ path: file.path, content: "policy notes" }],
      }),
      skillsPrompt: "",
      tools: [],
    });

    expect(report.systemPrompt.projectContextChars).toBe(projectContext.length);
  });

  it("does not invent delivery suppression when only workspace content uses that heading", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/AGENTS.md" });
    const projectContext =
      "\n# Project Context\n## AGENTS.md\n\npolicy notes\n## Delivery Suppression\nthis heading is file content\n";
    const systemPrompt = `Runtime: OpenClaw.${projectContext}${SYSTEM_PROMPT_CACHE_BOUNDARY}\n## Runtime\nRuntime: host=test`;
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt,
      injectedWorkspaceFiles: buildBootstrapInjectionStats({
        bootstrapFiles: [file],
        injectedFiles: [{ path: file.path, content: "policy notes" }],
      }),
      skillsPrompt: "",
      tools: [],
    });

    expect(report.systemPrompt.projectContextChars).toBe(projectContext.length);
  });

  it("uses the cache boundary when delivery suppression is omitted", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/AGENTS.md" });
    const projectContext = "\n# Project Context\n## AGENTS.md\n\nrendered context\n";
    const systemPrompt = `Runtime: OpenClaw.${projectContext}${SYSTEM_PROMPT_CACHE_BOUNDARY}\n## Temporal Context`;
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt,
      injectedWorkspaceFiles: buildBootstrapInjectionStats({
        bootstrapFiles: [file],
        injectedFiles: [{ path: file.path, content: "rendered context" }],
      }),
      skillsPrompt: "",
      tools: [],
    });

    expect(report.systemPrompt.projectContextChars).toBe(projectContext.length);
  });

  it("counts stable and dynamic project context on both sides of the cache boundary", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/AGENTS.md" });
    const stableContext = "\n# Project Context\n## AGENTS.md\n\nrendered context\n";
    const dynamicContext =
      "\n# Dynamic Project Context\nFrequently changing workspace guidance:\n## HEARTBEAT.md\n\ncheck inbox\n";
    const systemPrompt = `Runtime: OpenClaw.${stableContext}${SYSTEM_PROMPT_CACHE_BOUNDARY}${dynamicContext}\n## Temporal Context\nCurrent date: 2026-09-20`;
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt,
      injectedWorkspaceFiles: buildBootstrapInjectionStats({
        bootstrapFiles: [file],
        injectedFiles: [{ path: file.path, content: "rendered context" }],
      }),
      skillsPrompt: "",
      tools: [],
    });

    expect(report.systemPrompt.projectContextChars).toBe(
      stableContext.length + dynamicContext.length,
    );
  });

  it("does not treat a runtime heading inside dynamic workspace content as the boundary", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/HEARTBEAT.md" });
    const dynamicContext =
      "\n# Project Context\nFrequently changing workspace guidance:\n\n## HEARTBEAT.md\n\nnotes\n## Runtime\nthis heading is file content\n";
    const systemPrompt = `Runtime: OpenClaw.${SYSTEM_PROMPT_CACHE_BOUNDARY}${dynamicContext}\n## Temporal Context\nCurrent date: 2026-09-21\nTime zone: UTC\n## Runtime\nRuntime: host=test`;
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt,
      injectedWorkspaceFiles: buildBootstrapInjectionStats({
        bootstrapFiles: [file],
        injectedFiles: [{ path: file.path, content: "notes" }],
      }),
      skillsPrompt: "",
      tools: [],
    });

    expect(report.systemPrompt.projectContextChars).toBe(dynamicContext.length);
  });

  it("does not treat another prompt heading inside dynamic workspace content as the boundary", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/HEARTBEAT.md" });
    const dynamicContext =
      "\n# Dynamic Project Context\nFrequently changing workspace guidance:\n## HEARTBEAT.md\n\nnotes\n## Authorized Senders\nthis heading is file content\n";
    const systemPrompt = `Runtime: OpenClaw.${SYSTEM_PROMPT_CACHE_BOUNDARY}${dynamicContext}\n## Temporal Context\nCurrent date: 2026-09-21`;
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt,
      injectedWorkspaceFiles: buildBootstrapInjectionStats({
        bootstrapFiles: [file],
        injectedFiles: [{ path: file.path, content: "notes" }],
      }),
      skillsPrompt: "",
      tools: [],
    });

    expect(report.systemPrompt.projectContextChars).toBe(dynamicContext.length);
  });

  it("stops dynamic-only project context before approval guidance", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/HEARTBEAT.md" });
    const dynamicContext =
      "\n# Project Context\nFrequently changing workspace guidance:\n## HEARTBEAT.md\n\ncheck inbox\n";
    const systemPrompt = `Runtime: OpenClaw.${SYSTEM_PROMPT_CACHE_BOUNDARY}${dynamicContext}\nexec approval-pending: use native UI.\n## Runtime\nRuntime details`;
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt,
      injectedWorkspaceFiles: buildBootstrapInjectionStats({
        bootstrapFiles: [file],
        injectedFiles: [{ path: file.path, content: "check inbox" }],
      }),
      skillsPrompt: "",
      tools: [],
    });

    expect(report.systemPrompt.projectContextChars).toBe(dynamicContext.length);
    expect(report.systemPrompt.nonProjectContextChars).toBe(
      systemPrompt.length - dynamicContext.length,
    );
  });

  it("emits content hashes for prompt and tool parity checks", () => {
    // Hashes catch same-length prompt/tool drift that plain character counts
    // would miss when comparing runtime payloads.
    const file = makeBootstrapFile({ path: "/tmp/workspace/AGENTS.md" });
    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: "system",
      injectedWorkspaceFiles: buildBootstrapInjectionStats({
        bootstrapFiles: [file],
        injectedFiles: [],
      }),
      skillsPrompt: "<skill><name>docs</name></skill>",
      tools: [
        {
          name: "read",
          description: "Read files",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      ] as never,
    });
    const sameLengthChangedPrompt = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: "systen",
      injectedWorkspaceFiles: buildBootstrapInjectionStats({
        bootstrapFiles: [file],
        injectedFiles: [],
      }),
      skillsPrompt: "<skill><name>docs</name></skill>",
      tools: [],
    });

    expect(report.systemPrompt.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.skills.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.tools.entries[0]?.summaryHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(report.tools.entries[0]?.schemaHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(sameLengthChangedPrompt.systemPrompt.hash).not.toBe(report.systemPrompt.hash);
  });

  it("keeps reporting when a tool schema cannot be stringified", () => {
    const file = makeBootstrapFile({ path: "/tmp/workspace/AGENTS.md" });
    const circularSchema: Record<string, unknown> = {
      type: "object",
      properties: { count: { type: "integer" } },
    };
    circularSchema.self = circularSchema;

    const report = buildSystemPromptReport({
      source: "run",
      generatedAt: 0,
      bootstrapMaxChars: 20_000,
      systemPrompt: "system",
      injectedWorkspaceFiles: buildBootstrapInjectionStats({
        bootstrapFiles: [file],
        injectedFiles: [],
      }),
      skillsPrompt: "",
      tools: [
        {
          name: "broken",
          description: "Broken schema",
          parameters: circularSchema,
        },
      ] as never,
    });

    expect(report.tools.entries[0]).toMatchObject({
      name: "broken",
      schemaChars: 0,
      propertiesCount: 1,
    });
    expect(report.tools.entries[0]?.schemaHash).toMatch(/^[a-f0-9]{64}$/u);
  });
});
