import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const targetUrl = new URL(
  "../../src/agents/embedded-agent-runner/run/attempt-setup.ts",
  import.meta.url,
);
const targetPath = fileURLToPath(targetUrl);
const EXPECTED_BLOB_SHA = "a55a398c26ec7f6014ff46420cf13b469fce37bc";

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

let text = await readFile(targetPath, "utf8");
const actualBlobSha = gitBlobSha(text);
if (actualBlobSha !== EXPECTED_BLOB_SHA) {
  throw new Error(
    `Refusing to patch unexpected attempt-setup.ts blob ${actualBlobSha}; expected ${EXPECTED_BLOB_SHA}`,
  );
}

text = replaceOnce(
  text,
  `  // Ultra is a logical orchestration mode, not a provider effort. Preserve it for
  // prompt/status surfaces, then lower only at agent-core and provider boundaries.
  const agentCoreThinkingLevel = mapThinkingLevel(params.thinkLevel);
  const providerThinkingLevel = mapThinkingLevelForProvider(params.thinkLevel);
  const proactiveSubagentOrchestration = params.thinkLevel === "ultra";`,
  `  // Thinking level controls reasoning effort only. Delegation remains an independent
  // capability and is not silently assigned by a reasoning-level choice.
  const agentCoreThinkingLevel = mapThinkingLevel(params.thinkLevel);
  const providerThinkingLevel = mapThinkingLevelForProvider(params.thinkLevel);
  const proactiveSubagentOrchestration = false;`,
  "decouple ultra thinking from proactive subagent orchestration",
);

if (text.includes('params.thinkLevel === "ultra"')) {
  throw new Error("ultra thinking still implicitly enables proactive subagent orchestration");
}
if (!text.includes("const proactiveSubagentOrchestration = false;")) {
  throw new Error("attempt setup no longer makes the absence of implicit orchestration explicit");
}

if (process.argv.includes("--check")) {
  console.log("Ultra-orchestration decoupling applies cleanly to exact 2026.8.2 attempt-setup blob.");
} else {
  await writeFile(targetPath, text, "utf8");
  console.log("Decoupled reasoning level from proactive subagent orchestration.");
}
