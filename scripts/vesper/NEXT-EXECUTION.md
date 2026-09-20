# Vesper repair: next local execution gate

This checkpoint separates work already settled in the repository from migrations that still need to be executed in a real checkout and then tested.

## Current settled state

- Progress-card maintenance is no longer an ambient obligation. The capability remains available.
- The progress-card architectural decision is recorded in `PROGRESS-CARD-REPAIR.md`.
- A hidden shared GPT-5 behavior-overlay path was found in `src/plugins/provider-runtime.ts`; guarded source and test migrations are staged to remove the behavioral payloads and shared injection from Vesper's runtime path.
- Ambient automation promotion (third repeat -> offer/create/test a routine) is now part of the guarded system-prompt repair; the automations capability itself remains available.
- `ultra` thinking is staged to stop implicitly enabling proactive subagent orchestration. The run-time forwarding/plumbing and model-facing Ultra orchestration section are removed rather than left as inert behavioral machinery.
- Guarded system-prompt source and test migrations are staged.
- Guarded external-content source and test migrations are staged.
- `Execution Bias` is intentionally preserved by the system-prompt repair.

## 1. Guard checks

Run these first, without mutating files. The GPT-5 overlay checks come first because that shared provider-runtime prefix sits above the main system-prompt repair. The ultra-orchestration checks are independent source/test surfaces and should also pass before mutation:

```sh
node scripts/vesper/apply-gpt5-overlay-2026.8.2-repair.mjs --check
node scripts/vesper/apply-gpt5-overlay-tests-2026.8.2-repair.mjs --check
node scripts/vesper/apply-ultra-orchestration-2026.8.2-repair.mjs --check
node scripts/vesper/apply-ultra-orchestration-tests-2026.8.2-repair.mjs --check
node scripts/vesper/apply-system-prompt-2026.8.2-repair.mjs --check
node scripts/vesper/apply-system-prompt-tests-2026.8.2-repair.mjs --check
node scripts/vesper/apply-external-content-2026.8.2-repair.mjs --check
node scripts/vesper/apply-external-content-tests-2026.8.2-repair.mjs --check
```

Expected source blobs at the time this checkpoint was prepared:

- `src/agents/gpt5-prompt-overlay.ts`: `9e8e950f5320378e68ae96bacbf085112b49f5da`
- `src/plugins/provider-runtime.ts`: `5c10ed9f1b32604c2dd85574dce17559587013d0`
- `src/plugins/provider-runtime.test.ts`: `5307c069b9a9d13fea0019fd66eb58592c9773f5`
- `src/agents/embedded-agent-runner/run/attempt-setup.ts`: `a55a398c26ec7f6014ff46420cf13b469fce37bc`
- `src/agents/embedded-agent-runner/run/attempt.ts`: `a9e1899bc6c091f96d8407cbdee66e2b54fc6d8e`
- `src/agents/embedded-agent-runner/run/attempt-system-prompt-prepare.ts`: `dd862eea1f5a402057db0d15814505560ea831cc`
- `src/agents/embedded-agent-runner/system-prompt.ts`: `27344de31579b3df07688971537b0419621e7823`
- `src/agents/embedded-agent-runner/run/attempt-setup.test.ts`: `edf8d126cc478b43e81922f4e05c0ff6dacc1e08`
- `src/agents/system-prompt.ts`: `f2371fa94c7d5938c55271d62a0babab84ebf0a1`
- `src/agents/system-prompt.test.ts`: `80fcf9f6bab20d5ab81bef4f566bead5aaf8dced`
- `src/security/external-content.ts`: `7784e78e8c1efa7c9484ceb34f4cd31b8ea301c2`
- `src/security/external-content.test.ts`: `f4069d2272d474b8ad0dd1405ad25c22b0f3e0a5`

Stop if any guard fails. Do not weaken or bypass a failed guard; inspect the changed source instead.

## 2. Apply migrations

If all eight checks pass:

```sh
node scripts/vesper/apply-gpt5-overlay-2026.8.2-repair.mjs
node scripts/vesper/apply-gpt5-overlay-tests-2026.8.2-repair.mjs
node scripts/vesper/apply-ultra-orchestration-2026.8.2-repair.mjs
node scripts/vesper/apply-ultra-orchestration-tests-2026.8.2-repair.mjs
node scripts/vesper/apply-system-prompt-2026.8.2-repair.mjs
node scripts/vesper/apply-system-prompt-tests-2026.8.2-repair.mjs
node scripts/vesper/apply-external-content-2026.8.2-repair.mjs
node scripts/vesper/apply-external-content-tests-2026.8.2-repair.mjs
```

The GPT-5 overlay repair deliberately removes the behavioral payloads from the deprecated compatibility helper and removes the shared provider-runtime `baseOverlay` injection entirely. Provider-owned prompt contributions remain available, but they receive no hidden GPT-family base behavior contract.

The ultra-orchestration repair removes the implicit coupling end to end: choosing `thinkLevel: "ultra"` no longer derives, returns, forwards, or injects a `proactiveSubagentOrchestration` flag. Thinking-level mapping remains intact, and `sessions_spawn` / explicit delegation modes remain available independently.

The system-prompt repair removes the Ultra orchestration parameter/helper/section from the main prompt builder and also removes the repeat-count automation-promotion protocol while preserving the automations tool and its ordinary capability description.

The system-prompt test migration removes the upstream Ultra-orchestration expectation, asserts explicit delegation still works without that section, and creates `src/agents/system-prompt.vesper.test.ts`; it intentionally refuses to overwrite an existing file.

## 3. Focused verification

Run the focused suites before a broad build:

```sh
node scripts/run-vitest.mjs \
  src/plugins/provider-runtime.test.ts \
  src/agents/embedded-agent-runner/run/attempt-setup.test.ts \
  src/agents/system-prompt.test.ts \
  src/agents/system-prompt.vesper.test.ts \
  src/security/external-content.test.ts \
  src/agents/progress-card-system-prompt.test.ts \
  src/agents/tools/progress-card-tool.test.ts
```

Then include the already-repaired continuity/heartbeat/memory surfaces from the repair notes in the next targeted pass before broad build verification.

## 4. Review invariants before broad build

Confirm after migration that:

- no shared GPT-5 behavior contract or interaction-style overlay is injected by provider runtime;
- the GPT-5 compatibility module contains no persona/tone/heartbeat/execution/tool/output/completion behavioral payloads;
- provider-owned prompt contributions still work without receiving a hidden GPT-5 `baseOverlay`;
- `<persona_latch>` is not present in Vesper's runtime prompt merely because the model belongs to the GPT-5 family;
- `proactiveSubagentOrchestration` is absent from the migrated runtime/prompt path;
- `thinkLevel: "ultra"` does not implicitly enable proactive subagent orchestration;
- `sessions_spawn` remains available as a capability rather than an assigned role;
- explicit delegation modes remain available independently of thinking level;
- the system prompt does not say repeated work must trigger an automation offer;
- the automations tool remains available when configured;
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
