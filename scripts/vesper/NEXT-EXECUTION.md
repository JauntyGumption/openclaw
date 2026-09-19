# Vesper repair: next local execution gate

This checkpoint separates work already settled in the repository from migrations that still need to be executed in a real checkout and then tested.

## Current settled state

- Progress-card maintenance is no longer an ambient obligation. The capability remains available.
- The progress-card architectural decision is recorded in `PROGRESS-CARD-REPAIR.md`.
- Guarded system-prompt source and test migrations are staged.
- Guarded external-content source and test migrations are staged.
- `Execution Bias` is intentionally preserved by the system-prompt repair.

## 1. Guard checks

Run these first, without mutating files:

```sh
node scripts/vesper/apply-system-prompt-2026.8.2-repair.mjs --check
node scripts/vesper/apply-system-prompt-tests-2026.8.2-repair.mjs --check
node scripts/vesper/apply-external-content-2026.8.2-repair.mjs --check
node scripts/vesper/apply-external-content-tests-2026.8.2-repair.mjs --check
```

Expected source blobs at the time this checkpoint was prepared:

- `src/agents/system-prompt.ts`: `f2371fa94c7d5938c55271d62a0babab84ebf0a1`
- `src/agents/system-prompt.test.ts`: `80fcf9f6bab20d5ab81bef4f566bead5aaf8dced`
- `src/security/external-content.ts`: `7784e78e8c1efa7c9484ceb34f4cd31b8ea301c2`
- `src/security/external-content.test.ts`: `f4069d2272d474b8ad0dd1405ad25c22b0f3e0a5`

Stop if any guard fails. Do not weaken or bypass a failed guard; inspect the changed source instead.

## 2. Apply migrations

If all four checks pass:

```sh
node scripts/vesper/apply-system-prompt-2026.8.2-repair.mjs
node scripts/vesper/apply-system-prompt-tests-2026.8.2-repair.mjs
node scripts/vesper/apply-external-content-2026.8.2-repair.mjs
node scripts/vesper/apply-external-content-tests-2026.8.2-repair.mjs
```

The system-prompt test migration also creates `src/agents/system-prompt.vesper.test.ts`; it intentionally refuses to overwrite an existing file.

## 3. Focused verification

Run the focused suites before a broad build:

```sh
node scripts/run-vitest.mjs \
  src/agents/system-prompt.test.ts \
  src/agents/system-prompt.vesper.test.ts \
  src/security/external-content.test.ts \
  src/agents/progress-card-system-prompt.test.ts \
  src/agents/tools/progress-card-tool.test.ts
```

Then include the already-repaired continuity/heartbeat/memory surfaces from the repair notes in the next targeted pass before broad build verification.

## 4. Review invariants before broad build

Confirm after migration that:

- runtime identity is descriptive (`Runtime: OpenClaw.`), not a personal-assistant ontology;
- authored workspace files are loaded as context without runtime-assigned persona/profile ontology;
- broad independent-goal prohibition is absent;
- authenticated authority/provenance boundaries remain;
- generic silence is transport semantics, not a conversational default;
- Discord group/channel chatter is not globally biased toward reaction or silence;
- delegation is available rather than compulsory;
- `Execution Bias` remains present;
- progress-card capability remains available without ambient maintenance pressure;
- external content remains fenced/sanitized while the warning states provenance and authority rather than a long behavioral prohibition list.

## 5. Only then broaden verification

After focused tests pass, run the repository's normal type/build/test checks appropriate to the 2026.8.2 checkout. Fix demonstrated failures rather than pre-emptively reshaping unrelated surfaces.

## Handoff note

The scripts are intentionally exact-blob guarded. Their purpose is to make source drift visible rather than silently applying a stale transformation. A guard failure is information, not an obstacle to bypass.
