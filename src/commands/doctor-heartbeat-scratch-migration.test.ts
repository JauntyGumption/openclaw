import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retainLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  hashCronScratchSource,
  readCronJobScratchState,
  writeCronJobScratch,
} from "../cron/scratch-store.js";
import { loadCronJobsStore, resolveCronJobsStorePath } from "../cron/store.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { ensureHeartbeatMonitorJobs } from "./doctor-heartbeat-cadence-migration.js";
import {
  collectHeartbeatScratchMigrationFindings,
  maybeMigrateHeartbeatFilesToScratch,
} from "./doctor-heartbeat-scratch-migration.js";

const tempDirs: string[] = [];
let originalHome: string | undefined;
let originalStateDir: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  originalStateDir = process.env.OPENCLAW_STATE_DIR;
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createFixture(agentIds: readonly string[] = ["main"], shared = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-heartbeat-restoration-"));
  tempDirs.push(root);
  const stateDir = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  process.env.HOME = path.join(root, "home");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const cfg = retainLegacyDefaultAgentId(
    {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        list: agentIds.map((id) => ({
          id,
          workspace: shared ? workspace : path.join(root, `workspace-${id}`),
        })),
      },
    } as OpenClawConfig,
    "main",
  );
  if (!shared) {
    await Promise.all(
      agentIds.map((id) => fs.mkdir(path.join(root, `workspace-${id}`), { recursive: true })),
    );
  }
  const storePath = resolveCronJobsStorePath();
  await ensureHeartbeatMonitorJobs(cfg, storePath, process.env);
  return {
    root,
    workspace,
    cfg,
    storePath,
    heartbeatPath: path.join(workspace, "HEARTBEAT.md"),
  };
}

async function loadMonitor(storePath: string, agentId = "main") {
  const store = await loadCronJobsStore(storePath);
  const monitor = store.jobs.find(
    (job) => job.agentId === agentId && job.payload.kind === "heartbeat",
  );
  if (!monitor) {
    throw new Error(`expected heartbeat monitor for ${agentId}`);
  }
  return monitor;
}

async function seedScratch(params: {
  storePath: string;
  agentId?: string;
  content: string;
  migrated?: boolean;
}) {
  const monitor = await loadMonitor(params.storePath, params.agentId);
  const write = writeCronJobScratch({
    storePath: params.storePath,
    jobId: monitor.id,
    content: params.content,
    expectedRevision: 0,
    ...(params.migrated === false ? {} : { sourceSha256: hashCronScratchSource(params.content) }),
  });
  expect(write.ok).toBe(true);
  return monitor;
}

describe("HEARTBEAT.md restoration from migration-owned scratch", () => {
  it("leaves canonical authored files alone when no migration provenance remains", async () => {
    const fixture = await createFixture();
    await fs.writeFile(fixture.heartbeatPath, "authored guidance\n", "utf8");

    await expect(collectHeartbeatScratchMigrationFindings(fixture.cfg)).resolves.toEqual([]);
    await expect(
      maybeMigrateHeartbeatFilesToScratch({ cfg: fixture.cfg, shouldRepair: true }),
    ).resolves.toEqual({ changes: [], warnings: [] });
    await expect(fs.readFile(fixture.heartbeatPath, "utf8")).resolves.toBe("authored guidance\n");
  });

  it("previews without mutation, then restores the file and clears only migrated scratch", async () => {
    const fixture = await createFixture();
    const content = "# Operations\n\nReview deployment health.\n";
    const monitor = await seedScratch({ storePath: fixture.storePath, content });

    await expect(collectHeartbeatScratchMigrationFindings(fixture.cfg)).resolves.toEqual([
      expect.objectContaining({
        checkId: "core/doctor/heartbeat-file-restoration",
        requirement: "migrated-heartbeat-file-missing",
        target: "main",
      }),
    ]);
    await maybeMigrateHeartbeatFilesToScratch({ cfg: fixture.cfg, shouldRepair: false });
    await expect(fs.access(fixture.heartbeatPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(readCronJobScratchState(fixture.storePath, monitor.id).scratch?.content).toBe(content);

    const result = await maybeMigrateHeartbeatFilesToScratch({
      cfg: fixture.cfg,
      shouldRepair: true,
    });
    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(2);
    await expect(fs.readFile(fixture.heartbeatPath, "utf8")).resolves.toBe(content);
    expect(readCronJobScratchState(fixture.storePath, monitor.id)).toEqual({
      currentRevision: 2,
    });
    await expect(collectHeartbeatScratchMigrationFindings(fixture.cfg)).resolves.toEqual([]);
  });

  it("does not reinterpret operator-authored scratch without migration provenance", async () => {
    const fixture = await createFixture();
    const monitor = await seedScratch({
      storePath: fixture.storePath,
      content: "mutable operator notes\n",
      migrated: false,
    });

    await expect(collectHeartbeatScratchMigrationFindings(fixture.cfg)).resolves.toEqual([]);
    await expect(
      maybeMigrateHeartbeatFilesToScratch({ cfg: fixture.cfg, shouldRepair: true }),
    ).resolves.toEqual({ changes: [], warnings: [] });
    await expect(fs.access(fixture.heartbeatPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(readCronJobScratchState(fixture.storePath, monitor.id).scratch?.content).toBe(
      "mutable operator notes\n",
    );
  });

  it("clears an exact migration-owned duplicate without rewriting the file", async () => {
    const fixture = await createFixture();
    const content = "shared authored guidance\n";
    await fs.writeFile(fixture.heartbeatPath, content, "utf8");
    const monitor = await seedScratch({ storePath: fixture.storePath, content });
    const writeFile = vi.spyOn(fs, "writeFile");

    const result = await maybeMigrateHeartbeatFilesToScratch({
      cfg: fixture.cfg,
      shouldRepair: true,
    });

    expect(result.warnings).toEqual([]);
    expect(writeFile).not.toHaveBeenCalled();
    await expect(fs.readFile(fixture.heartbeatPath, "utf8")).resolves.toBe(content);
    expect(readCronJobScratchState(fixture.storePath, monitor.id).scratch).toBeUndefined();
  });

  it("preserves both copies when authored file content differs from migrated scratch", async () => {
    const fixture = await createFixture();
    await fs.writeFile(fixture.heartbeatPath, "new authored guidance\n", "utf8");
    const monitor = await seedScratch({
      storePath: fixture.storePath,
      content: "older migrated guidance\n",
    });

    const findings = await collectHeartbeatScratchMigrationFindings(fixture.cfg);
    expect(findings).toEqual([
      expect.objectContaining({
        severity: "error",
        requirement: "heartbeat-file-restoration-conflict",
      }),
    ]);
    const result = await maybeMigrateHeartbeatFilesToScratch({
      cfg: fixture.cfg,
      shouldRepair: true,
    });
    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("both were preserved");
    await expect(fs.readFile(fixture.heartbeatPath, "utf8")).resolves.toBe(
      "new authored guidance\n",
    );
    expect(readCronJobScratchState(fixture.storePath, monitor.id).scratch?.content).toBe(
      "older migrated guidance\n",
    );
  });

  it("restores one shared file and clears matching migrated copies for every owner", async () => {
    const fixture = await createFixture(["main", "ops"]);
    const content = "shared checklist\n";
    const monitors = await Promise.all(
      ["main", "ops"].map((agentId) =>
        seedScratch({ storePath: fixture.storePath, agentId, content }),
      ),
    );

    const result = await maybeMigrateHeartbeatFilesToScratch({
      cfg: fixture.cfg,
      shouldRepair: true,
    });

    expect(result.warnings).toEqual([]);
    await expect(fs.readFile(fixture.heartbeatPath, "utf8")).resolves.toBe(content);
    for (const monitor of monitors) {
      expect(readCronJobScratchState(fixture.storePath, monitor.id).scratch).toBeUndefined();
    }
  });

  it("does not choose between conflicting migrated copies for a shared workspace", async () => {
    const fixture = await createFixture(["main", "ops"]);
    const mainMonitor = await seedScratch({
      storePath: fixture.storePath,
      agentId: "main",
      content: "main guidance\n",
    });
    const opsMonitor = await seedScratch({
      storePath: fixture.storePath,
      agentId: "ops",
      content: "ops guidance\n",
    });

    const result = await maybeMigrateHeartbeatFilesToScratch({
      cfg: fixture.cfg,
      shouldRepair: true,
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("different migration-owned heartbeat content");
    await expect(fs.access(fixture.heartbeatPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(readCronJobScratchState(fixture.storePath, mainMonitor.id).scratch).toBeDefined();
    expect(readCronJobScratchState(fixture.storePath, opsMonitor.id).scratch).toBeDefined();
  });

  it("recognizes a task-stripped file as the safe successor of migrated scratch", async () => {
    const fixture = await createFixture();
    const migrated =
      "# Checklist\n\nKeep this prose.\n\ntasks:\n  - name: inbox\n    interval: 1h\n    prompt: Check inbox\n";
    await fs.writeFile(fixture.heartbeatPath, "# Checklist\n\nKeep this prose.\n\n", "utf8");
    const monitor = await seedScratch({ storePath: fixture.storePath, content: migrated });

    const result = await maybeMigrateHeartbeatFilesToScratch({
      cfg: fixture.cfg,
      shouldRepair: true,
    });

    expect(result.warnings).toEqual([]);
    expect(readCronJobScratchState(fixture.storePath, monitor.id).scratch).toBeUndefined();
  });

  it("uses scratch revision CAS so a concurrent operator edit survives restoration", async () => {
    const fixture = await createFixture();
    const monitor = await seedScratch({
      storePath: fixture.storePath,
      content: "migrated guidance\n",
    });
    const realWriteFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      await realWriteFile(...args);
      const state = readCronJobScratchState(fixture.storePath, monitor.id);
      writeCronJobScratch({
        storePath: fixture.storePath,
        jobId: monitor.id,
        content: "concurrent operator notes\n",
        expectedRevision: state.currentRevision,
      });
    });

    const result = await maybeMigrateHeartbeatFilesToScratch({
      cfg: fixture.cfg,
      shouldRepair: true,
    });

    expect(result.warnings.join("\n")).toContain("changed during restoration");
    await expect(fs.readFile(fixture.heartbeatPath, "utf8")).resolves.toBe("migrated guidance\n");
    expect(readCronJobScratchState(fixture.storePath, monitor.id).scratch?.content).toBe(
      "concurrent operator notes\n",
    );
  });
});
