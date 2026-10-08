import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  replaceTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../../../src/config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../../src/state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../../../src/state/openclaw-state-db.js";
import {
  buildQmdSqliteSessionParts,
  QmdSessionTranscriptGenerationChangedError,
} from "./qmd-session-parts.js";
import { buildSessionEntry } from "./session-files.js";

let tmpDir: string;
let previousStateDir: string | undefined;
let previousConfigPath: string | undefined;

beforeEach(() => {
  tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "qmd-session-parts-test-"));
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", tmpDir);
  clearRuntimeConfigSnapshot();
  clearConfigCache();
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  if (previousStateDir === undefined) {
    Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
  } else {
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", previousStateDir);
  }
  if (previousConfigPath === undefined) {
    Reflect.deleteProperty(process.env, "OPENCLAW_CONFIG_PATH");
  } else {
    Reflect.set(process.env, "OPENCLAW_CONFIG_PATH", previousConfigPath);
  }
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  fsSync.rmSync(tmpDir, { recursive: true, force: true });
});

describe("QMD SQLite session parts", () => {
  it("preserves whole-session export semantics across bounded pages and parts", async () => {
    const scope = {
      agentId: "main",
      sessionId: "multipart-parity",
      sessionKey: "agent:main:chat:multipart-parity",
      storePath: path.join(tmpDir, "agents", "main", "sessions", "sessions.json"),
    };
    const observedAt = Date.parse("2026-10-08T00:00:00.000Z");
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: observedAt });

    const records = [
      {
        type: "message",
        id: "user-1",
        timestamp: observedAt,
        message: { role: "user", content: "Owner preference.", __openclaw: { senderIsOwner: true } },
      },
      {
        type: "message",
        id: "assistant-1",
        timestamp: observedAt,
        message: { role: "assistant", content: "Derived answer." },
      },
      {
        type: "message",
        id: "heartbeat-user",
        timestamp: observedAt,
        message: {
          role: "user",
          content: "Internal poll.",
          provenance: { kind: "internal_system", sourceTool: "heartbeat" },
        },
      },
      {
        type: "message",
        id: "heartbeat-assistant",
        timestamp: observedAt,
        message: { role: "assistant", content: "Excluded heartbeat output." },
      },
      {
        type: "message",
        id: "memory-user",
        timestamp: observedAt,
        message: {
          role: "user",
          content: "Recalled text.",
          provenance: { kind: "internal_system", sourceTool: "memory_get" },
        },
      },
      {
        type: "message",
        id: "memory-assistant",
        timestamp: observedAt,
        message: { role: "assistant", content: "Excluded recalled output." },
      },
      {
        type: "message",
        id: "user-2",
        timestamp: observedAt,
        message: {
          role: "user",
          content:
            "A deliberately longer ordinary message that forces the multipart builder across several tiny test parts without changing the exported words.",
        },
      },
      {
        type: "message",
        id: "assistant-2",
        timestamp: observedAt,
        message: { role: "assistant", content: "Final ordinary answer." },
      },
    ];
    expect(replaceTranscriptEventsSync(scope, records)).toBe(true);

    const whole = await buildSessionEntry(scope.sessionKey, {
      ...scope,
      updatedAtMs: observedAt,
      generatedByDreamingNarrative: false,
      generatedByCronRun: false,
      sessionKind: "interactive",
    });
    expect(whole).not.toBeNull();

    const parts = [];
    for await (const part of buildQmdSqliteSessionParts(scope.sessionKey, {
      ...scope,
      updatedAtMs: observedAt,
      generatedByDreamingNarrative: false,
      generatedByCronRun: false,
      sessionKind: "interactive",
      maxPartBytes: 70,
      rawPageMaxBytes: 180,
      rawPageMaxEvents: 2,
    })) {
      parts.push(part);
    }

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((part) => part.content).join("\n")).toBe(whole?.content);
    expect(parts.flatMap((part) => part.lineMap)).toEqual(whole?.lineMap);
    expect(parts.flatMap((part) => part.messageTimestampsMs)).toEqual(
      whole?.messageTimestampsMs,
    );
    expect(parts.flatMap((part) => part.lineProvenance)).toEqual(whole?.lineProvenance);
  });

  it("fails the multipart export when the transcript generation changes between pages", async () => {
    const scope = {
      agentId: "main",
      sessionId: "multipart-rewrite",
      sessionKey: "agent:main:chat:multipart-rewrite",
      storePath: path.join(tmpDir, "agents", "main", "sessions", "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const first = {
      type: "message",
      id: "first",
      message: { role: "user", content: "first" },
    };
    const second = {
      type: "message",
      id: "second",
      message: { role: "assistant", content: "second" },
    };
    expect(replaceTranscriptEventsSync(scope, [first, second])).toBe(true);

    let rewrote = false;
    const collect = async () => {
      for await (const _part of buildQmdSqliteSessionParts(scope.sessionKey, {
        ...scope,
        generatedByDreamingNarrative: false,
        generatedByCronRun: false,
        maxPartBytes: 1024,
        rawPageMaxBytes: 1024,
        rawPageMaxEvents: 1,
        onTranscriptMessage: () => {
          if (!rewrote) {
            rewrote = true;
            expect(replaceTranscriptEventsSync(scope, [first])).toBe(true);
          }
        },
      })) {
        // Consume the generator so the next raw page observes the rewrite.
      }
    };

    await expect(collect()).rejects.toBeInstanceOf(
      QmdSessionTranscriptGenerationChangedError,
    );
  });
});
