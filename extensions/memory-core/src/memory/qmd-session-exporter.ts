import fs from "node:fs/promises";
import path from "node:path";
import {
  createSubsystemLogger,
  isPathInside,
  root,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  buildQmdSqliteSessionParts,
  buildSessionEntry,
  isSessionArchiveArtifactName,
  listSessionTranscriptCorpusEntriesForAgent,
  QmdSessionTranscriptGenerationChangedError,
  statSessionEntrySync,
  type QmdSqliteSessionPart,
  type SessionFileEntry,
  type SessionTranscriptCorpusEntry,
} from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import type { ResolvedQmdConfig } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { PluginStateLeaseContext } from "openclaw/plugin-sdk/plugin-state-runtime";
import { formatSessionTranscriptMemoryHitKey } from "openclaw/plugin-sdk/session-transcript-hit";
import {
  refreshQmdSessionArtifactDocIds,
  replaceQmdSessionArtifactMappings,
  type QmdSessionArtifactMapping,
} from "../qmd-session-artifacts.js";
import { sanitizeQmdCollectionNameSegment } from "./qmd-collection-metadata.js";

const log = createSubsystemLogger("memory");
const QMD_SESSION_MULTIPART_THRESHOLD_BYTES = 8 * 1024 * 1024;
const QMD_SESSION_PART_MAX_BYTES = 4 * 1024 * 1024;
const QMD_SESSION_MULTIPART_MAX_ATTEMPTS = 3;

type QmdSessionExporterConfig = {
  dir: string;
  retentionMs?: number;
  collectionName: string;
};

type BuildSearchPath = (
  collection: string,
  collectionRelativePath: string,
  workspaceRelativePath: string,
  absolutePath: string,
) => string;

type ExportedSessionState = {
  entryHash: string;
  mtimeMs: number;
  revisionToken: string | null;
  target: string;
  targetRevision: string | null;
};

type ExportedMultipartArtifactState = {
  artifactPath: string;
  target: string;
  targetRevision: string | null;
};

type ExportedMultipartSessionState = {
  artifacts: ExportedMultipartArtifactState[];
  mtimeMs: number;
  revisionToken: string | null;
};

type QmdExportRoot = Awaited<ReturnType<typeof root>>;

function buildSessionExportRevision(corpusEntry: SessionTranscriptCorpusEntry): string | null {
  if (!corpusEntry.contentRevision) {
    return null;
  }
  return [
    corpusEntry.contentRevision,
    corpusEntry.sessionKey ?? "",
    corpusEntry.updatedAtMs ?? "",
    corpusEntry.generatedByDreamingNarrative === true ? "dreaming" : "",
    corpusEntry.generatedByCronRun === true ? "cron" : "",
  ].join("\0");
}

function pathStatRevision(stat: {
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
}): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

export class QmdSessionExporter {
  private readonly exportedSessionState = new Map<string, ExportedSessionState>();
  private readonly exportedMultipartSessionState = new Map<string, ExportedMultipartSessionState>();

  constructor(
    readonly config: QmdSessionExporterConfig,
    private readonly agentId: string,
    private readonly workspaceDir: string,
    private readonly indexPath: string,
    private readonly buildSearchPath: BuildSearchPath,
  ) {}

  async exportSessions(lease: PluginStateLeaseContext): Promise<void> {
    const { signal } = lease;
    signal.throwIfAborted();
    const exportDir = this.config.dir;
    lease.assertOwned();
    await fs.mkdir(exportDir, { recursive: true });
    signal.throwIfAborted();
    const exportRoot = await root(exportDir);
    signal.throwIfAborted();
    const corpusEntries = await listSessionTranscriptCorpusEntriesForAgent(this.agentId);
    signal.throwIfAborted();
    const keep = new Set<string>();
    const tracked = new Set<string>();
    const artifactMappings: QmdSessionArtifactMapping[] = [];
    const cutoff = this.config.retentionMs ? Date.now() - this.config.retentionMs : null;

    for (const corpusEntry of corpusEntries) {
      signal.throwIfAborted();
      const sessionFile = corpusEntry.sessionFile;
      const revisionToken = buildSessionExportRevision(corpusEntry);
      const buildOptions = this.buildSessionEntryOptions(corpusEntry);
      const sqliteState =
        corpusEntry.transcriptSource === "sqlite" && corpusEntry.storePath
          ? statSessionEntrySync(sessionFile, buildOptions)
          : null;

      if (
        sqliteState &&
        sqliteState.size >= QMD_SESSION_MULTIPART_THRESHOLD_BYTES &&
        corpusEntry.storePath
      ) {
        const previous = this.exportedMultipartSessionState.get(sessionFile);
        if (
          revisionToken &&
          previous?.revisionToken === revisionToken &&
          (await this.multipartArtifactsIntact(exportRoot, previous))
        ) {
          if (cutoff && previous.mtimeMs < cutoff) {
            continue;
          }
          tracked.add(sessionFile);
          this.exportedSessionState.delete(sessionFile);
          for (const artifact of previous.artifacts) {
            artifactMappings.push(
              this.buildSessionArtifactMapping(
                sessionFile,
                artifact.artifactPath,
                artifact.target,
                corpusEntry,
              ),
            );
            keep.add(artifact.target);
          }
          continue;
        }

        if (cutoff && sqliteState.mtimeMs < cutoff) {
          continue;
        }
        const next = await this.exportMultipartSqliteSession({
          corpusEntry,
          exportRoot,
          lease,
          previous,
          revisionToken,
        });
        if (!next) {
          continue;
        }
        tracked.add(sessionFile);
        this.exportedSessionState.delete(sessionFile);
        this.exportedMultipartSessionState.set(sessionFile, next);
        for (const artifact of next.artifacts) {
          artifactMappings.push(
            this.buildSessionArtifactMapping(
              sessionFile,
              artifact.artifactPath,
              artifact.target,
              corpusEntry,
            ),
          );
          keep.add(artifact.target);
        }
        continue;
      }

      this.exportedMultipartSessionState.delete(sessionFile);
      const targetName = `${this.sessionExportStem(corpusEntry)}.md`;
      const target = path.join(exportDir, targetName);
      const state = this.exportedSessionState.get(sessionFile);
      const targetRevision =
        state?.target === target
          ? await exportRoot
              .stat(targetName)
              .then(pathStatRevision)
              .catch(() => null)
          : null;
      signal.throwIfAborted();
      if (
        revisionToken &&
        state?.revisionToken === revisionToken &&
        state.targetRevision !== null &&
        targetRevision === state.targetRevision
      ) {
        if (cutoff && state.mtimeMs < cutoff) {
          continue;
        }
        tracked.add(sessionFile);
        artifactMappings.push(
          this.buildSessionArtifactMapping(sessionFile, targetName, target, corpusEntry),
        );
        keep.add(target);
        continue;
      }

      const entry = await buildSessionEntry(sessionFile, buildOptions);
      if (!entry || (cutoff && entry.mtimeMs < cutoff)) {
        continue;
      }
      tracked.add(sessionFile);
      artifactMappings.push(
        this.buildSessionArtifactMapping(sessionFile, targetName, target, corpusEntry),
      );
      const needsWrite =
        !state ||
        state.target !== target ||
        state.entryHash !== entry.hash ||
        state.targetRevision === null ||
        targetRevision !== state.targetRevision;
      let nextTargetRevision = targetRevision;
      if (needsWrite) {
        lease.assertOwned();
        await exportRoot.write(targetName, renderSessionMarkdown(entry), { encoding: "utf-8" });
        signal.throwIfAborted();
        nextTargetRevision = await exportRoot
          .stat(targetName)
          .then(pathStatRevision)
          .catch(() => null);
        signal.throwIfAborted();
      }
      lease.assertOwned();
      this.exportedSessionState.set(sessionFile, {
        entryHash: entry.hash,
        mtimeMs: entry.mtimeMs,
        revisionToken,
        target,
        targetRevision: nextTargetRevision,
      });
      keep.add(target);
    }

    const exported = await exportRoot.list(".").catch((error: unknown) => {
      signal.throwIfAborted();
      log.debug(`failed to list qmd session exports: ${String(error)}`);
      return [];
    });
    signal.throwIfAborted();
    for (const name of exported) {
      if (name.startsWith(".") && name.includes(".md.stage-")) {
        lease.assertOwned();
        await exportRoot.remove(name).catch(() => undefined);
        continue;
      }
      if (!name.endsWith(".md")) {
        continue;
      }
      const full = path.join(exportDir, name);
      if (!keep.has(full)) {
        lease.assertOwned();
        await exportRoot.remove(name).catch((error: unknown) => {
          signal.throwIfAborted();
          log.debug(`failed to remove stale qmd session export ${name}: ${String(error)}`);
        });
        signal.throwIfAborted();
      }
    }

    for (const [sessionFile, state] of this.exportedSessionState) {
      if (!tracked.has(sessionFile) || !isPathInside(exportDir, state.target)) {
        lease.assertOwned();
        this.exportedSessionState.delete(sessionFile);
      }
    }
    for (const [sessionFile, state] of this.exportedMultipartSessionState) {
      if (
        !tracked.has(sessionFile) ||
        state.artifacts.some((artifact) => !isPathInside(exportDir, artifact.target))
      ) {
        lease.assertOwned();
        this.exportedMultipartSessionState.delete(sessionFile);
      }
    }

    signal.throwIfAborted();
    lease.assertOwned();
    replaceQmdSessionArtifactMappings({
      collection: this.config.collectionName,
      indexPath: this.indexPath,
      mappings: artifactMappings,
    });
  }

  refreshArtifactDocIds(lease: PluginStateLeaseContext): void {
    const { signal } = lease;
    signal.throwIfAborted();
    lease.assertOwned();
    try {
      refreshQmdSessionArtifactDocIds({
        assertOwned: () => lease.assertOwned(),
        collection: this.config.collectionName,
        indexPath: this.indexPath,
      });
    } catch (err) {
      signal.throwIfAborted();
      log.warn(`failed to refresh qmd session artifact identity docids: ${String(err)}`);
    }
  }

  private buildSessionEntryOptions(corpusEntry: SessionTranscriptCorpusEntry) {
    return {
      generatedByDreamingNarrative: corpusEntry.generatedByDreamingNarrative === true,
      generatedByCronRun: corpusEntry.generatedByCronRun === true,
      ...(corpusEntry.transcriptSource === "sqlite" && corpusEntry.storePath
        ? {
            agentId: corpusEntry.agentId,
            sessionId: corpusEntry.sessionId,
            storePath: corpusEntry.storePath,
          }
        : {}),
      ...(corpusEntry.sessionKey ? { sessionKey: corpusEntry.sessionKey } : {}),
      ...(corpusEntry.updatedAtMs !== undefined ? { updatedAtMs: corpusEntry.updatedAtMs } : {}),
      ...(corpusEntry.sessionKind ? { sessionKind: corpusEntry.sessionKind } : {}),
    };
  }

  private async multipartArtifactsIntact(
    exportRoot: QmdExportRoot,
    state: ExportedMultipartSessionState,
  ): Promise<boolean> {
    for (const artifact of state.artifacts) {
      if (artifact.targetRevision === null) {
        return false;
      }
      const revision = await exportRoot
        .stat(artifact.artifactPath)
        .then(pathStatRevision)
        .catch(() => null);
      if (revision !== artifact.targetRevision) {
        return false;
      }
    }
    return true;
  }

  private async exportMultipartSqliteSession(params: {
    corpusEntry: SessionTranscriptCorpusEntry;
    exportRoot: QmdExportRoot;
    lease: PluginStateLeaseContext;
    previous: ExportedMultipartSessionState | undefined;
    revisionToken: string | null;
  }): Promise<ExportedMultipartSessionState | null> {
    const { corpusEntry, exportRoot, lease, previous, revisionToken } = params;
    if (corpusEntry.transcriptSource !== "sqlite" || !corpusEntry.storePath) {
      return null;
    }
    const sessionFile = corpusEntry.sessionFile;
    const exportDir = this.config.dir;
    const previousByPath = new Map(
      previous?.artifacts.map((artifact) => [artifact.artifactPath, artifact]) ?? [],
    );

    for (let attempt = 0; attempt < QMD_SESSION_MULTIPART_MAX_ATTEMPTS; attempt += 1) {
      const staged: Array<{
        artifactPath: string;
        stageName: string;
        target: string;
      }> = [];
      const installedArtifactPaths: string[] = [];
      const artifacts: ExportedMultipartArtifactState[] = [];
      let mtimeMs = corpusEntry.updatedAtMs ?? 0;
      try {
        for await (const part of buildQmdSqliteSessionParts(sessionFile, {
          agentId: corpusEntry.agentId,
          sessionId: corpusEntry.sessionId,
          storePath: corpusEntry.storePath,
          ...(corpusEntry.sessionKey ? { sessionKey: corpusEntry.sessionKey } : {}),
          ...(corpusEntry.updatedAtMs !== undefined
            ? { updatedAtMs: corpusEntry.updatedAtMs }
            : {}),
          generatedByDreamingNarrative: corpusEntry.generatedByDreamingNarrative === true,
          generatedByCronRun: corpusEntry.generatedByCronRun === true,
          ...(corpusEntry.sessionKind ? { sessionKind: corpusEntry.sessionKind } : {}),
          maxPartBytes: QMD_SESSION_PART_MAX_BYTES,
        })) {
          lease.signal.throwIfAborted();
          mtimeMs = part.mtimeMs;
          const artifactPath = this.multipartArtifactName(corpusEntry, part);
          const target = path.join(exportDir, artifactPath);
          const prior = previousByPath.get(artifactPath);
          const currentRevision = await exportRoot
            .stat(artifactPath)
            .then(pathStatRevision)
            .catch(() => null);
          if (prior && prior.targetRevision !== null && currentRevision === prior.targetRevision) {
            artifacts.push({
              artifactPath,
              target,
              targetRevision: prior.targetRevision,
            });
            continue;
          }

          const rendered = renderSessionMarkdown(part);
          if (!prior && currentRevision !== null) {
            const unchanged = await fs
              .readFile(target, "utf8")
              .then((existing) => existing === rendered)
              .catch(() => false);
            if (unchanged) {
              artifacts.push({
                artifactPath,
                target,
                targetRevision: currentRevision,
              });
              continue;
            }
          }

          const stageName = `.${artifactPath}.stage-${attempt + 1}`;
          lease.assertOwned();
          await exportRoot.write(stageName, rendered, { encoding: "utf-8" });
          staged.push({ artifactPath, stageName, target });
          artifacts.push({ artifactPath, target, targetRevision: null });
        }

        for (const stagedArtifact of staged) {
          lease.signal.throwIfAborted();
          lease.assertOwned();
          await exportRoot.remove(stagedArtifact.artifactPath).catch(() => undefined);
          await fs.rename(path.join(exportDir, stagedArtifact.stageName), stagedArtifact.target);
          installedArtifactPaths.push(stagedArtifact.artifactPath);
        }

        const finalized: ExportedMultipartArtifactState[] = [];
        for (const artifact of artifacts) {
          lease.signal.throwIfAborted();
          const targetRevision = await exportRoot
            .stat(artifact.artifactPath)
            .then(pathStatRevision)
            .catch(() => null);
          finalized.push({ ...artifact, targetRevision });
        }
        return {
          artifacts: finalized,
          mtimeMs,
          revisionToken,
        };
      } catch (err) {
        for (const stagedArtifact of staged) {
          await exportRoot.remove(stagedArtifact.stageName).catch(() => undefined);
        }
        for (const artifactPath of installedArtifactPaths) {
          await exportRoot.remove(artifactPath).catch(() => undefined);
        }
        if (
          err instanceof QmdSessionTranscriptGenerationChangedError &&
          attempt + 1 < QMD_SESSION_MULTIPART_MAX_ATTEMPTS
        ) {
          log.debug(
            `qmd session export generation changed for ${corpusEntry.sessionId}; retrying multipart export`,
          );
          continue;
        }
        throw err;
      }
    }
    return null;
  }

  private multipartArtifactName(
    corpusEntry: SessionTranscriptCorpusEntry,
    part: QmdSqliteSessionPart,
  ): string {
    const partNumber = String(part.partIndex).padStart(6, "0");
    const contentKey = part.hash.slice(0, 16);
    return `${this.sessionExportStem(corpusEntry)}.part-${partNumber}.${contentKey}.md`;
  }

  private buildSessionArtifactMapping(
    sessionFile: string,
    artifactPath: string,
    target: string,
    corpusEntry: SessionTranscriptCorpusEntry,
  ): QmdSessionArtifactMapping {
    return {
      agentId: corpusEntry.agentId,
      archived: isSessionArchiveArtifactName(path.basename(sessionFile)),
      artifactPath,
      collection: this.config.collectionName,
      memoryKey: formatSessionTranscriptMemoryHitKey({
        agentId: corpusEntry.agentId,
        sessionId: corpusEntry.sessionId,
      }),
      searchPath: this.buildSearchPath(
        this.config.collectionName,
        artifactPath,
        path.relative(this.workspaceDir, target),
        target,
      ),
      sessionId: corpusEntry.sessionId,
    };
  }

  private sessionExportStem(corpusEntry: SessionTranscriptCorpusEntry): string {
    return corpusEntry.transcriptSource === "sqlite"
      ? corpusEntry.sessionId
      : path.basename(corpusEntry.sessionFile, ".jsonl");
  }
}

export function resolveQmdSessionExporterConfig(params: {
  qmd: ResolvedQmdConfig;
  agentId: string;
  qmdDir: string;
}): QmdSessionExporterConfig | null {
  if (!params.qmd.sessions.enabled) {
    return null;
  }
  return {
    dir: params.qmd.sessions.exportDir ?? path.join(params.qmdDir, "sessions"),
    ...(params.qmd.sessions.retentionDays
      ? { retentionMs: params.qmd.sessions.retentionDays * 24 * 60 * 60 * 1000 }
      : {}),
    collectionName: pickSessionCollectionName(params.qmd, params.agentId),
  };
}

function pickSessionCollectionName(qmd: ResolvedQmdConfig, agentId: string): string {
  const existing = new Set(qmd.collections.map((collection) => collection.name));
  const base = `sessions-${sanitizeQmdCollectionNameSegment(agentId)}`;
  if (!existing.has(base)) {
    return base;
  }
  let counter = 2;
  let candidate = `${base}-${counter}`;
  while (existing.has(candidate)) {
    counter += 1;
    candidate = `${base}-${counter}`;
  }
  return candidate;
}

function renderSessionMarkdown(entry: SessionFileEntry): string {
  const header = `# Session ${path.basename(entry.path, path.extname(entry.path))}`;
  const body = entry.content?.trim().length ? entry.content.trim() : "(empty)";
  return `${header}\n\n${body}\n`;
}
