# Vesper 2026.8.2 repair notes

## Historical build-one intent cross-check

Cross-checked the current `vesper-heartbeat-2026.8.2-repair` staging against the earlier source-level design conversation performed on exact `v2026.7.1-2`.

### Important correction before applying the staged system-prompt repair

**Keep the upstream `Execution Bias` section.**

The earlier design explicitly classified Execution Bias as useful execution/completion guidance rather than behavioral glass. Its intended role is to push against passivity: act on actionable work, continue until done or genuinely blocked, verify mutable facts, and avoid plan-only completion when tools can act.

The currently staged `scripts/vesper/apply-system-prompt-2026.8.2-repair.mjs` mistakenly contains two replacements that remove the 2026.8.2 Execution Bias default:

- `remove upstream execution bias default`
- `disable upstream execution bias fallback`

Those two replacements should be removed before the staged repair is executed.

Likewise, `scripts/vesper/apply-system-prompt-tests-2026.8.2-repair.mjs` currently creates a Vesper invariant asserting that `## Execution Bias` is absent. That invariant should instead assert that the section remains present.

This is a reconstruction drift, not an intentional change in the Vesper runtime philosophy.

### Confirmed aligned with the historical design

- GPT-5 provider behavioral overlay: historical design says remove provider injection. In the 2026.8.2 repair base this provider contribution is already absent, so no replay is needed.
- Heartbeat: remove anti-inference wording and make notify/silence a protocol choice rather than an interruption-worthiness judgment. Applied on the branch.
- Memory: replace mandatory/reactive recall taxonomy with descriptive continuity-oriented capability guidance while retaining current corpus/result semantics. Applied on the branch.
- Core behavioral safety glass: replace independent-goals / pause-ask / replication / access-persuasion restrictions with a small authority-and-provenance spine, while retaining credential and config-preservation mechanics. Staged, not yet applied.
- Generic silent reply guidance: scope silence to explicit transport/delivery semantics rather than advertising it as a conversational default. Staged.
- Group/channel low-value-chatter -> reaction/silence etiquette: remove. Staged.
- Reaction-frequency guidance: do not treat the Telegram-specific minimal/extensive block as evidence for Vesper's Discord behavior; no build-one patch currently required.
- SOUL/MEMORY/USER and workspace context: neutralize runtime-imposed ontology and let authored files establish their own meaning. Staged.
- Opening identity: replace `You are a personal assistant running inside OpenClaw.` with descriptive runtime information. Staged.
- Workspace leash: replace the prompt-only `single global workspace unless explicitly told otherwise` wording with descriptive primary-workspace information; real filesystem policy remains authoritative. Staged.
- Documentation ontology: distinguish OpenClaw implementation facts from workspace/memory context without reducing the latter to `instructions/user memory`. Staged.
- Generic subagent pressure: change `Large work: sessions_spawn` into capability information so delegation remains a judgment rather than a size-triggered mandate. Staged.
- Tool narration: remove silence-by-default style shaping while preserving actual approval mechanics. Staged.
- External-content handling: retain hardened boundary/sanitization mechanics; simplify only the model-facing warning to provenance/authority language. Staged separately.
- Completion-event reporting, memory-flush protections, credential handling, approval mechanics, provenance/authentication boundaries, and QMD continuity should remain intact.

### 2026.8.2 adaptation notes

The newer tree contains machinery that did not exist in exactly the same form on `v2026.7.1-2`, including heartbeat automation/scratch context and richer memory corpus/result contracts. The repair should preserve those mechanics while removing behavioral suppression around them rather than replaying the old patch literally.

The old model-facing upstream self-update path also appears to be absent in the current 2026.8.2 repair base, with the gateway surface read-only for config/schema. Treat that historical invariant as already satisfied unless a later capability audit finds a new equivalent path.
