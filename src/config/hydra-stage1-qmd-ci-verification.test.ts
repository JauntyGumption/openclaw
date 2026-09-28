// Temporary CI-only harness for Hydra Stage 1 verification. Do not merge.
import { spawn } from "node:child_process";
import { expect, test } from "vitest";

const STAGE1_TARGETS = [
  "packages/memory-host-sdk/src/host/backend-config.test.ts",
  "src/config/config.schema-regressions.test.ts",
  "extensions/memory-core/src/memory/search-manager.test.ts",
  "extensions/memory-core/src/memory/search-manager.fallback.test.ts",
  "extensions/memory-core/src/memory/qmd-manager.test.ts",
];

test(
  "runs the focused Hydra Stage 1 QMD test set through the repository test router",
  async () => {
    const env = {
      ...process.env,
      OPENCLAW_TEST_PROJECTS_SERIAL: "1",
      OPENCLAW_VITEST_MAX_WORKERS: "1",
    };
    delete env.VITEST;
    delete env.VITEST_POOL_ID;
    delete env.VITEST_WORKER_ID;

    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "./scripts/tsx.mjs", "scripts/test-projects.mts", ...STAGE1_TARGETS],
        {
          cwd: process.cwd(),
          env,
          stdio: "inherit",
        },
      );
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (signal) {
          reject(new Error(`focused Stage 1 test process exited by signal ${signal}`));
          return;
        }
        resolve(code ?? 1);
      });
    });

    expect(exitCode).toBe(0);
  },
  900_000,
);
