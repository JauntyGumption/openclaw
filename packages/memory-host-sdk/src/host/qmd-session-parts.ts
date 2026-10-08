import path from "node:path";
import { normalizeAgentId } from "./config-utils.js";
import { hashText } from "./hash.js";
import { redactSensitiveText } from "./openclaw-runtime-io.js";
import {
  HEARTBEAT_PROMPT,
  HEARTBEAT_TOKEN,
  hasInterSessionUserProvenance,
  isCronRunSessionKey,
  isDreamingNarrativeSessionStoreKey,
  isExecCompletionEvent,
  isHeartbeatUserMessage,
  isSilentReplyPayloadText,
  readSessionTranscriptRawDelta,
  readTranscriptStatsSync,
  resolveTranscriptSessionKeyBySessionId,
  stripInboundMetadata,
  stripInternalRuntimeContext,
} from "./openclaw-runtime-session.js";
import { classifySessionMessageOrigin } from "./session-provenance.js";
import type { SessionFileEntry } from "./session-files.js";
import type {
  MemoryEntryProvenance,
  MemoryOriginClass,
  MemorySessionKind,
} from "./types.js";

const SESSION_EXPORT_CONTENT_WRAP_CHARS = 800;
const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;
const DIRECT_CRON_PROMPT_RE = /^\[cron:[^\]]+\]\s*/;
const GENERATED_SYSTEM_MESSAGE_RE = /^System(?: \(untrusted\))?: \[[^\]]+\]\s*/;
const DEFAULT_PART_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_RAW_PAGE_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_RAW_PAGE_MAX_EVENTS = 1_000;
const MAX_RAW_PAGE_BYTES = 64 * 1024 * 1024;

export type BuildQmdSqliteSessionPartsOptions = {
  agentId: string;
  sessionId: string;
  storePath: string;
  sessionKey?: string;
  updatedAtMs?: number;
  generatedByDreamingNarrative?: boolean;
  generatedByCronRun?: boolean;
  sessionKind?: MemorySessionKind;
  maxPartBytes?: number;
  rawPageMaxBytes?: number;
  rawPageMaxEvents?: number;
  parseYieldEveryLines?: number;
  onTranscriptMessage?: (message: unknown, observedAt: number) => void;
};

export type QmdSqliteSessionPart = SessionFileEntry & {
  firstSeq?: number;
  lastSeq?: number;
  partIndex: number;
};

export class QmdSessionTranscriptGenerationChangedError extends Error {
  constructor(readonly reason: string) {
    super(`SQLite session transcript generation changed during QMD multipart export: ${reason}`);
    this.name = "QmdSessionTranscriptGenerationChangedError";
  }
}

function normalizeSessionText(value: string): string {
  return value
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function collectRawSessionText(content: unknown): string | null {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; text?: unknown };
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function splitLongSessionLine(
  text: string,
  maxChars: number = SESSION_EXPORT_CONTENT_WRAP_CHARS,
): string[] {
  const normalized = text.trim();
  if (!normalized) {
    return [];
  }
  if (normalized.length <= maxChars) {
    return [normalized];
  }

  const segments: string[] = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    const remaining = normalized.length - cursor;
    if (remaining <= maxChars) {
      segments.push(normalized.slice(cursor).trim());
      break;
    }

    const limit = cursor + maxChars;
    let splitAt = limit;
    for (let index = limit; index > cursor; index -= 1) {
      if (normalized[index] === " ") {
        splitAt = index;
        break;
      }
    }
    if (
      splitAt < normalized.length &&
      splitAt > cursor &&
      isHighSurrogate(normalized.charCodeAt(splitAt - 1)) &&
      isLowSurrogate(normalized.charCodeAt(splitAt))
    ) {
      splitAt -= 1;
    }
    segments.push(normalized.slice(cursor, splitAt).trim());
    cursor = splitAt;
    while (cursor < normalized.length && normalized[cursor] === " ") {
      cursor += 1;
    }
  }

  return segments.filter(Boolean);
}

function renderSessionExportLines(label: string, text: string): string[] {
  return splitLongSessionLine(text).map((segment) => `${label}: ${segment}`);
}

function stripInboundMetadataForUserRole(text: string, role: "user" | "assistant"): string {
  return role === "user" ? stripInboundMetadata(text) : text;
}

function isGeneratedSystemWrapperMessage(text: string, role: "user" | "assistant"): boolean {
  return role === "user" && GENERATED_SYSTEM_MESSAGE_RE.test(text);
}

function isGeneratedCronPromptMessage(text: string, role: "user" | "assistant"): boolean {
  return role === "user" && DIRECT_CRON_PROMPT_RE.test(text);
}

function isGeneratedHeartbeatPromptMessage(text: string, role: "user" | "assistant"): boolean {
  return role === "user" && isHeartbeatUserMessage({ role, content: text }, HEARTBEAT_PROMPT);
}

function sanitizeSessionText(text: string, role: "user" | "assistant"): string | null {
  const strippedInbound = stripInboundMetadataForUserRole(text, role);
  const strippedInternal = stripInternalRuntimeContext(strippedInbound);
  const normalized = normalizeSessionText(strippedInternal);
  if (!normalized) {
    return null;
  }
  if (isGeneratedSystemWrapperMessage(normalized, role)) {
    return null;
  }
  if (isGeneratedCronPromptMessage(normalized, role)) {
    return null;
  }
  if (isGeneratedHeartbeatPromptMessage(normalized, role)) {
    return null;
  }
  if (isSilentReplyPayloadText(normalized)) {
    return null;
  }
  if (role === "assistant" && normalized === HEARTBEAT_TOKEN) {
    return null;
  }
  const withoutSystemEnvelope = normalized.replace(GENERATED_SYSTEM_MESSAGE_RE, "").trim();
  if (isExecCompletionEvent(withoutSystemEnvelope)) {
    return null;
  }
  return normalized;
}

function isRecalledMemoryMessage(message: { provenance?: unknown }): boolean {
  const provenance = message.provenance as { kind?: unknown; sourceTool?: unknown } | undefined;
  return (
    provenance?.kind === "internal_system" &&
    (provenance.sourceTool === "memory_search" || provenance.sourceTool === "memory_get")
  );
}

function parseSessionTimestampMs(
  record: { timestamp?: unknown },
  message: { timestamp?: unknown },
): number {
  const candidates = [message.timestamp, record.timestamp];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value)) {
      const ms = value > 0 && value < 1e11 ? value * 1000 : value;
      if (Number.isFinite(ms) && ms > 0 && ms <= MAX_DATE_TIMESTAMP_MS) {
        return Math.floor(ms);
      }
    }
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return 0;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function sessionPathForSessionIdentity(agentId: string, sessionId: string): string {
  return path.join("sessions", normalizeAgentId(agentId), `${sessionId}.jsonl`).replace(/\\/g, "/");
}

async function yieldIfNeeded(lineIndex: number, everyLines: number): Promise<void> {
  if (lineIndex > 0 && lineIndex % everyLines === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

export async function* buildQmdSqliteSessionParts(
  absPath: string,
  opts: BuildQmdSqliteSessionPartsOptions,
): AsyncGenerator<QmdSqliteSessionPart> {
  const sessionKey =
    opts.sessionKey ??
    resolveTranscriptSessionKeyBySessionId({
      agentId: opts.agentId,
      sessionId: opts.sessionId,
      storePath: opts.storePath,
    });
  if (!sessionKey) {
    throw new Error(`Cannot export SQLite session ${opts.sessionId} without a session key`);
  }

  const generatedByDreamingNarrative =
    opts.generatedByDreamingNarrative ?? isDreamingNarrativeSessionStoreKey(sessionKey);
  const generatedByCronRun = opts.generatedByCronRun ?? isCronRunSessionKey(sessionKey);
  const stats = readTranscriptStatsSync({
    agentId: opts.agentId,
    sessionId: opts.sessionId,
    sessionKey,
    storePath: opts.storePath,
  });
  const mtimeMs = opts.updatedAtMs ?? stats.maxSeq;
  const memoryPath = sessionPathForSessionIdentity(opts.agentId, opts.sessionId);
  const sessionKind = opts.sessionKind ?? "unknown";
  const maxPartBytes = normalizePositiveInteger(opts.maxPartBytes, DEFAULT_PART_MAX_BYTES);
  const rawPageMaxBytes = Math.min(
    MAX_RAW_PAGE_BYTES,
    normalizePositiveInteger(opts.rawPageMaxBytes, DEFAULT_RAW_PAGE_MAX_BYTES),
  );
  const rawPageMaxEvents = Math.min(
    10_000,
    normalizePositiveInteger(opts.rawPageMaxEvents, DEFAULT_RAW_PAGE_MAX_EVENTS),
  );
  const parseYieldEveryLines = normalizePositiveInteger(opts.parseYieldEveryLines, 250);

  const collected: string[] = [];
  const lineMap: number[] = [];
  const messageTimestampsMs: number[] = [];
  const lineProvenance: MemoryEntryProvenance[] = [];
  let partBytes = 0;
  let partIndex = 1;
  let firstSeq: number | undefined;
  let lastSeq: number | undefined;
  let insideHeartbeatTurn = false;
  let insideRecalledMemoryTurn = false;
  let turnOrigin: MemoryOriginClass = "untrusted";
  let visitedRecords = 0;

  const flushPart = (): QmdSqliteSessionPart | null => {
    if (collected.length === 0) {
      return null;
    }
    const content = collected.join("\n");
    const entry: QmdSqliteSessionPart = {
      path: memoryPath,
      absPath,
      mtimeMs,
      size: stats.sizeBytes,
      hash: hashText(
        content +
          "\n" +
          lineMap.join(",") +
          "\n" +
          messageTimestampsMs.join(",") +
          "\n" +
          JSON.stringify(lineProvenance),
      ),
      content,
      lineMap: [...lineMap],
      messageTimestampsMs: [...messageTimestampsMs],
      lineProvenance: [...lineProvenance],
      sessionKind,
      partIndex,
      ...(firstSeq !== undefined ? { firstSeq } : {}),
      ...(lastSeq !== undefined ? { lastSeq } : {}),
    };
    collected.length = 0;
    lineMap.length = 0;
    messageTimestampsMs.length = 0;
    lineProvenance.length = 0;
    partBytes = 0;
    firstSeq = undefined;
    lastSeq = undefined;
    partIndex += 1;
    return entry;
  };

  if (generatedByDreamingNarrative || generatedByCronRun) {
    yield {
      path: memoryPath,
      absPath,
      mtimeMs,
      size: stats.sizeBytes,
      hash: hashText("\n"),
      content: "",
      lineMap: [],
      messageTimestampsMs: [],
      lineProvenance: [],
      sessionKind,
      partIndex: 1,
      ...(generatedByDreamingNarrative ? { generatedByDreamingNarrative: true } : {}),
      ...(generatedByCronRun ? { generatedByCronRun: true } : {}),
    };
    return;
  }

  let cursor: string | undefined;
  let reachedFrontier = stats.maxSeq < 0;
  while (!reachedFrontier) {
    let page = await readSessionTranscriptRawDelta({
      agentId: opts.agentId,
      sessionId: opts.sessionId,
      sessionKey,
      storePath: opts.storePath,
      ...(cursor !== undefined ? { cursor } : {}),
      maxBytes: rawPageMaxBytes,
      maxEvents: rawPageMaxEvents,
    });
    if (page.kind === "missing") {
      return;
    }
    if (page.kind === "reset") {
      throw new QmdSessionTranscriptGenerationChangedError(page.reason);
    }
    if (page.events.length === 0 && page.requiredBytes !== undefined) {
      if (page.requiredBytes > MAX_RAW_PAGE_BYTES) {
        throw new Error(
          `SQLite transcript event requires ${page.requiredBytes} bytes, above the ${MAX_RAW_PAGE_BYTES}-byte lossless QMD page ceiling`,
        );
      }
      page = await readSessionTranscriptRawDelta({
        agentId: opts.agentId,
        sessionId: opts.sessionId,
        sessionKey,
        storePath: opts.storePath,
        ...(cursor !== undefined ? { cursor } : {}),
        maxBytes: Math.max(rawPageMaxBytes, page.requiredBytes),
        maxEvents: 1,
      });
      if (page.kind === "missing") {
        return;
      }
      if (page.kind === "reset") {
        throw new QmdSessionTranscriptGenerationChangedError(page.reason);
      }
    }

    cursor = page.cursor;
    for (const row of page.events) {
      if (row.seq > stats.maxSeq) {
        reachedFrontier = true;
        break;
      }
      visitedRecords += 1;
      await yieldIfNeeded(visitedRecords, parseYieldEveryLines);
      const record = row.event;
      if (
        !record ||
        typeof record !== "object" ||
        (record as { type?: unknown }).type !== "message"
      ) {
        if (row.seq >= stats.maxSeq) {
          reachedFrontier = true;
        }
        continue;
      }
      const message = (record as { message?: unknown }).message as
        | { role?: unknown; content?: unknown; provenance?: unknown; timestamp?: unknown }
        | undefined;
      if (!message || typeof message.role !== "string") {
        if (row.seq >= stats.maxSeq) {
          reachedFrontier = true;
        }
        continue;
      }
      if (message.role !== "user" && message.role !== "assistant") {
        if (row.seq >= stats.maxSeq) {
          reachedFrontier = true;
        }
        continue;
      }

      const timestampMs = parseSessionTimestampMs(
        record as { timestamp?: unknown },
        message,
      );
      opts.onTranscriptMessage?.(message, Math.max(0, Math.floor(timestampMs || mtimeMs)));
      const inputProvenance = message.provenance as
        | { kind?: unknown; sourceTool?: unknown }
        | undefined;
      const isHeartbeatUser =
        message.role === "user" &&
        inputProvenance?.kind === "internal_system" &&
        inputProvenance.sourceTool === "heartbeat";
      if (message.role === "user") {
        insideHeartbeatTurn = isHeartbeatUser;
        insideRecalledMemoryTurn = isRecalledMemoryMessage(message);
        turnOrigin = classifySessionMessageOrigin(message, turnOrigin);
      }
      if (message.role === "user" && hasInterSessionUserProvenance(message)) {
        if (row.seq >= stats.maxSeq) {
          reachedFrontier = true;
        }
        continue;
      }
      if (insideHeartbeatTurn || insideRecalledMemoryTurn) {
        if (row.seq >= stats.maxSeq) {
          reachedFrontier = true;
        }
        continue;
      }

      const rawText = collectRawSessionText(message.content);
      if (rawText === null) {
        if (row.seq >= stats.maxSeq) {
          reachedFrontier = true;
        }
        continue;
      }
      const text = sanitizeSessionText(rawText, message.role);
      if (!text) {
        if (row.seq >= stats.maxSeq) {
          reachedFrontier = true;
        }
        continue;
      }

      const safe = redactSensitiveText(text, { mode: "tools" });
      const label = message.role === "user" ? "User" : "Assistant";
      const renderedLines = renderSessionExportLines(label, safe);
      const memoryProvenance: MemoryEntryProvenance = {
        originClass: classifySessionMessageOrigin(message, turnOrigin),
        sessionKind,
        observedAt: Math.max(0, Math.floor(timestampMs || mtimeMs)),
      };
      for (const line of renderedLines) {
        const separatorBytes = collected.length > 0 ? 1 : 0;
        const lineBytes = Buffer.byteLength(line, "utf8") + separatorBytes;
        if (collected.length > 0 && partBytes + lineBytes > maxPartBytes) {
          const part = flushPart();
          if (part) {
            yield part;
          }
        }
        const nextSeparatorBytes = collected.length > 0 ? 1 : 0;
        collected.push(line);
        lineMap.push(row.seq + 1);
        messageTimestampsMs.push(timestampMs);
        lineProvenance.push(memoryProvenance);
        partBytes += Buffer.byteLength(line, "utf8") + nextSeparatorBytes;
        firstSeq ??= row.seq;
        lastSeq = row.seq;
      }
      if (row.seq >= stats.maxSeq) {
        reachedFrontier = true;
      }
    }

    if (!page.hasMore) {
      break;
    }
  }

  if (cursor !== undefined) {
    const verification = await readSessionTranscriptRawDelta({
      agentId: opts.agentId,
      sessionId: opts.sessionId,
      sessionKey,
      storePath: opts.storePath,
      cursor,
      maxBytes: 1,
      maxEvents: 1,
    });
    if (verification.kind === "reset") {
      throw new QmdSessionTranscriptGenerationChangedError(verification.reason);
    }
  }

  const finalPart = flushPart();
  if (finalPart) {
    yield finalPart;
    return;
  }
  if (partIndex === 1) {
    yield {
      path: memoryPath,
      absPath,
      mtimeMs,
      size: stats.sizeBytes,
      hash: hashText("\n"),
      content: "",
      lineMap: [],
      messageTimestampsMs: [],
      lineProvenance: [],
      sessionKind,
      partIndex: 1,
    };
  }
}
