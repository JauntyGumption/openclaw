import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadTranscriptEventRowsPageSync,
  replaceSessionEntry,
  replaceTranscriptEventsSync,
} from "./session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  for (const dir of tempDirs.splice(0)) {
    fsSync.rmSync(dir, { recursive: true, force: true });
  }
});

describe("bounded SQLite transcript row paging", () => {
  it("pages forward by raw seq without reading past the fixed frontier", async () => {
    const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "session-row-page-"));
    tempDirs.push(root);
    const scope = {
      agentId: "main",
      sessionId: "paged",
      sessionKey: "agent:main:paged",
      storePath: path.join(root, "sessions.json"),
    };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const events = Array.from({ length: 5 }, (_value, index) => ({
      type: "message",
      id: `message-${index}`,
      message: { role: index % 2 === 0 ? "user" : "assistant", content: `message ${index}` },
    }));
    expect(replaceTranscriptEventsSync(scope, events)).toBe(true);

    const first = loadTranscriptEventRowsPageSync(scope, {
      afterSeq: -1,
      throughSeq: 3,
      maxEvents: 2,
      maxBytes: 1024 * 1024,
    });
    expect(first.rows.map((row) => row.seq)).toEqual([0, 1]);

    const second = loadTranscriptEventRowsPageSync(scope, {
      afterSeq: first.rows.at(-1)!.seq,
      throughSeq: 3,
      maxEvents: 2,
      maxBytes: 1024 * 1024,
    });
    expect(second.rows.map((row) => row.seq)).toEqual([2, 3]);

    const done = loadTranscriptEventRowsPageSync(scope, {
      afterSeq: second.rows.at(-1)!.seq,
      throughSeq: 3,
      maxEvents: 2,
      maxBytes: 1024 * 1024,
    });
    expect(done).toEqual({ rows: [], serializedBytes: 0 });
  });

  it("admits one oversized row so a byte-bounded reader always makes progress", async () => {
    const root = fsSync.mkdtempSync(path.join(os.tmpdir(), "session-row-page-"));
    tempDirs.push(root);
    const scope = {
      agentId: "main",
      sessionId: "oversized",
      sessionKey: "agent:main:oversized",
      storePath: path.join(root, "sessions.json"),
    };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    expect(
      replaceTranscriptEventsSync(scope, [
        {
          type: "message",
          id: "large",
          message: { role: "user", content: "x".repeat(4096) },
        },
        {
          type: "message",
          id: "next",
          message: { role: "assistant", content: "next" },
        },
      ]),
    ).toBe(true);

    const page = loadTranscriptEventRowsPageSync(scope, {
      afterSeq: -1,
      maxEvents: 10,
      maxBytes: 1,
    });
    expect(page.rows.map((row) => row.seq)).toEqual([0]);
    expect(page.serializedBytes).toBeGreaterThan(1);
  });
});
