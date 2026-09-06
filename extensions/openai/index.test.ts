// Openai tests cover index plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { requireRegisteredProvider } from "openclaw/plugin-sdk/plugin-test-runtime";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import * as providerHttp from "openclaw/plugin-sdk/provider-http";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIImageGenerationProvider } from "./image-generation-provider.js";
import plugin from "./index.js";

const runtimeMocks = vi.hoisted(() => ({
  ensureGlobalUndiciEnvProxyDispatcher: vi.fn(),
  refreshOpenAICodexToken: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return {
    ...actual,
    ensureGlobalUndiciEnvProxyDispatcher: runtimeMocks.ensureGlobalUndiciEnvProxyDispatcher,
  };
});

vi.mock("./openai-chatgpt-oauth-flow.runtime.js", () => ({
  refreshOpenAICodexToken: runtimeMocks.refreshOpenAICodexToken,
}));

import { createOpenAICodexProviderRuntime } from "./openai-chatgpt-provider.runtime.js";
async function registerOpenAIPluginWithHook(params?: { pluginConfig?: Record<string, unknown> }) {
  const on = vi.fn();
  const providers: ProviderPlugin[] = [];
  plugin.register(
    createTestPluginApi({
      id: "openai",
      name: "OpenAI Provider",
      source: "test",
      config: {},
      runtime: {} as never,
      pluginConfig: params?.pluginConfig,
      on,
      registerProvider: (provider) => {
        providers.push(provider);
      },
    }),
  );
  return { on, providers };
}

function mockOpenAIImageApiResponse(params: {
  finalUrl: string;
  imageData: string;
  revisedPrompt?: string;
}) {
  const response = () =>
    new Response(
      JSON.stringify({
        data: [
          {
            b64_json: Buffer.from(params.imageData).toString("base64"),
            ...(params.revisedPrompt ? { revised_prompt: params.revisedPrompt } : {}),
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  const resolveApiKeySpy = vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
    apiKey: "sk-test",
    source: "env",
    mode: "api-key",
  });
  const postJsonRequestSpy = vi.spyOn(providerHttp, "postJsonRequest").mockResolvedValue({
    finalUrl: params.finalUrl,
    response: response(),
    release: vi.fn(async () => {}),
  });
  const postMultipartRequestSpy = vi.spyOn(providerHttp, "postMultipartRequest").mockResolvedValue({
    finalUrl: params.finalUrl,
    response: response(),
    release: vi.fn(async () => {}),
  });
  vi.spyOn(providerHttp, "assertOkOrThrowHttpError").mockResolvedValue(undefined);
  return { resolveApiKeySpy, postJsonRequestSpy, postMultipartRequestSpy };
}

function firstMockArg(mocked: unknown): Record<string, unknown> {
  const arg = (mocked as { mock?: { calls?: unknown[][] } }).mock?.calls?.[0]?.[0];
  if (!arg || typeof arg !== "object") {
    throw new Error("Expected first mock argument");
  }
  return arg as Record<string, unknown>;
}

function mockCalls(mocked: unknown): unknown[][] {
  return (mocked as { mock?: { calls?: unknown[][] } }).mock?.calls ?? [];
}

function expectNoBeforePromptBuildHook(on: unknown): void {
  const hasBeforePromptBuild = mockCalls(on).some((call) => call[0] === "before_prompt_build");
  expect(hasBeforePromptBuild).toBe(false);
}

function expectNoRequestUrl(mocked: unknown, url: string): void {
  const hasUrl = mockCalls(mocked).some((call) => {
    const arg = call[0] as { url?: unknown } | undefined;
    return arg?.url === url;
  });
  expect(hasUrl).toBe(false);
}

describe("openai plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("generates PNG buffers from the OpenAI Images API", async () => {
    const { resolveApiKeySpy, postJsonRequestSpy } = mockOpenAIImageApiResponse({
      finalUrl: "https://api.openai.com/v1/images/generations",
      imageData: "png-data",
      revisedPrompt: "revised",
    });

    const provider = buildOpenAIImageGenerationProvider();
    const authStore = { version: 1, profiles: {} };
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "draw a cat",
      cfg: {},
      authStore,
      count: 2,
      size: "2048x2048",
    });

    const authArgs = firstMockArg(resolveApiKeySpy);
    expect(authArgs.provider).toBe("openai");
    expect(authArgs.store).toBe(authStore);
    const requestArgs = firstMockArg(postJsonRequestSpy);
    expect(requestArgs.url).toBe("https://api.openai.com/v1/images/generations");
    expect(requestArgs.body).toEqual({
      model: "gpt-image-2",
      prompt: "draw a cat",
      n: 2,
      size: "2048x2048",
    });
    expectNoRequestUrl(postJsonRequestSpy, "https://api.openai.com/v1/images/edits");
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("png-data"),
          mimeType: "image/png",
          fileName: "image-1.png",
          revisedPrompt: "revised",
        },
      ],
      model: "gpt-image-2",
    });
  });

  it("submits reference-image edits to the OpenAI Images edits endpoint", async () => {
    const { resolveApiKeySpy, postJsonRequestSpy, postMultipartRequestSpy } =
      mockOpenAIImageApiResponse({
        finalUrl: "https://api.openai.com/v1/images/edits",
        imageData: "edited-image",
      });

    const provider = buildOpenAIImageGenerationProvider();
    const authStore = { version: 1, profiles: {} };

    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-2",
      prompt: "Edit this image",
      cfg: {},
      authStore,
      count: 2,
      size: "1536x1024",
      inputImages: [
        { buffer: Buffer.from("x"), mimeType: "image/png" },
        { buffer: Buffer.from("y"), mimeType: "image/jpeg", fileName: "ref.jpg" },
      ],
    });

    const authArgs = firstMockArg(resolveApiKeySpy);
    expect(authArgs.provider).toBe("openai");
    expect(authArgs.store).toBe(authStore);
    const multipartArgs = firstMockArg(postMultipartRequestSpy);
    expect(multipartArgs.url).toBe("https://api.openai.com/v1/images/edits");
    expect(multipartArgs.body).toBeInstanceOf(FormData);
    expect(multipartArgs.allowPrivateNetwork).toBe(false);
    expect(multipartArgs.dispatcherPolicy).toBeUndefined();
    expect(multipartArgs.fetchFn).toBe(fetch);
    const editCallArgs = multipartArgs as unknown as {
      headers: Headers;
      body: FormData;
    };
    expect(editCallArgs.headers.has("Content-Type")).toBe(false);
    const form = editCallArgs.body;
    expect(form.get("model")).toBe("gpt-image-2");
    expect(form.get("prompt")).toBe("Edit this image");
    expect(form.get("n")).toBe("2");
    expect(form.get("size")).toBe("1536x1024");
    const images = form.getAll("image[]") as File[];
    expect(images).toHaveLength(2);
    expect(images[0]?.name).toBe("image-1.png");
    expect(images[0]?.type).toBe("image/png");
    expect(images[1]?.name).toBe("ref.jpg");
    expect(images[1]?.type).toBe("image/jpeg");
    expectNoRequestUrl(postJsonRequestSpy, "https://api.openai.com/v1/images/edits");
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("edited-image"),
          mimeType: "image/png",
          fileName: "image-1.png",
        },
      ],
      model: "gpt-image-2",
    });
  });

  it("does not allow private-network routing just because a custom base URL is configured", async () => {
    vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "sk-test",
      source: "env",
      mode: "api-key",
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildOpenAIImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "openai",
        model: "gpt-image-2",
        prompt: "draw a cat",
        cfg: {
          models: {
            providers: {
              openai: {
                baseUrl: "http://127.0.0.1:8080/v1",
                models: [],
              },
            },
          },
        } satisfies OpenClawConfig,
      }),
    ).rejects.toThrow("Blocked hostname or private/internal/special-use IP address");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bootstraps the env proxy dispatcher before refreshing codex oauth credentials", async () => {
    const refreshed = {
      access: "next-access",
      refresh: "next-refresh",
      expires: Date.now() + 60_000,
    };
    runtimeMocks.refreshOpenAICodexToken.mockResolvedValue(refreshed);
    const runtime = createOpenAICodexProviderRuntime({
      ensureGlobalUndiciEnvProxyDispatcher: runtimeMocks.ensureGlobalUndiciEnvProxyDispatcher,
      getOAuthApiKey: vi.fn(),
      refreshOpenAICodexToken: runtimeMocks.refreshOpenAICodexToken,
    });

    await expect(runtime.refreshOpenAICodexToken("refresh-token")).resolves.toBe(refreshed);

    expect(runtimeMocks.ensureGlobalUndiciEnvProxyDispatcher).toHaveBeenCalledOnce();
    expect(runtimeMocks.refreshOpenAICodexToken).toHaveBeenCalledOnce();
    expect(
      runtimeMocks.ensureGlobalUndiciEnvProxyDispatcher.mock.invocationCallOrder[0],
    ).toBeLessThan(runtimeMocks.refreshOpenAICodexToken.mock.invocationCallOrder[0]);
  });

  it("registers provider-owned OpenAI tool compat hooks for API and Codex transports", async () => {
    const { providers } = await registerOpenAIPluginWithHook();
    const openaiProvider = requireRegisteredProvider(providers, "openai");
    const noParamsTool = {
      name: "ping",
      description: "",
      parameters: {},
      execute: vi.fn(),
    } as never;

    const normalizedOpenAI = openaiProvider.normalizeToolSchemas?.({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      model: {
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5.4",
      } as never,
      tools: [noParamsTool],
    } as never);
    const normalizedCodex = openaiProvider.normalizeToolSchemas?.({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-chatgpt-responses",
      model: {
        provider: "openai",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        id: "gpt-5.4",
      } as never,
      tools: [noParamsTool],
    } as never);

    expect(normalizedOpenAI?.[0]?.parameters).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
    expect(normalizedCodex?.[0]?.parameters).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
    expect(
      openaiProvider.inspectToolSchemas?.({
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-responses",
        model: {
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          id: "gpt-5.4",
        } as never,
        tools: [noParamsTool],
      } as never),
    ).toStrictEqual([]);
    expect(
      openaiProvider.inspectToolSchemas?.({
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-chatgpt-responses",
        model: {
          provider: "openai",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api",
          id: "gpt-5.4",
        } as never,
        tools: [noParamsTool],
      } as never),
    ).toStrictEqual([]);
  });

  it("does not attach GPT-5 behavioral prompt contributions to the OpenAI provider", async () => {
    const { on, providers } = await registerOpenAIPluginWithHook({
      pluginConfig: { personality: "friendly" },
    });

    expectNoBeforePromptBuildHook(on);
    const openaiProvider = requireRegisteredProvider(providers, "openai");
    expect(openaiProvider.resolveSystemPromptContribution).toBeUndefined();
  });

});
