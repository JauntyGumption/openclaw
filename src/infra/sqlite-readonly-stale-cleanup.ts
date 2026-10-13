import fs, { type Dirent } from "node:fs";
import path from "node:path";

const SQLITE_SNAPSHOT_STAGING_NAME_RE = /^openclaw-sqlite-readonly-(\d+)-/u;
const pendingTempDirectoryCleanup = new Set<string>();
let cleanupExitHandlerInstalled = false;

export type PreparedSqliteReadOnlyLocation = {
  cleanup: () => boolean;
  location: string;
};

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
  let entries: Dirent[];
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

export function sqliteSnapshotStagingError(
  tempDir: string,
  cause: unknown,
  allocation = false,
): unknown {
  for (let depth = 0, error = cause; depth < 8 && error instanceof Error; depth += 1) {
    const { code, errcode, path: errorPath }: NodeJS.ErrnoException & { errcode?: unknown } = error;
    if (
      allocation ||
      ["ENOSPC", "EDQUOT"].includes(code ?? "") ||
      (typeof errcode === "number" && [13, 778, 1034, 1290].includes(errcode)) ||
      `${errorPath ?? ""}${path.sep}`.startsWith(`${tempDir}${path.sep}`)
    ) {
      const message = `${cause instanceof Error ? cause.message : String(cause)}${
        typeof errcode === "number" ? ` (SQLite errcode=${errcode})` : ""
      }; snapshot staging root ${
        allocation ? tempDir : path.dirname(tempDir)
      }: free disk space/quota or set XDG_CACHE_HOME to a writable filesystem`;
      return new Error(message, { cause });
    }
    error = error.cause;
  }
  return cause;
}

export function removeTempDirectory(tempDir: string): boolean {
  try {
    fs.rmSync(tempDir, { force: true, maxRetries: 3, recursive: true, retryDelay: 20 });
    pendingTempDirectoryCleanup.delete(tempDir);
    return true;
  } catch {
    pendingTempDirectoryCleanup.add(tempDir);
    if (!cleanupExitHandlerInstalled) {
      cleanupExitHandlerInstalled = true;
      process.once("exit", () => {
        for (const pendingDir of pendingTempDirectoryCleanup) {
          try {
            fs.rmSync(pendingDir, { force: true, recursive: true });
          } catch {
            // The directory is private and remains registered until process teardown completes.
          }
        }
      });
    }
    return false;
  }
}

export function adoptPreparedLocation(location: string): PreparedSqliteReadOnlyLocation {
  const tempDir = path.dirname(location);
  let active = true;
  return {
    location,
    cleanup: () => {
      if (!active) {
        return true;
      }
      const removed = removeTempDirectory(tempDir);
      if (removed) {
        active = false;
      }
      return removed;
    },
  };
}
