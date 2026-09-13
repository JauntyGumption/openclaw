/** Doctor-owned migration from legacy heartbeat `tasks:` blocks into cron jobs. */

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { note } from "../../packages/terminal-core/src/note.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { heartbeatTaskDeclarationKey, isHeartbeatTaskCronJob } from "../cron/heartbeat-task.js";
import { cronSchedulingInputsEqual } from "../cron/schedule-identity.js";
import { readHeartbeatMonitorScratch } from "../cron/scratch-store.js";
import { computeJobNextRunAtMs, hasScheduledNextRunAtMs } from "../cron/service/jobs-scheduling.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { cronStoreKey } from "../cron/store/key.js";
import {
  assertCronStoreCanPersist,
  loadedCronStoreFromRows,
  loadCronRows,
  upsertCronJobRow,
} from "../cron/store/row-codec.js";
import { getCronStoreKysely } from "../cron/store/schema.js";
import type { CronJob } from "../cron/types.js";
import { formatErrorMessage as errorMessage } from "../infra/errors.js";
import { resolveHeartbeatAgents } from "../infra/heartbeat-config.js";
import { resolveHeartbeatSession } from "../infra/heartbeat-runner-session.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { shortenHomePath } from "../utils.js";
import {
  archiveHeartbeatTaskFile,
  claimHeartbeatTaskFile,
  readHeartbeatTaskFile,
  resolveDisabledHeartbeatEntryKeys,
  resolveHeartbeatEntryKey,
  resolveHeartbeatTaskMigrationAgents,
  validateHeartbeatTasks,
  type HeartbeatTaskFile,
  type HeartbeatTaskFileClaim,
  type ValidatedHeartbeatTask,
} from "./doctor-heartbeat-task-file-migration.js";
import { analyzeLegacyHeartbeatTasks, type LegacyHeartbeatTask } from "./heartbeat-task-legacy.js";

export { collectHeartbeatTaskMigrationFindings } from "./doctor-heartbeat-task-file-migration.js";

type HeartbeatTaskMigrationResult = { changes: string[]; warnings: string[] };

function taskJobInput(params: {
  agentId: string;
  task: LegacyHeartbeatTask;
  occurrenceIndex: number;
  intervalMs: number;
  lastRunAtMs?: number;
  existing?: CronJob;
  nowMs: number;
}) {
  const existingAnchor =
    params.existing?.schedule.kind === "every" &&
    params.existing.schedule.everyMs === params.intervalMs
      ? params.existing.schedule.anchorMs
      : undefined;
  const nextDueMs =
    params.lastRunAtMs === undefined || params.lastRunAtMs + params.intervalMs <= params.nowMs
      ? params.nowMs + 1
      : params.lastRunAtMs + params.intervalMs;
  return {
    declarationKey: heartbeatTaskDeclarationKey(
      params.agentId,
      params.task.name,
      params.occurrenceIndex,
    ),
    displayName: truncateUtf16Safe(`Heartbeat task: ${params.task.name}`, 200),
    name: params.task.name,
    description: "Migrated from legacy heartbeat tasks by openclaw doctor.",
    agentId: params.agentId,
    enabled: true,
    schedule: {
      kind: "every" as const,
      everyMs: params.intervalMs,
      anchorMs: existingAnchor ?? nextDueMs,
    },
    payload: { kind: "systemEvent" as const, text: params.task.prompt },
    sessionTarget: "main" as const,
    wakeMode: "next-heartbeat" as const,
    ...(params.lastRunAtMs === undefined ? {} : { state: { lastRunAtMs: params.lastRunAtMs } }),
  };
}

type TaskJobPlan = {
  declarationKey: string;
  previous?: CronJob;
  job: CronJob;
  sortOrder: number;
};

type AgentTaskMigrationPlan = {
  jobs: TaskJobPlan[];
  scratch?: {
    monitorJobId: string;
    revision: number;
    sourceSha256?: string;
    strippedContent: string;
  };
};

type CronPlanningSnapshot = {
  jobs: CronJob[];
  sortOrderByJobId: Map<string, number>;
  nextSortOrder: number;
};

type MigrationCommitResult =
  | { ok: true; currentRevision: number }
  | { ok: false; reason: "job-conflict" | "revision-conflict" };

function taskDeclarativeFields(job: CronJob) {
  return {
    schedule: job.schedule,
    pacing: job.pacing,
    trigger: job.trigger,
    payload: job.payload,
    delivery: job.delivery,
    displayName: job.displayName,
    enabled: job.enabled,
  };
}

function convergeTaskJob(params: {
  agentId: string;
  task: LegacyHeartbeatTask;
  occurrenceIndex: number;
  intervalMs: number;
  lastRunAtMs?: number;
  existing?: CronJob;
  nowMs: number;
}): CronJob {
  const input = taskJobInput(params);
  if (!params.existing) {
    const { state, ...fields } = input;
    const job: CronJob = {
      id: randomUUID(),
      ...fields,
      createdAtMs: params.nowMs,
      updatedAtMs: params.nowMs,
      state: { ...state },
    };
    job.state.nextRunAtMs = computeJobNextRunAtMs(job, params.nowMs);
    return job;
  }

  const previous = params.existing;
  const job = structuredClone(previous);
  job.displayName = input.displayName;
  job.schedule = structuredClone(input.schedule);
  job.payload = structuredClone(input.payload);
  job.enabled = true;
  delete job.pacing;
  delete job.trigger;
  delete job.delivery;
  if (isDeepStrictEqual(taskDeclarativeFields(previous), taskDeclarativeFields(job))) {
    return job;
  }

  job.updatedAtMs = params.nowMs;
  if (!cronSchedulingInputsEqual(previous, job)) {
    job.state.startupCatchupAtMs = undefined;
    job.state.pacedNextRunAtMs = undefined;
    job.state.forcePreservedNextRunAtMs = undefined;
    job.state.nextRunAtMs = computeJobNextRunAtMs(job, params.nowMs);
  } else if (!hasScheduledNextRunAtMs(job.state.nextRunAtMs)) {
    job.state.nextRunAtMs = computeJobNextRunAtMs(job, params.nowMs);
  }
  return job;
}

async function loadCronPlanningSnapshot(
  storePath: string,
  env: NodeJS.ProcessEnv,
): Promise<CronPlanningSnapshot> {
  const rows = loadCronRows(openOpenClawStateDatabase({ env }).db, cronStoreKey(storePath));
  const sortOrderByJobId = new Map(rows.map((row) => [row.job_id, row.sort_order] as const));
  return {
    jobs: loadedCronStoreFromRows(rows).store.jobs,
    sortOrderByJobId,
    nextSortOrder: rows.reduce((max, row) => Math.max(max, row.sort_order + 1), 0),
  };
}

function reserveSortOrder(snapshot: CronPlanningSnapshot, existing?: CronJob): number {
  const persisted = existing ? snapshot.sortOrderByJobId.get(existing.id) : undefined;
  if (persisted !== undefined) {
    return persisted;
  }
  const sortOrder = snapshot.nextSortOrder;
  snapshot.nextSortOrder += 1;
  return sortOrder;
}

function readScratchRevision(db: DatabaseSync, storeKey: string, jobId: string): number {
  return (
    executeSqliteQuerySync(
      db,
      getCronStoreKysely(db)
        .selectFrom("cron_job_scratch")
        .select("revision")
        .where("store_key", "=", storeKey)
        .where("job_id", "=", jobId),
    ).rows[0]?.revision ?? 0
  );
}

function commitAgentTaskMigration(params: {
  storePath: string;
  env: NodeJS.ProcessEnv;
  nowMs: number;
  plan: AgentTaskMigrationPlan;
}): MigrationCommitResult {
  const storeKey = cronStoreKey(params.storePath);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      if (
        params.plan.scratch &&
        readScratchRevision(db, storeKey, params.plan.scratch.monitorJobId) !==
          params.plan.scratch.revision
      ) {
        return { ok: false, reason: "revision-conflict" } as const;
      }

      const rows = loadCronRows(db, storeKey);
      const jobsById = new Map(
        loadedCronStoreFromRows(rows).store.jobs.map((job) => [job.id, job] as const),
      );
      for (const jobPlan of params.plan.jobs) {
        const matchingRows = rows.filter((row) => row.declaration_key === jobPlan.declarationKey);
        if (jobPlan.previous) {
          const current = jobsById.get(jobPlan.previous.id);
          if (
            matchingRows.length !== 1 ||
            !current ||
            !isDeepStrictEqual(current, jobPlan.previous)
          ) {
            return { ok: false, reason: "job-conflict" } as const;
          }
        } else if (matchingRows.length > 0 || rows.some((row) => row.job_id === jobPlan.job.id)) {
          return { ok: false, reason: "job-conflict" } as const;
        }
      }

      for (const jobPlan of params.plan.jobs) {
        if (!jobPlan.previous || !isDeepStrictEqual(jobPlan.previous, jobPlan.job)) {
          upsertCronJobRow(db, storeKey, jobPlan.job, jobPlan.sortOrder);
        }
      }

      if (params.plan.scratch) {
        const updated = executeSqliteQuerySync(
          db,
          getCronStoreKysely(db)
            .updateTable("cron_job_scratch")
            .set({
              content: params.plan.scratch.strippedContent,
              revision: params.plan.scratch.revision + 1,
              source_sha256: params.plan.scratch.sourceSha256 ?? null,
              updated_at_ms: params.nowMs,
            })
            .where("store_key", "=", storeKey)
            .where("job_id", "=", params.plan.scratch.monitorJobId)
            .where("revision", "=", params.plan.scratch.revision),
        );
        if (updated.numAffectedRows !== 1n) {
          throw new Error("scratch revision changed inside task migration transaction");
        }
      }
      // Like cadence materialization, doctor only commits durable rows. A live
      // gateway reloads the cron store through its normal reload path and arms
      // these persisted nextRunAtMs values; doctor never owns its timer.
      return {
        ok: true,
        currentRevision: params.plan.scratch ? params.plan.scratch.revision + 1 : 0,
      } as const;
    },
    { env: params.env },
    { operationLabel: "doctor.heartbeat-task-migration" },
  );
}

async function clearLegacyTaskTimestamps(params: {
  storePath: string;
  sessionKey: string;
  env: NodeJS.ProcessEnv;
  tasks: readonly LegacyHeartbeatTask[];
}): Promise<void> {
  await patchSessionEntryCore(
    { storePath: params.storePath, sessionKey: params.sessionKey, env: params.env },
    (entry) => {
      const remaining = { ...entry.heartbeatTaskState };
      let changed = false;
      for (const task of params.tasks) {
        if (Object.hasOwn(remaining, task.name)) {
          delete remaining[task.name];
          changed = true;
        }
      }
      if (!changed) {
        return null;
      }
      return {
        heartbeatTaskState: Object.keys(remaining).length > 0 ? remaining : undefined,
      };
    },
    { preserveActivity: true },
  );
}

type HeartbeatTaskMigrationCandidate = {
  agent: ReturnType<typeof resolveHeartbeatAgents>[number];
  document: ReturnType<typeof analyzeLegacyHeartbeatTasks>;
  source:
    | {
        kind: "file";
        filePath: string;
        entryKey: string;
        content: string;
        sha256: string;
      }
    | {
        kind: "scratch";
        monitor: NonNullable<ReturnType<typeof readHeartbeatMonitorScratch>>;
        revision: number;
      };
  validatedTasks: ValidatedHeartbeatTask[];
};

/** Converts valid legacy tasks and retires their source block after cron owns scheduling. */
export async function maybeMigrateHeartbeatTasksToCron(params: {
  cfg: OpenClawConfig;
  shouldRepair: boolean;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
}): Promise<HeartbeatTaskMigrationResult> {
  const env = params.env ?? process.env;
  const nowMs = params.nowMs ?? Date.now();
  const storePath = resolveCronJobsStorePathFromConfig(params.cfg, env);
  const changes: string[] = [];
  const warnings: string[] = [];
  const candidates: HeartbeatTaskMigrationCandidate[] = [];
  const migrationAgents = resolveHeartbeatTaskMigrationAgents(params.cfg);
  const scratchReads = new Map<
    string,
    | { monitor: ReturnType<typeof readHeartbeatMonitorScratch>; error?: never }
    | { monitor?: never; error: unknown }
  >();
  for (const agent of migrationAgents) {
    try {
      const currentMonitor = readHeartbeatMonitorScratch(storePath, agent.agentId, { env });
      scratchReads.set(agent.agentId, {
        monitor: currentMonitor ? structuredClone(currentMonitor) : undefined,
      });
    } catch (error) {
      scratchReads.set(agent.agentId, { error });
    }
  }
  const enabledOwnersByEntryKey = new Map<string, Set<string>>();
  for (const agent of migrationAgents) {
    const entryKey = await resolveHeartbeatEntryKey(params.cfg, agent.agentId);
    const owners = enabledOwnersByEntryKey.get(entryKey) ?? new Set<string>();
    owners.add(agent.agentId);
    enabledOwnersByEntryKey.set(entryKey, owners);
  }
  for (const agent of migrationAgents) {
    const scratchRead = scratchReads.get(agent.agentId);
    let file: HeartbeatTaskFile | undefined;
    try {
      file = await readHeartbeatTaskFile({
        cfg: params.cfg,
        agentId: agent.agentId,
        recoverClaims: params.shouldRepair,
      });
    } catch (error) {
      warnings.push(
        `Agent "${agent.agentId}" HEARTBEAT.md could not be inspected: ${errorMessage(error)}.`,
      );
      continue;
    }
    let document = file ? analyzeLegacyHeartbeatTasks(file.content) : undefined;
    let source: HeartbeatTaskMigrationCandidate["source"] | undefined;
    if (file && document?.hasTasksBlock) {
      source = {
        kind: "file",
        filePath: file.filePath,
        entryKey: file.entryKey,
        content: file.content,
        sha256: file.sha256,
      };
    } else {
      if (scratchRead?.error !== undefined) {
        warnings.push(
          `Agent "${agent.agentId}" heartbeat scratch could not be inspected: ${errorMessage(scratchRead.error)}.`,
        );
        continue;
      }
      const monitor = scratchRead?.monitor;
      const scratch = monitor?.state.scratch;
      if (!monitor || !scratch) {
        continue;
      }
      document = analyzeLegacyHeartbeatTasks(scratch.content);
      if (document.hasTasksBlock) {
        source = { kind: "scratch", monitor, revision: scratch.revision };
      }
    }
    if (!document?.hasTasksBlock || !source) {
      continue;
    }
    const tasks = document.tasks;
    let validatedTasks: ValidatedHeartbeatTask[];
    try {
      validatedTasks = validateHeartbeatTasks(tasks, document.taskEntryCount);
    } catch (error) {
      warnings.push(
        `Agent "${agent.agentId}" heartbeat tasks were not migrated: ${errorMessage(error)}.`,
      );
      continue;
    }
    if (!params.shouldRepair) {
      const sourcePath = source.kind === "file" ? source.filePath : storePath;
      note(
        `${tasks.length} task${tasks.length === 1 ? "" : "s"} in ${shortenHomePath(sourcePath)} will become independently scheduled cron jobs for agent "${agent.agentId}".`,
        "Heartbeat task migration preview",
      );
      continue;
    }
    candidates.push({
      agent,
      document,
      source,
      validatedTasks,
    });
  }

  if (!params.shouldRepair || candidates.length === 0) {
    if (warnings.length > 0) {
      note(warnings.join("\n"), "Doctor warnings");
    }
    return { changes, warnings };
  }

  let snapshot: CronPlanningSnapshot;
  try {
    // The scratch revisions above are pinned before this async planning read.
    // Concurrent doctors can therefore plan R together and serialize at commit.
    snapshot = await loadCronPlanningSnapshot(storePath, env);
  } catch (error) {
    const warning = `Could not inspect cron jobs for heartbeat task migration: ${errorMessage(error)}`;
    note(warning, "Doctor warnings");
    return { changes, warnings: [...warnings, warning] };
  }

  const commitCandidate = async (candidate: HeartbeatTaskMigrationCandidate): Promise<boolean> => {
    const { agent, document, source, validatedTasks } = candidate;
    const sourceDescription = source.kind === "file" ? "HEARTBEAT.md" : "heartbeat scratch";
    const session = resolveHeartbeatSession(
      params.cfg,
      agent.agentId,
      agent.heartbeat,
      undefined,
      env,
    );
    const legacyState = session.entry?.heartbeatTaskState ?? {};
    const jobPlans: TaskJobPlan[] = [];
    let blocked = false;
    for (const { task, intervalMs, occurrenceIndex } of validatedTasks) {
      const declarationKey = heartbeatTaskDeclarationKey(agent.agentId, task.name, occurrenceIndex);
      const matches = snapshot.jobs.filter((job) => job.declarationKey === declarationKey);
      const existing = matches[0];
      if (
        matches.length > 1 ||
        (existing &&
          (!isHeartbeatTaskCronJob(existing) ||
            existing.agentId !== agent.agentId ||
            existing.name !== task.name))
      ) {
        warnings.push(
          `Agent "${agent.agentId}" task ${JSON.stringify(task.name)} collides with an incompatible cron declaration; ${sourceDescription} was left unchanged.`,
        );
        blocked = true;
        break;
      }
      const legacyLastRun = legacyState[task.name];
      const lastRunAtMs =
        typeof legacyLastRun === "number" && Number.isFinite(legacyLastRun)
          ? legacyLastRun
          : undefined;
      const job = convergeTaskJob({
        agentId: agent.agentId,
        task,
        occurrenceIndex,
        intervalMs,
        lastRunAtMs,
        existing,
        nowMs,
      });
      const sortOrder = reserveSortOrder(snapshot, existing);
      jobPlans.push({
        declarationKey,
        ...(existing ? { previous: structuredClone(existing) } : {}),
        job,
        sortOrder,
      });
    }
    if (blocked) {
      return false;
    }

    try {
      assertCronStoreCanPersist({ version: 1, jobs: jobPlans.map((plan) => plan.job) });
    } catch (error) {
      warnings.push(
        `Agent "${agent.agentId}" task jobs could not be planned: ${errorMessage(error)}. ${sourceDescription} was left unchanged.`,
      );
      return false;
    }

    const plan: AgentTaskMigrationPlan = {
      jobs: jobPlans,
      ...(source.kind === "scratch"
        ? {
            scratch: {
              monitorJobId: source.monitor.jobId,
              revision: source.revision,
              ...(source.monitor.state.scratch?.sourceSha256
                ? { sourceSha256: source.monitor.state.scratch.sourceSha256 }
                : {}),
              strippedContent: document.strippedContent,
            },
          }
        : {}),
    };
    let committed: MigrationCommitResult;
    try {
      committed = commitAgentTaskMigration({ storePath, env, nowMs, plan });
    } catch (error) {
      warnings.push(
        `Agent "${agent.agentId}" task migration could not be committed: ${errorMessage(error)}. ${sourceDescription} and cron jobs were left unchanged.`,
      );
      return false;
    }
    if (!committed.ok) {
      warnings.push(
        committed.reason === "revision-conflict"
          ? `Agent "${agent.agentId}" scratch changed during task migration; no changes were committed.`
          : `Agent "${agent.agentId}" cron jobs changed during task migration; no changes were committed.`,
      );
      return false;
    }

    for (const jobPlan of jobPlans) {
      const index = snapshot.jobs.findIndex((job) => job.id === jobPlan.job.id);
      if (index >= 0) {
        snapshot.jobs[index] = jobPlan.job;
      } else {
        snapshot.jobs.push(jobPlan.job);
      }
      snapshot.sortOrderByJobId.set(jobPlan.job.id, jobPlan.sortOrder);
    }
    const jobsChanged = jobPlans.some(
      (jobPlan) => !jobPlan.previous || !isDeepStrictEqual(jobPlan.previous, jobPlan.job),
    );
    if (source.kind === "scratch" || jobsChanged) {
      changes.push(
        `Converted ${document.tasks.length} heartbeat task${document.tasks.length === 1 ? "" : "s"} into cron jobs for agent "${agent.agentId}".`,
      );
    }

    try {
      // Session task timestamps live in the per-agent database, so they cannot
      // join the state-DB commit. They are advisory once cron owns scheduling;
      // this idempotent cleanup may safely be retried or skipped after a crash.
      await clearLegacyTaskTimestamps({
        storePath: session.storePath,
        sessionKey: session.sessionKey,
        env,
        tasks: document.tasks,
      });
    } catch (error) {
      warnings.push(
        `Agent "${agent.agentId}" legacy task timestamps could not be cleared after migration: ${errorMessage(error)}. Cron jobs remain authoritative and a rerun is safe.`,
      );
    }
    return true;
  };

  for (const candidate of candidates) {
    if (candidate.source.kind === "scratch") {
      await commitCandidate(candidate);
    }
  }

  const fileGroups = new Map<string, HeartbeatTaskMigrationCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.source.kind !== "file") {
      continue;
    }
    const group = fileGroups.get(candidate.source.entryKey) ?? [];
    group.push(candidate);
    fileGroups.set(candidate.source.entryKey, group);
  }
  const disabledEntryKeys = await resolveDisabledHeartbeatEntryKeys(params.cfg);
  for (const [entryKey, group] of fileGroups) {
    const representative = group[0];
    if (!representative || representative.source.kind !== "file") {
      continue;
    }
    const source = representative.source;
    const sourceVariants = new Set(
      group.map((candidate) =>
        candidate.source.kind === "file"
          ? `${candidate.source.sha256}\u0000${candidate.document.strippedContent}`
          : "",
      ),
    );
    if (sourceVariants.size !== 1) {
      warnings.push(
        `${shortenHomePath(source.filePath)} changed while shared heartbeat owners were being inspected; it was left unchanged.`,
      );
      continue;
    }

    let archivePath: string;
    try {
      archivePath = await archiveHeartbeatTaskFile(source, env);
    } catch (error) {
      warnings.push(
        `${shortenHomePath(source.filePath)} task migration could not be archived: ${errorMessage(error)}.`,
      );
      continue;
    }
    let claim: HeartbeatTaskFileClaim;
    try {
      claim = await claimHeartbeatTaskFile(source);
    } catch (error) {
      warnings.push(
        `${shortenHomePath(source.filePath)} could not be claimed for task migration: ${errorMessage(error)}.`,
      );
      continue;
    }

    let committedAll = true;
    for (const candidate of group) {
      if (!(await commitCandidate(candidate))) {
        committedAll = false;
      }
    }
    const enabledOwnerCount = enabledOwnersByEntryKey.get(entryKey)?.size ?? group.length;
    const retainSource = disabledEntryKeys.has(entryKey) || group.length < enabledOwnerCount;
    try {
      if (!committedAll || retainSource) {
        await claim.retain();
        if (committedAll && retainSource) {
          warnings.push(
            `${shortenHomePath(source.filePath)} retained its legacy task block because another heartbeat owner is disabled or could not be migrated.`,
          );
        }
        continue;
      }
      await claim.replaceWith(representative.document.strippedContent, archivePath);
      changes.push(`Removed migrated task declarations from ${shortenHomePath(source.filePath)}.`);
    } catch (error) {
      warnings.push(
        `${shortenHomePath(source.filePath)} could not finalize task migration: ${errorMessage(error)}. Cron jobs remain authoritative and a rerun is safe.`,
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
