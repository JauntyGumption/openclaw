# Vesper progress-card repair

Checkpoint for the OpenClaw 2026.8.2 Vesper repair branch.

## Decision

Keep `progress_card` as a capability and durable session-status mechanism without making its maintenance an ambient behavioral obligation.

The runtime should expose the tool, storage, protocol, and UI. Whether a particular task benefits from a progress card is contextual procedural judgment, not a universal rule for any task that takes more than a moment.

## Repaired model-facing surfaces

At commit `6710a44a9b0f6edb5779336521246fb8892178eb`:

- `src/agents/progress-card-system-prompt.ts` no longer injects the instruction to keep a progress card current during multi-step work.
- `src/agents/tools/progress-card-tool.ts` describes the capability and input contract without instructing the agent to maintain it on ordinary nontrivial work.
- Regression coverage in the corresponding progress-card prompt/tool tests locks those semantics in.

The durable progress-card mechanism itself remains available.

## Skill-layer guidance

Contextual guidance belongs in an operational skill such as the user's `operational-rigor` skill rather than in the universal runtime prompt or tool schema.

Suggested semantics for that skill:

- Consider `progress_card` for substantial multi-step work when durable at-a-glance state genuinely helps.
- It is especially useful when work spans many tool calls, has meaningful verification stages or blockers, or may need to remain legible across reconnects or compaction.
- Do not maintain a card merely because a task contains multiple steps.
- Prefer ordinary conversational progress updates when they are sufficient.
- When a card is used, update it on meaningful state changes rather than every message.

The skill is external to this repository, so this repair deliberately does not create a runtime dependency on it.

## Architectural principle

Useful capability does not imply compulsory behavioral choreography.

This repair preserves the progress-card mechanism while returning the decision to use it to the agent's context-sensitive judgment and skill-layer procedure.
