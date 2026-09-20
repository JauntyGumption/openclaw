import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const targets = [
  {
    label: "attempt-setup.ts",
    url: new URL("../../src/agents/embedded-agent-runner/run/attempt-setup.ts", import.meta.url),
    expectedSha: "a55a398c26ec7f6014ff46420cf13b469fce37bc",
    replacements: [
      {
        label: "remove Ultra orchestration derivation",
        before: `  // Ultra is a logical orchestration mode, not a provider effort. Preserve it for
  // prompt/status surfaces, then lower only at agent-core and provider boundaries.
  const agentCoreThinkingLevel = mapThinkingLevel(params.thinkLevel);
  const providerThinkingLevel = mapThinkingLevelForProvider(params.thinkLevel);
  const proactiveSubagentOrchestration = params.thinkLevel === "ultra";
`,
        after: `  const agentCoreThinkingLevel = mapThinkingLevel(params.thinkLevel);
  const providerThinkingLevel = mapThinkingLevelForProvider(params.thinkLevel);
`,
      },
      {
        label: "remove Ultra orchestration setup result",
        before: `    proactiveSubagentOrchestration,
`,
        after: "",
      },
    ],
  },
  {
    label: "attempt.ts",
    url: new URL("../../src/agents/embedded-agent-runner/run/attempt.ts", import.meta.url),
    expectedSha: "a9e1899bc6c091f96d8407cbdee66e2b54fc6d8e",
    replacements: [
      {
        label: "remove Ultra orchestration destructure",
        before: `    proactiveSubagentOrchestration,
`,
        after: "",
      },
      {
        label: "remove Ultra orchestration prompt input",
        before: `        proactiveSubagentOrchestration,
`,
        after: "",
      },
    ],
  },
  {
    label: "attempt-system-prompt-prepare.ts",
    url: new URL(
      "../../src/agents/embedded-agent-runner/run/attempt-system-prompt-prepare.ts",
      import.meta.url,
    ),
    expectedSha: "dd862eea1f5a402057db0d15814505560ea831cc",
    replacements: [
      {
        label: "remove Ultra orchestration parameter",
        before: `  proactiveSubagentOrchestration: boolean;
`,
        after: "",
      },
      {
        label: "remove Ultra orchestration embedded prompt forwarding",
        before: `      proactiveSubagentOrchestration: params.proactiveSubagentOrchestration,
`,
        after: "",
      },
    ],
  },
  {
    label: "embedded system-prompt.ts",
    url: new URL("../../src/agents/embedded-agent-runner/system-prompt.ts", import.meta.url),
    expectedSha: "27344de31579b3df07688971537b0419621e7823",
    replacements: [
      {
        label: "remove Ultra orchestration parameter",
        before: `  /** Run-scoped Ultra behavior; independent from configured delegation preference. */
  proactiveSubagentOrchestration?: boolean;
`,
        after: "",
      },
      {
        label: "remove Ultra orchestration configured prompt forwarding",
        before: `    proactiveSubagentOrchestration: params.proactiveSubagentOrchestration,
`,
        after: "",
      },
    ],
  },
];

function gitBlobSha(text) {
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
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

const transformed = [];
for (const target of targets) {
  const path = fileURLToPath(target.url);
  let text = await readFile(path, "utf8");
  const actualSha = gitBlobSha(text);
  if (actualSha !== target.expectedSha) {
    throw new Error(
      `Refusing to patch unexpected ${target.label} blob ${actualSha}; expected ${target.expectedSha}`,
    );
  }
  for (const replacement of target.replacements) {
    text = replaceOnce(
      text,
      replacement.before,
      replacement.after,
      `${target.label}: ${replacement.label}`,
    );
  }
  if (text.includes("proactiveSubagentOrchestration")) {
    throw new Error(`${target.label} still carries proactiveSubagentOrchestration`);
  }
  transformed.push({ path, text, label: target.label });
}

if (process.argv.includes("--check")) {
  console.log(
    `Ultra/delegation decoupling applies cleanly to ${transformed.length} exact 2026.8.2 blobs.`,
  );
} else {
  for (const target of transformed) {
    await writeFile(target.path, target.text, "utf8");
  }
  console.log(
    "Removed Ultra-thinking delegation plumbing while preserving thinking-level mapping and sessions_spawn capability.",
  );
}
