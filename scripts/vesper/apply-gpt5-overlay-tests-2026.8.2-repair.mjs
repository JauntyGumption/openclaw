import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const testUrl = new URL("../../src/plugins/provider-runtime.test.ts", import.meta.url);
const testPath = fileURLToPath(testUrl);
const EXPECTED_TEST_BLOB_SHA = "5307c069b9a9d13fea0019fd66eb58592c9773f5";

function gitBlobSha(text) {
  const bytes = Buffer.from(text, "utf8");
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

function replaceRange(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`Missing start marker for ${label}`);
  }
  if (source.indexOf(startMarker, start + startMarker.length) !== -1) {
    throw new Error(`Start marker for ${label} is not unique`);
  }
  const end = source.indexOf(endMarker, start);
  if (end === -1) {
    throw new Error(`Missing end marker for ${label}`);
  }
  if (source.indexOf(endMarker, end + endMarker.length) !== -1) {
    throw new Error(`End marker for ${label} is not unique`);
  }
  return source.slice(0, start) + replacement + source.slice(end);
}

let text = await readFile(testPath, "utf8");
const actualBlobSha = gitBlobSha(text);
if (actualBlobSha !== EXPECTED_TEST_BLOB_SHA) {
  throw new Error(
    `Refusing to patch unexpected provider-runtime.test.ts blob ${actualBlobSha}; expected ${EXPECTED_TEST_BLOB_SHA}`,
  );
}

const startMarker = `  it("applies the shared GPT-5 prompt overlay for any provider", () => {`;
const endMarker = `  it("does not apply the shared GPT-5 prompt overlay to non-GPT-5 models", () => {`;

const replacement = `  it("does not inject a shared GPT-5 prompt overlay for any provider", () => {
    const contribution = resolveProviderSystemPromptContribution({
      provider: "openrouter",
      runtimeHandle: {
        provider: "openrouter",
        plugin: undefined,
      },
      context: {
        provider: "openrouter",
        modelId: "openai/gpt-5.4",
        promptMode: "full",
        trigger: "user",
      } as never,
    });

    expect(contribution).toBeUndefined();
  });

  it("passes no shared GPT-5 base overlay into provider-owned prompt hooks", () => {
    const resolvePromptOverlay = vi.fn((context: { baseOverlay?: unknown }) => ({
      stablePrefix: context.baseOverlay ? "unexpected shared overlay" : "provider-owned overlay",
    }));
    registerLoadedProviders([
      {
        id: "openrouter",
        label: "OpenRouter",
        auth: [],
        resolvePromptOverlay,
      } as ProviderPlugin,
    ]);

    const contribution = resolveProviderSystemPromptContribution({
      provider: "openrouter",
      context: {
        provider: "openrouter",
        modelId: "openai/gpt-5.4",
        promptMode: "full",
        trigger: "user",
      } as never,
    });

    expect(contribution?.stablePrefix).toBe("provider-owned overlay");
    expect(resolvePromptOverlay).toHaveBeenCalledTimes(1);
    expect(firstMockArg(resolvePromptOverlay)).toMatchObject({ baseOverlay: undefined });
  });

`;

text = replaceRange(
  text,
  startMarker,
  endMarker,
  replacement,
  "shared GPT-5 overlay behavior tests",
);

for (const stale of [
  "applies the shared GPT-5 prompt overlay for any provider",
  "keeps scheduled heartbeat guidance out of shared GPT-5 provider overlays",
  "keeps OpenAI plugin personality fallback for OpenAI-family GPT-5 providers",
  "keeps OpenAI plugin personality fallback for Azure OpenAI GPT-5 providers",
]) {
  if (text.includes(stale)) {
    throw new Error(`Stale shared-overlay expectation remains: ${stale}`);
  }
}
if (!text.includes("does not inject a shared GPT-5 prompt overlay for any provider")) {
  throw new Error("Missing Vesper no-shared-GPT5-overlay regression test");
}
if (!text.includes("passes no shared GPT-5 base overlay into provider-owned prompt hooks")) {
  throw new Error("Missing provider-owned overlay regression test");
}

if (process.argv.includes("--check")) {
  console.log("GPT-5 overlay test migration applies cleanly to the exact provider-runtime test blob.");
} else {
  await writeFile(testPath, text, "utf8");
  console.log("Migrated provider-runtime tests to the Vesper no-shared-GPT5-overlay invariant.");
}
