import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const testUrl = new URL(
  "../../src/agents/embedded-agent-runner/run/attempt-setup.test.ts",
  import.meta.url,
);
const testPath = fileURLToPath(testUrl);
const EXPECTED_TEST_BLOB_SHA = "edf8d126cc478b43e81922f4e05c0ff6dacc1e08";

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

let text = await readFile(testPath, "utf8");
const actualBlobSha = gitBlobSha(text);
if (actualBlobSha !== EXPECTED_TEST_BLOB_SHA) {
  throw new Error(
    `Refusing to patch unexpected attempt-setup.test.ts blob ${actualBlobSha}; expected ${EXPECTED_TEST_BLOB_SHA}`,
  );
}

const insertionPoint = `  });

  it.each(
    [undefined, "global", "agent:main:policy"].flatMap((sandboxSessionKey) =>`;

const replacement = `  });

  it("does not turn ultra thinking into proactive subagent orchestration", async () => {
    const setup = await prepareEmbeddedAttemptSetup({
      config: {},
      modelId: "gpt-5.4",
      provider: "openai",
      runId: "run-ultra-no-forced-delegation",
      sessionId: "session-ultra-no-forced-delegation",
      sessionKey: "agent:main:main",
      thinkLevel: "ultra",
      timeoutMs: 30_000,
      workspaceDir: path.join(os.tmpdir(), "openclaw-attempt-ultra-no-forced-delegation"),
    } as unknown as EmbeddedRunAttemptParams);

    expect(setup.proactiveSubagentOrchestration).toBe(false);
  });

  it.each(
    [undefined, "global", "agent:main:policy"].flatMap((sandboxSessionKey) =>`;

text = replaceOnce(
  text,
  insertionPoint,
  replacement,
  "ultra thinking does not imply proactive subagent orchestration",
);

if (!text.includes('it("does not turn ultra thinking into proactive subagent orchestration"')) {
  throw new Error("ultra-orchestration regression test was not inserted");
}

if (process.argv.includes("--check")) {
  console.log("Ultra-orchestration test migration applies cleanly to exact 2026.8.2 test blob.");
} else {
  await writeFile(testPath, text, "utf8");
  console.log("Added regression coverage for reasoning/delegation independence.");
}
