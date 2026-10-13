import fs from "node:fs";
import path from "node:path";

const SQLITE_SNAPSHOT_STAGING_NAME_RE = /^openclaw-sqlite-readonly-(\d+)-/u;

export function sqliteSnapshotStagingPrefix(ownerPid: number): string {
  return `openclaw-sqlite-readonly-${ownerPid}-`;
}

function isSqliteSnapshotOwnerAlive(ownerPid: number): boolean {
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
    return true;
  }
  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function cleanupStaleSqliteSnapshotDirectories(stagingRoot: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(stagingRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const match = SQLITE_SNAPSHOT_STAGING_NAME_RE.exec(entry.name);
    if (!match) {
      continue;
    }
    const ownerPid = Number.parseInt(match[1] ?? "", 10);
    if (isSqliteSnapshotOwnerAlive(ownerPid)) {
      continue;
    }
    const staleDirectory = path.join(stagingRoot, entry.name);
    try {
      fs.rmSync(staleDirectory, {
        force: true,
        maxRetries: 3,
        recursive: true,
        retryDelay: 20,
      });
    } catch (error) {
      throw new Error(
        `Unable to remove stale SQLite read-only snapshot ${staleDirectory}; refusing to allocate another snapshot.`,
        { cause: error },
      );
    }
  }
}
