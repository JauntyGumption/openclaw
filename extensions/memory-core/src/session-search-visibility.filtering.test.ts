// Memory Core tests cover result filtering and canonical tree/orphan visibility.
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import * as sessionTranscriptHit from "openclaw/plugin-sdk/session-transcript-hit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { filterMemorySearchHitsBySessionVisibility } from "./session-search-visibility.js";
import { asOpenClawConfig } from "./tools.test-helpers.js";

type TestSessionEntry = {
  sessionId: string;
  updatedAt: number;
  sessionFile: string;
  chatType?: "direct" | "group" | "channel";
};

const crossAgentStore: Record<string, TestSessionEntry> = {
  "agent:peer:only": {
    sessionId: "w1",
    updatedAt: 1,
    sessionFile: "/tmp/sessions/w1.jsonl",
  },
};
let combinedSessionStore: Record<string, TestSessionEntry> = crossAgentStore;

vi.mock("openclaw/plugin-sdk/session-transcript-hit", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-hit")>();
  return {
    ...actual,
    loadCombinedSessionStoreForGateway: vi.fn(() => ({
      storePath: "(test)",
      store: combinedSessionStore,
    })),
  };
});

describe("filterMemorySearchHitsBySessionVisibility filtering", () => {
  afterEach(() => {
    vi.mocked(sessionTranscriptHit.loadCombinedSessionStoreForGateway).mockClear();
    combinedSessionStore = crossAgentStore;
  });

  it("preserves ordinary memory while denying unauthorized configured transcript recall", async () => {
    combinedSessionStore = {};
    const memoryHit: MemorySearchResult = {
      path: "MEMORY.md",
      source: "memory",
      score: 1,
      snippet: "shared workspace memory",
      startLine: 1,
      endLine: 2,
    };
    const sessionHit: MemorySearchResult = {
      path: "sessions/private.jsonl",
      source: "sessions",
      score: 0.9,
      snippet: "private transcript",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "all" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main:active-memory:abcdef123456",
      sandboxed: false,
      hits: [memoryHit, sessionHit],
      conversationRecall: {
        anchorSessionKey: "agent:main:main",
        scope: "same-agent-private",
        corpus: "configured",
      },
    });

    expect(filtered).toEqual([memoryHit]);
  });

  it("restricts trusted sessions-only recall to transcript hits", async () => {
    combinedSessionStore = {
      "agent:main:telegram:direct:owner": {
        sessionId: "current",
        updatedAt: 2,
        sessionFile: "/tmp/sessions/current.jsonl",
        chatType: "direct",
      },
    };
    const hit: MemorySearchResult = {
      path: "memory/private.md",
      source: "memory",
      score: 1,
      snippet: "workspace memory",
      startLine: 1,
      endLine: 2,
    };
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "agent" } } });

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:telegram:direct:owner",
      sandboxed: false,
      hits: [hit],
      conversationRecall: {
        anchorSessionKey: "agent:main:telegram:direct:owner",
        scope: "same-agent-private",
        corpus: "sessions",
      },
    });

    expect(filtered).toStrictEqual([]);
  });

  it("loads the combined session store once per filter pass", async () => {
    const cfg = asOpenClawConfig({ tools: { sessions: { visibility: "all" } } });
    const hits: MemorySearchResult[] = [
      {
        path: "sessions/w1.jsonl",
        source: "sessions",
        score: 1,
        snippet: "a",
        startLine: 1,
        endLine: 2,
      },
      {
        path: "sessions/w1.jsonl",
        source: "sessions",
        score: 0.9,
        snippet: "b",
        startLine: 1,
        endLine: 2,
      },
    ];
    await filterMemorySearchHitsBySessionVisibility({
      cfg,
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits,
    });
    expect(sessionTranscriptHit.loadCombinedSessionStoreForGateway).toHaveBeenCalledTimes(1);
    expect(sessionTranscriptHit.loadCombinedSessionStoreForGateway).toHaveBeenCalledWith(cfg, {
      agentId: "main",
    });
  });

  it.each([
    { sandboxed: false, visible: true },
    { sandboxed: true, visible: false },
  ])(
    "applies canonical-main tree visibility with sandboxed=$sandboxed",
    async ({ sandboxed, visible }) => {
      combinedSessionStore = {
        "agent:main:slack:channel:team": {
          sessionId: "team",
          updatedAt: 1,
          sessionFile: "/tmp/sessions/team.jsonl",
          chatType: "channel",
        },
      };
      const hit: MemorySearchResult = {
        path: "sessions/team.jsonl",
        source: "sessions",
        score: 1,
        snippet: "team context",
        startLine: 1,
        endLine: 2,
      };

      const filtered = await filterMemorySearchHitsBySessionVisibility({
        cfg: asOpenClawConfig({
          tools: { sessions: { visibility: "tree" } },
          agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
        }),
        requesterSessionKey: "agent:main:main",
        sandboxed,
        hits: [hit],
      });

      expect(filtered).toEqual(visible ? [hit] : []);
    },
  );

  it("applies canonical global-main tree visibility in an explicit fleet", async () => {
    combinedSessionStore = {
      "agent:main:slack:channel:team": {
        sessionId: "team",
        updatedAt: 1,
        sessionFile: "/tmp/sessions/team.jsonl",
        chatType: "channel",
      },
    };
    const hit: MemorySearchResult = {
      path: "sessions/team.jsonl",
      source: "sessions",
      score: 1,
      snippet: "team context",
      startLine: 1,
      endLine: 2,
    };

    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg: asOpenClawConfig({
        session: { scope: "global" },
        tools: { sessions: { visibility: "tree" } },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "main" } },
          entries: { main: {}, research: {} },
        },
      }),
      agentId: "main",
      requesterSessionKey: "global",
      sandboxed: false,
      hits: [hit],
    });

    expect(filtered).toEqual([hit]);
  });

  it("keeps same-agent live orphan transcript hits", async () => {
    combinedSessionStore = {};
    const hit: MemorySearchResult = {
      path: "sessions/main/live-orphan.jsonl",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg: asOpenClawConfig({ tools: { sessions: { visibility: "agent" } } }),
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });
    expect(filtered).toEqual([hit]);
  });

  it("drops cross-agent live orphan transcript hits", async () => {
    combinedSessionStore = {};
    const hit: MemorySearchResult = {
      path: "sessions/peer/live-orphan.jsonl",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg: asOpenClawConfig({
        tools: {
          sessions: { visibility: "all" },
          agentToAgent: { enabled: true, allow: ["*"] },
        },
      }),
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });
    expect(filtered).toStrictEqual([]);
  });

  it("does not treat a same-agent orphan filename as proven self-session lineage", async () => {
    combinedSessionStore = {};
    const hit: MemorySearchResult = {
      path: "sessions/main/main.jsonl",
      source: "sessions",
      score: 1,
      snippet: "x",
      startLine: 1,
      endLine: 2,
    };
    const filtered = await filterMemorySearchHitsBySessionVisibility({
      cfg: asOpenClawConfig({ tools: { sessions: { visibility: "self" } } }),
      requesterSessionKey: "agent:main:main",
      sandboxed: false,
      hits: [hit],
    });
    expect(filtered).toStrictEqual([]);
  });
});
