/** Doctor-owned recovery of authored HEARTBEAT.md content from migration-owned cron scratch. */
import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { note } from "../../packages/terminal-core/src/note.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { DEFAULT_HEARTBEAT_FILENAME } from "../agents/workspace.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CRON_JOB_SCRATCH_MAX_BYTES } from "../cron/scratch-contract.js";
import {
  hashCronScratchSource,
  readHeartbeatMonitorScratch,
  readHeartbeatMonitorScratchReadOnly,
  writeCronJobScratch,
} from "../cron/scratch-store.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { formatErrorMessage as errorMessage } from "../infra/errors.js";
import { resolveHeartbeatAgents, resolveHeartbeatIntervalMs } from "../infra/heartbeat-config.js";
import { isPathInside } from "../infra/path-guards.js";
import { readRegularFile } from "../infra/regular-file.js";
import { shortenHomePath } from "../utils.js";
import { analyzeLegacyHeartbeatTasks } from "./heartbeat-task-legacy.js";

const HEARTBEAT_FILE_RESTORATION_CHECK_ID = "core/doctor/heartbeat-file-restoration";
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

type HeartbeatFileRestorationResult = {
  changes: string[];
  warnings: string[];
};

type MigratedScratch = {
  agentId: string;
  filePath: string;
  jobId: string;
  content: string;
  revision: number;
  sourceSha256: string;
};

type ExistingHeartbeatFile = {
  content: string;
  sha256: string;
};

function resolveHeartbeatFileRestorationAgents(cfg: OpenClawConfig) {
  return resolveHeartbeatAgents(cfg).filter(
    (agent) => resolveHeartbeatIntervalMs(cfg, undefined, agent.heartbeat) !== null,
  );
}

async function readExistingHeartbeatFile(
  workspaceDir: string,
): Promise<ExistingHeartbeatFile | undefined> {
  const heartbeatPath = path.join(workspaceDir, DEFAULT_HEARTBEAT_FILENAME);
  let sourceStat;
  try {
    sourceStat = await fs.lstat(heartbeatPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (!sourceStat.isFile() && !sourceStat.isSymbolicLink()) {
    throw new Error("HEARTBEAT.md must be a regular file or contained symlink");
  }
  if (sourceStat.isFile() && sourceStat.nlink > 1) {
    throw new Error("HEARTBEAT.md has multiple hard links; refusing automatic reconciliation");
  }

  const workspaceRealPath = await fs.realpath(workspaceDir);
  const sourceRealPath = await fs.realpath(heartbeatPath);
  if (sourceRealPath !== workspaceRealPath && !isPathInside(workspaceRealPath, sourceRealPath)) {
    throw new Error("HEARTBEAT.md symlink target escapes the agent workspace");
  }
  const file = await readRegularFile({
    filePath: sourceRealPath,
    maxBytes: CRON_JOB_SCRATCH_MAX_BYTES,
  });
  let content: string;
  try {
    content = utf8Decoder.decode(file.buffer);
  } catch {
    throw new Error("HEARTBEAT.md is not valid UTF-8");
  }
  return { content, sha256: hashCronScratchSource(content) };
}

function scratchMatchesFile(scratch: MigratedScratch, file: ExistingHeartbeatFile): boolean {
  if (file.content === scratch.content || file.sha256 === scratch.sourceSha256) {
    return true;
  }
  const legacyTasks = analyzeLegacyHeartbeatTasks(scratch.content);
  return legacyTasks.hasTasksBlock && legacyTasks.strippedContent === file.content;
}

function restorationFinding(params: {
  candidate: MigratedScratch;
  requirement: string;
  message: string;
  severity?: HealthFinding["severity"];
}): HealthFinding {
  return {
    checkId: HEARTBEAT_FILE_RESTORATION_CHECK_ID,
    severity: params.severity ?? "warning",
    message: params.message,
    path: params.candidate.filePath,
    target: params.candidate.agentId,
    requirement: params.requirement,
    fixHint: `Run ${formatCliCommand("openclaw doctor --fix")} to restore authored heartbeat guidance and retire only migration-owned scratch.`,
  };
}

function readMigratedScratchCandidates(params: {
  cfg: OpenClawConfig;
  storePath: string;
  env: NodeJS.ProcessEnv;
  readOnly: boolean;
}): { candidates: MigratedScratch[]; warnings: string[] } {
  const candidates: MigratedScratch[] = [];
  const warnings: string[] = [];
  for (const agent of resolveHeartbeatFileRestorationAgents(params.cfg)) {
    try {
      const monitor = params.readOnly
        ? readHeartbeatMonitorScratchReadOnly(params.storePath, agent.agentId, { env: params.env })
        : readHeartbeatMonitorScratch(params.storePath, agent.agentId, { env: params.env });
      const scratch = monitor?.state.scratch;
      if (!monitor || !scratch?.sourceSha256) {
        continue;
      }
      candidates.push({
        agentId: agent.agentId,
        filePath: path.join(
          resolveAgentWorkspaceDir(params.cfg, agent.agentId),
          DEFAULT_HEARTBEAT_FILENAME,
        ),
        jobId: monitor.jobId,
        content: scratch.content,
        revision: scratch.revision,
        sourceSha256: scratch.sourceSha256,
      });
    } catch (error) {
      warnings.push(
        `Agent "${agent.agentId}" migration-owned heartbeat scratch could not be inspected: ${errorMessage(error)}`,
      );
    }
  }
  return { candidates, warnings };
}

function groupCandidatesByFile(candidates: readonly MigratedScratch[]) {
  const groups = new Map<string, MigratedScratch[]>();
  for (const candidate of candidates) {
    const key = path.resolve(candidate.filePath);
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  return groups;
}

function groupHasConflictingContent(group: readonly MigratedScratch[]): boolean {
  return new Set(group.map((candidate) => candidate.content)).size > 1;
}

/** Reports migration-owned scratch that can safely return to HEARTBEAT.md. */
export async function collectHeartbeatScratchMigrationFindings(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly HealthFinding[]> {
  const storePath = resolveCronJobsStorePathFromConfig(cfg, env);
  const { candidates, warnings } = readMigratedScratchCandidates({
    cfg,
    storePath,
    env,
    readOnly: true,
  });
  const findings: HealthFinding[] = warnings.map((message) => ({
    checkId: HEARTBEAT_FILE_RESTORATION_CHECK_ID,
    severity: "error",
    message,
    path: storePath,
    requirement: "heartbeat-file-restoration-blocked",
    fixHint: `Inspect the cron store, then rerun ${formatCliCommand("openclaw doctor --fix")}.`,
  }));

  for (const group of groupCandidatesByFile(candidates).values()) {
    const representative = group[0]!;
    let existing: ExistingHeartbeatFile | undefined;
    try {
      existing = await readExistingHeartbeatFile(path.dirname(representative.filePath));
    } catch (error) {
      findings.push(
        restorationFinding({
          candidate: representative,
          requirement: "heartbeat-file-restoration-blocked",
          severity: "error",
          message: `HEARTBEAT.md cannot be reconciled: ${errorMessage(error)}`,
        }),
      );
      continue;
    }
    if (!existing && groupHasConflictingContent(group)) {
      findings.push(
        restorationFinding({
          candidate: representative,
          requirement: "heartbeat-file-restoration-conflict",
          severity: "error",
          message:
            "Agents sharing this workspace have different migration-owned heartbeat content; neither copy will be chosen automatically.",
        }),
      );
      continue;
    }
    for (const candidate of group) {
      if (existing && !scratchMatchesFile(candidate, existing)) {
        findings.push(
          restorationFinding({
            candidate,
            requirement: "heartbeat-file-restoration-conflict",
            severity: "error",
            message: `Agent "${candidate.agentId}" has both authored HEARTBEAT.md content and different migration-owned scratch; both are preserved for manual reconciliation.`,
          }),
        );
        continue;
      }
      findings.push(
        restorationFinding({
          candidate,
          requirement: existing
            ? "duplicate-migration-owned-heartbeat-scratch"
            : "migrated-heartbeat-file-missing",
          message: existing
            ? `Agent "${candidate.agentId}" still has a duplicate migration-owned heartbeat scratch copy.`
            : `Agent "${candidate.agentId}" authored heartbeat guidance can be restored to HEARTBEAT.md.`,
        }),
      );
    }
  }
  return findings;
}

function clearMigratedScratch(params: {
  candidate: MigratedScratch;
  storePath: string;
  env: NodeJS.ProcessEnv;
}): boolean {
  const cleared = writeCronJobScratch({
    storePath: params.storePath,
    jobId: params.candidate.jobId,
    content: null,
    expectedRevision: params.candidate.revision,
    options: { env: params.env },
  });
  return cleared.ok;
}

/** Restores authored heartbeat guidance and removes only provenance-marked duplicate scratch. */
export async function maybeMigrateHeartbeatFilesToScratch(params: {
  cfg: OpenClawConfig;
  shouldRepair: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<HeartbeatFileRestorationResult> {
  const env = params.env ?? process.env;
  const storePath = resolveCronJobsStorePathFromConfig(params.cfg, env);
  const changes: string[] = [];
  const warnings: string[] = [];
  const read = readMigratedScratchCandidates({
    cfg: params.cfg,
    storePath,
    env,
    readOnly: !params.shouldRepair,
  });
  warnings.push(...read.warnings);

  for (const group of groupCandidatesByFile(read.candidates).values()) {
    const representative = group[0]!;
    let existing: ExistingHeartbeatFile | undefined;
    try {
      existing = await readExistingHeartbeatFile(path.dirname(representative.filePath));
    } catch (error) {
      warnings.push(
        `${shortenHomePath(representative.filePath)} could not be reconciled: ${errorMessage(error)}`,
      );
      continue;
    }

    if (!existing && groupHasConflictingContent(group)) {
      warnings.push(
        `${shortenHomePath(representative.filePath)} was not restored because agents sharing the workspace have different migration-owned heartbeat content.`,
      );
      continue;
    }
    if (!params.shouldRepair) {
      const action = existing
        ? "will be reconciled with migration-owned heartbeat scratch"
        : "will be restored from migration-owned heartbeat scratch";
      note(
        `${shortenHomePath(representative.filePath)} ${action}.`,
        "Heartbeat restoration preview",
      );
      continue;
    }

    if (!existing) {
      try {
        await fs.writeFile(representative.filePath, representative.content, {
          encoding: "utf8",
          flag: "wx",
        });
        existing = {
          content: representative.content,
          sha256: hashCronScratchSource(representative.content),
        };
        changes.push(
          `Restored ${shortenHomePath(representative.filePath)} from migration-owned heartbeat scratch.`,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          try {
            existing = await readExistingHeartbeatFile(path.dirname(representative.filePath));
          } catch (readError) {
            warnings.push(
              `${shortenHomePath(representative.filePath)} appeared during restoration and could not be reconciled: ${errorMessage(readError)}`,
            );
            continue;
          }
        } else {
          warnings.push(
            `${shortenHomePath(representative.filePath)} could not be restored: ${errorMessage(error)}`,
          );
          continue;
        }
      }
    }

    for (const candidate of group) {
      if (!existing || !scratchMatchesFile(candidate, existing)) {
        warnings.push(
          `Agent "${candidate.agentId}" has different authored HEARTBEAT.md and migration-owned scratch content; both were preserved.`,
        );
        continue;
      }
      if (!clearMigratedScratch({ candidate, storePath, env })) {
        warnings.push(
          `Agent "${candidate.agentId}" heartbeat scratch changed during restoration; the current scratch was preserved.`,
        );
        continue;
      }
      changes.push(
        `Cleared the duplicate migration-owned heartbeat scratch for agent "${candidate.agentId}".`,
      );
    }
  }

  if (changes.length > 0) {
    note(changes.join("\n"), "Doctor changes");
  }
  if (warnings.length > 0) {
    note(warnings.join("\n"), "Doctor warnings");
  }
  return { changes, warnings };
}
