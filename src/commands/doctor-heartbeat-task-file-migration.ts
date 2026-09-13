/** File-source safety and health checks for legacy heartbeat task migration. */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { DEFAULT_HEARTBEAT_FILENAME } from "../agents/workspace.js";
import { formatCliCommand } from "../cli/command-format.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hashCronScratchSource,
  readHeartbeatMonitorScratchReadOnly,
} from "../cron/scratch-store.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { formatErrorMessage as errorMessage } from "../infra/errors.js";
import { resolveHeartbeatAgents, resolveHeartbeatIntervalMs } from "../infra/heartbeat-config.js";
import { escapeRegExp } from "../shared/regexp.js";
import {
  readExistingHeartbeatFile,
  readHeartbeatFileAtPath,
} from "./doctor-heartbeat-scratch-migration.js";
import { analyzeLegacyHeartbeatTasks, type LegacyHeartbeatTask } from "./heartbeat-task-legacy.js";

const HEARTBEAT_TASK_MIGRATION_CHECK_ID = "core/doctor/heartbeat-task-cron-migration";
const HEARTBEAT_TASK_CLAIM_INFIX = ".doctor-task-migrating-";

export type ValidatedHeartbeatTask = {
  task: LegacyHeartbeatTask;
  intervalMs: number;
  occurrenceIndex: number;
};

export type HeartbeatTaskFile = {
  filePath: string;
  entryKey: string;
  content: string;
  sha256: string;
};

export type HeartbeatTaskFileClaim = {
  retain(): Promise<void>;
  replaceWith(strippedContent: string, archivePath: string): Promise<void>;
};

export function resolveHeartbeatTaskMigrationAgents(cfg: OpenClawConfig) {
  return resolveHeartbeatAgents(cfg).filter(
    (agent) => resolveHeartbeatIntervalMs(cfg, undefined, agent.heartbeat) !== null,
  );
}

export function validateHeartbeatTasks(
  tasks: readonly LegacyHeartbeatTask[],
  declaredEntryCount: number,
): ValidatedHeartbeatTask[] {
  if (tasks.length === 0) {
    throw new Error("tasks: block has no complete name/interval/prompt entries");
  }
  if (tasks.length !== declaredEntryCount) {
    throw new Error("tasks: block contains an incomplete name/interval/prompt entry");
  }
  const occurrenceCounts = new Map<string, number>();
  const validated: ValidatedHeartbeatTask[] = [];
  for (const task of tasks) {
    const intervalMs = parseDurationMs(task.interval, { defaultUnit: "m" });
    if (intervalMs <= 0) {
      throw new Error(`task ${JSON.stringify(task.name)} interval must be greater than zero`);
    }
    const occurrenceIndex = occurrenceCounts.get(task.name) ?? 0;
    occurrenceCounts.set(task.name, occurrenceIndex + 1);
    validated.push({ task, intervalMs, occurrenceIndex });
  }
  return validated;
}

function migrationFinding(params: {
  path: string;
  agentId: string;
  message: string;
  severity?: HealthFinding["severity"];
  requirement: string;
}): HealthFinding {
  return {
    checkId: HEARTBEAT_TASK_MIGRATION_CHECK_ID,
    severity: params.severity ?? "warning",
    message: params.message,
    path: params.path,
    target: params.agentId,
    requirement: params.requirement,
    fixHint: `Run ${formatCliCommand("openclaw doctor --fix")} to convert heartbeat tasks into automations.`,
  };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function findStaleHeartbeatTaskClaim(filePath: string): Promise<string | undefined> {
  const claimPattern = new RegExp(
    `^${escapeRegExp(path.basename(filePath))}${escapeRegExp(HEARTBEAT_TASK_CLAIM_INFIX)}\\d+-[0-9a-f]{12}$`,
  );
  let entries: string[];
  try {
    entries = await fs.readdir(path.dirname(filePath));
  } catch {
    return undefined;
  }
  const claims = entries.filter((entry) => claimPattern.test(entry));
  if (claims.length > 1) {
    throw new Error(
      `multiple interrupted task migration claims exist for ${filePath}; reconcile the stale ${HEARTBEAT_TASK_CLAIM_INFIX}* files manually`,
    );
  }
  const claim = claims[0];
  if (!claim) {
    return undefined;
  }
  const ownerPid = Number(
    claim
      .slice(claim.lastIndexOf(HEARTBEAT_TASK_CLAIM_INFIX) + HEARTBEAT_TASK_CLAIM_INFIX.length)
      .split("-")[0],
  );
  if (Number.isSafeInteger(ownerPid) && ownerPid !== process.pid && isProcessAlive(ownerPid)) {
    throw new Error(
      `a task migration claim for ${filePath} is held by running process ${ownerPid}; wait for that doctor run to finish`,
    );
  }
  return path.join(path.dirname(filePath), claim);
}

async function restoreHeartbeatTaskClaimNoClobber(
  claimPath: string,
  destinationPath: string,
): Promise<void> {
  try {
    await fs.link(claimPath, destinationPath);
    await fs.unlink(claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const conflictPath = `${claimPath}.conflict-${Date.now()}`;
    await fs.rename(claimPath, conflictPath);
    throw new Error(
      `HEARTBEAT.md was recreated during task migration; the claimed original is preserved at ${conflictPath}`,
      { cause: error },
    );
  }
}

export async function resolveHeartbeatEntryKey(
  cfg: OpenClawConfig,
  agentId: string,
): Promise<string> {
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const workspaceRealPath = await fs.realpath(workspaceDir).catch(() => path.resolve(workspaceDir));
  return path.join(workspaceRealPath, DEFAULT_HEARTBEAT_FILENAME);
}

export async function readHeartbeatTaskFile(params: {
  cfg: OpenClawConfig;
  agentId: string;
  recoverClaims: boolean;
}): Promise<HeartbeatTaskFile | undefined> {
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const filePath = path.join(workspaceDir, DEFAULT_HEARTBEAT_FILENAME);
  let canonicalExists = true;
  try {
    await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    canonicalExists = false;
  }
  const staleClaim = await findStaleHeartbeatTaskClaim(filePath);
  if (canonicalExists && staleClaim) {
    throw new Error(
      `both ${filePath} and an interrupted task migration claim at ${staleClaim} exist; reconcile them manually`,
    );
  }
  if (!canonicalExists && staleClaim) {
    if (!params.recoverClaims) {
      throw new Error(
        `an interrupted task migration claim exists at ${staleClaim}; run openclaw doctor --fix to restore it`,
      );
    }
    await restoreHeartbeatTaskClaimNoClobber(staleClaim, filePath);
  }
  const file = await readExistingHeartbeatFile(workspaceDir);
  if (!file) {
    return undefined;
  }
  return {
    filePath,
    entryKey: await resolveHeartbeatEntryKey(params.cfg, params.agentId),
    content: file.content,
    sha256: file.sha256,
  };
}

export async function resolveDisabledHeartbeatEntryKeys(cfg: OpenClawConfig): Promise<Set<string>> {
  const entryKeys = new Set<string>();
  for (const agent of resolveHeartbeatAgents(cfg)) {
    if (resolveHeartbeatIntervalMs(cfg, undefined, agent.heartbeat) !== null) {
      continue;
    }
    entryKeys.add(await resolveHeartbeatEntryKey(cfg, agent.agentId));
  }
  return entryKeys;
}

export async function archiveHeartbeatTaskFile(
  source: HeartbeatTaskFile,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const archivePath = path.join(
    resolveStateDir(env),
    "backups",
    "heartbeat-task-migration",
    `${source.sha256}.md`,
  );
  await fs.mkdir(path.dirname(archivePath), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(archivePath, source.content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const archived = await fs.readFile(archivePath, "utf8");
    if (hashCronScratchSource(archived) !== source.sha256) {
      throw new Error(`heartbeat task migration archive collision at ${archivePath}`, {
        cause: error,
      });
    }
  }
  return archivePath;
}

export async function claimHeartbeatTaskFile(
  source: HeartbeatTaskFile,
): Promise<HeartbeatTaskFileClaim> {
  const sourceStat = await fs.lstat(source.filePath);
  if (!sourceStat.isFile() || sourceStat.nlink > 1) {
    throw new Error("HEARTBEAT.md must be a single-link regular file for automatic task migration");
  }
  const claimPath = `${source.filePath}${HEARTBEAT_TASK_CLAIM_INFIX}${process.pid}-${source.sha256.slice(0, 12)}`;
  await fs.rename(source.filePath, claimPath);
  const workspaceDir = path.dirname(source.filePath);

  const readClaim = async () => {
    const claimed = await readHeartbeatFileAtPath({ workspaceDir, filePath: claimPath });
    if (!claimed) {
      throw new Error("claimed HEARTBEAT.md disappeared during task migration");
    }
    return claimed;
  };
  const restore = async () => {
    await restoreHeartbeatTaskClaimNoClobber(claimPath, source.filePath);
  };
  const verifyClaim = async () => {
    const claimed = await readClaim();
    if (claimed.sha256 !== source.sha256) {
      throw new Error("HEARTBEAT.md changed while its task migration claim was held");
    }
  };
  const preserveClaimAsConflict = async () => {
    const conflictPath = `${claimPath}.conflict-${Date.now()}`;
    await fs.rename(claimPath, conflictPath);
    return conflictPath;
  };

  try {
    await verifyClaim();
  } catch (error) {
    await restore().catch(() => undefined);
    throw error;
  }

  return {
    retain: async () => {
      await verifyClaim();
      await restore();
      const restored = await readExistingHeartbeatFile(workspaceDir);
      if (!restored || restored.sha256 !== source.sha256) {
        throw new Error("restored HEARTBEAT.md changed during task migration");
      }
    },
    replaceWith: async (strippedContent, archivePath) => {
      await verifyClaim();
      const strippedSha256 = hashCronScratchSource(strippedContent);
      try {
        await fs.writeFile(source.filePath, strippedContent, {
          encoding: "utf8",
          flag: "wx",
          mode: sourceStat.mode & 0o777,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          const conflictPath = await preserveClaimAsConflict();
          throw new Error(
            `HEARTBEAT.md was recreated during task migration; the claimed original is preserved at ${conflictPath}`,
            { cause: error },
          );
        }
        await restore().catch(() => undefined);
        throw error;
      }

      const [claimed, replacement] = await Promise.all([
        readClaim(),
        readExistingHeartbeatFile(workspaceDir),
      ]);
      if (!replacement || replacement.sha256 !== strippedSha256) {
        const conflictPath = await preserveClaimAsConflict();
        throw new Error(
          `HEARTBEAT.md changed after its task block was retired; the claimed original is preserved at ${conflictPath}`,
        );
      }
      if (claimed.sha256 !== source.sha256) {
        const strippedConflictPath = `${source.filePath}.doctor-task-stripped-${Date.now()}`;
        await fs.rename(source.filePath, strippedConflictPath);
        await restore();
        throw new Error(
          `HEARTBEAT.md changed while its task migration claim was held; the stripped copy is preserved at ${strippedConflictPath}`,
        );
      }

      try {
        await fs.rename(claimPath, archivePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
          throw error;
        }
        await fs.unlink(claimPath);
      }
    },
  };
}

/** Reports legacy task blocks in canonical HEARTBEAT.md or migrated scratch. */
export async function collectHeartbeatTaskMigrationFindings(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<readonly HealthFinding[]> {
  const storePath = resolveCronJobsStorePathFromConfig(cfg, env);
  const findings: HealthFinding[] = [];
  for (const agent of resolveHeartbeatTaskMigrationAgents(cfg)) {
    const heartbeatPath = path.join(
      resolveAgentWorkspaceDir(cfg, agent.agentId),
      DEFAULT_HEARTBEAT_FILENAME,
    );
    let file: HeartbeatTaskFile | undefined;
    try {
      file = await readHeartbeatTaskFile({ cfg, agentId: agent.agentId, recoverClaims: false });
    } catch (error) {
      findings.push(
        migrationFinding({
          path: heartbeatPath,
          agentId: agent.agentId,
          requirement: "heartbeat-task-migration-blocked",
          severity: "error",
          message: `Agent "${agent.agentId}" HEARTBEAT.md cannot be inspected: ${errorMessage(error)}`,
        }),
      );
      continue;
    }
    let scratchContent: string | undefined;
    const fileDocument = file ? analyzeLegacyHeartbeatTasks(file.content) : undefined;
    if (!fileDocument?.hasTasksBlock) {
      try {
        scratchContent = readHeartbeatMonitorScratchReadOnly(storePath, agent.agentId, {
          env,
        })?.state.scratch?.content;
      } catch (error) {
        findings.push(
          migrationFinding({
            path: storePath,
            agentId: agent.agentId,
            requirement: "heartbeat-task-migration-blocked",
            severity: "error",
            message: `Agent "${agent.agentId}" heartbeat scratch cannot be inspected: ${errorMessage(error)}`,
          }),
        );
        continue;
      }
    }
    const document = fileDocument?.hasTasksBlock
      ? fileDocument
      : scratchContent
        ? analyzeLegacyHeartbeatTasks(scratchContent)
        : undefined;
    if (!document?.hasTasksBlock) {
      continue;
    }
    const sourceIsFile = fileDocument?.hasTasksBlock === true;
    try {
      validateHeartbeatTasks(document.tasks, document.taskEntryCount);
      findings.push(
        migrationFinding({
          path: sourceIsFile ? heartbeatPath : storePath,
          agentId: agent.agentId,
          requirement: sourceIsFile ? "heartbeat-tasks-in-file" : "heartbeat-tasks-in-scratch",
          message: `Agent "${agent.agentId}" has ${document.tasks.length} legacy heartbeat task${document.tasks.length === 1 ? "" : "s"} that must become cron jobs.`,
        }),
      );
    } catch (error) {
      findings.push(
        migrationFinding({
          path: sourceIsFile ? heartbeatPath : storePath,
          agentId: agent.agentId,
          requirement: "heartbeat-task-migration-blocked",
          severity: "error",
          message: `Agent "${agent.agentId}" heartbeat tasks cannot be migrated: ${errorMessage(error)}`,
        }),
      );
    }
  }
  return findings;
}
