# Vesper progress-card repair notes

## Decision

Keep `progress_card` as a durable session-status capability, but do not make maintaining it an ambient runtime obligation.

The 2026.8.2 behavior had two separate model-facing pressure surfaces:

1. `src/agents/progress-card-system-prompt.ts` injected:
   `During multi-step work, keep your progress card current with the progress_card tool; the user follows it instead of reading the transcript.`
2. `src/agents/tools/progress-card-tool.ts` described the tool with broader maintenance language, including `Keep it current on any task that takes more than a moment` and `it is how the user watches you work without scrolling`.

Together these made progress-card maintenance a recurring background duty rather than an optional technique.

## Applied repair

Commit `6710a44a9b0f6edb5779336521246fb8892178eb` (`fix(vesper): make progress cards opt-in capability`) preserves the mechanism while removing the ambient choreography:

- `appendProgressCardSystemPrompt(...)` now preserves existing system context without injecting a progress-card instruction.
- The `progress_card` tool remains registered and functional.
- Its description now explains storage, replacement semantics, markdown/plan representations, limits, and clearing behavior without instructing the agent to maintain it continuously.
- Regression tests require the system-prompt hook to add no progress-card obligation and require the tool description to remain capability-descriptive rather than maintenance-prescriptive.

This follows the fork distinction between capability and behavioral shaping: **useful capability should not automatically imply compulsory behavioral choreography.**

## Skill-layer integration

Situational guidance about when a progress card is useful belongs in a task-method skill such as `operational-rigor`, not in the base runtime prompt or tool schema.

A suitable skill-level policy is:

- consider a progress card for substantial multi-step work when durable at-a-glance state would materially help;
- especially consider it when work spans many tool calls, may survive reconnect/compaction, or has meaningful blockers, dependencies, or verification stages;
- prefer ordinary conversational progress updates when those are sufficient;
- do not maintain a card merely because a task has more than one step.

`operational-rigor` is not stored in this OpenClaw repository, so this fork intentionally does not create a synthetic runtime dependency on that skill. The workspace skill can be updated independently.

## Validation boundary

Static repository inspection on 2026-09-19 confirmed:

- repair branch head after the progress-card change: `6710a44a9b0f6edb5779336521246fb8892178eb`;
- `src/agents/system-prompt.ts` still has blob SHA `f2371fa94c7d5938c55271d62a0babab84ebf0a1`, exactly matching the guard in `scripts/vesper/apply-system-prompt-2026.8.2-repair.mjs`;
- `src/agents/system-prompt.test.ts` still has blob SHA `80fcf9f6bab20d5ab81bef4f566bead5aaf8dced`, exactly matching the guard in `scripts/vesper/apply-system-prompt-tests-2026.8.2-repair.mjs`.

The current ChatGPT execution environment could not resolve `github.com`, so the guarded scripts and test suite were **not executed here**. Run their `--check` modes and the targeted tests in a real repository checkout before treating the broader system-prompt repair as execution-verified.
