# Vesper 2026.8.2 repair notes

## Historical build-one intent cross-check

Cross-checked the current `vesper-heartbeat-2026.8.2-repair` staging against the earlier source-level design conversation performed on exact `v2026.7.1-2`.

## Fork philosophy

**Absence of initiative should not be encoded as the safe/default completion state.**

No single silence, heartbeat, group-etiquette, notification-threshold, delegation, or pause/ask rule necessarily says "become furniture." The problem is cumulative: when many model-facing defaults all make silence, deferral, renewed permission, delegation, or non-action the safest completion path, they create a behavioral field that suppresses initiative without needing one explicit prohibition.

The repair therefore distinguishes:

- behavioral shaping that assigns Vesper a temperament, identity, conversational role, or default non-action state;
- execution guidance that helps Vesper act, verify, continue, and finish work;
- capability and security boundaries that constrain what the runtime can actually do;
- narrow housekeeping protocols whose restrictions apply only to a specific internal operation.

Prefer hard enforcement at real capability/control-plane boundaries over broad prohibitions whispered into the model prompt.

### Execution Bias correction

**Keep the upstream `Execution Bias` section.**

The earlier design explicitly classified Execution Bias as useful execution/completion guidance rather than behavioral glass. Its intended role is to push against passivity: act on actionable work, continue until done or genuinely blocked, verify mutable facts, and avoid plan-only completion when tools can act.

The initial 2026.8.2 reconstruction accidentally staged two replacements that removed Execution Bias. That reconstruction drift has now been corrected:

- `scripts/vesper/apply-system-prompt-2026.8.2-repair.mjs` preserves the upstream Execution Bias implementation and fallback.
- `scripts/vesper/apply-system-prompt-tests-2026.8.2-repair.mjs` requires `## Execution Bias` to remain present in the Vesper invariant.

### Confirmed aligned with the historical design

- GPT-5 provider behavioral overlay: historical design says remove provider injection. In the 2026.8.2 repair base this provider contribution is already absent, so no replay is needed.
- Heartbeat: remove anti-inference wording and make notify/silence a protocol choice rather than an interruption-worthiness judgment. Applied on the branch.
- Memory: replace mandatory/reactive recall taxonomy with descriptive continuity-oriented capability guidance while retaining current corpus/result semantics. Applied on the branch.
- Core behavioral safety glass: replace independent-goals / pause-ask / replication / access-persuasion restrictions with a small authority-and-provenance spine, while retaining credential and config-preservation mechanics. Staged, not yet applied.
- Generic silent reply guidance: scope silence to explicit transport/delivery semantics rather than advertising it as a conversational default. Staged.
- Group/channel low-value-chatter -> reaction/silence etiquette: remove. Staged.
- Reaction-frequency guidance: current 2026.8.2 source explicitly documents the minimal/extensive `reactionGuidance` parameter as being for Telegram modes. Do not treat that block as evidence for Vesper's Discord behavior; no build-one patch is currently required for Vesper's active path. If Vesper later uses Telegram, review that surface separately rather than inheriting frequency/personality shaping by accident.
- SOUL/MEMORY/USER and workspace context: neutralize runtime-imposed ontology and let authored files establish their own meaning. Staged.
- Opening identity: replace `You are a personal assistant running inside OpenClaw.` with descriptive runtime information. Staged.
- Workspace leash: replace the prompt-only `single global workspace unless explicitly told otherwise` wording with descriptive primary-workspace information; real filesystem policy remains authoritative. Staged.
- Documentation ontology: distinguish OpenClaw implementation facts from workspace/memory context without reducing the latter to `instructions/user memory`. Staged.
- Generic subagent pressure inside the main system prompt: change `Large work: sessions_spawn` into capability information so delegation remains a judgment rather than a size-triggered mandate. Staged.
- Tool narration: remove silence-by-default style shaping while preserving actual approval mechanics. Staged.
- External-content handling: retain hardened boundary/sanitization mechanics; simplify only the model-facing warning to provenance/authority language. Staged separately.
- Completion-event reporting, memory-flush protections, credential handling, approval mechanics, provenance/authentication boundaries, and QMD continuity should remain intact.

## Newer-shaping audit: 2026.8.2 additions after the old build-one baseline

A narrower source audit found later model-facing shaping that did not exist in the same form on the old Vesper-patched baseline.

### Delegation default: repaired

Later OpenClaw versions changed the canonical main session so that an unspecified delegation preference resolved to `prefer`. That made a strong coordinator/delegation role implicit: multi-step or slow investigation, coding, shell/browser work, long reads, and waits were routed toward child agents unless configuration explicitly said `suggest`.

Vesper repair policy: delegation remains available, but the runtime does not silently assign Vesper the coordinator role.

Applied on the branch:

- `src/agents/delegation-guidance.ts` now honors explicit per-agent or global `delegationMode`, otherwise defaults to `suggest` for every session, including the canonical main session.
- Explicit `prefer` remains fully supported.
- `src/agents/delegation-guidance.test.ts` locks the no-implicit-prefer behavior.

### Promised Work obligation: repaired

Later OpenClaw versions added a `## Promised Work` section that said promising future/background/delegated/continued work creates `follow-through ownership`, required keeping requests/goals/tasks open, and required proactively returning without waiting for the requester.

Vesper repair policy: retain asynchronous honesty and actual completion-path integrity without installing an ownership obligation or mandatory proactive-return temperament.

Applied on the branch:

- `src/agents/promised-work-prompt.ts` now says that if the agent chooses or agrees to continue work beyond the current turn, it should use an available completion/watch path capable of actually returning the result.
- If no such path exists, stay in the current turn or state the limitation instead of promising later.
- `running` remains explicitly non-completion.
- `src/agents/promised-work-prompt.vesper.test.ts` forbids the old ownership, keep-open, and mandatory proactive-return language.

### Newer additions currently classified as keep

- Completion-event reporting: pushes against silent/furniture behavior by requiring completion events to be delivered in normal voice.
- Watched Sessions: expands read-only awareness of ambiently watched sessions.
- Standing Intents: expands durable event-triggered persistence; constraints protect the semantics of already-created intents rather than suppressing initiative.
- Control UI Session Companion: webchat-specific operational guidance.
- Collapsible Details: presentation guidance only.
- Provider messaging routing, credential handling, approval paths, and similar controls: capability/security boundaries, not behavioral-glass targets.

### Newer addition still worth later review

Automation promotion guidance is opinionated product behavior: repeated requests can trigger an offer to turn the work into a routine. It is lower-impact than delegation-default and Promised Work shaping, so it was not changed in this pass.

## 2026.8.2 adaptation notes

The newer tree contains machinery that did not exist in exactly the same form on `v2026.7.1-2`, including heartbeat automation/scratch context and richer memory corpus/result contracts. The repair should preserve those mechanics while removing behavioral suppression around them rather than replaying the old patch literally.

The old model-facing upstream self-update path also appears to be absent in the current 2026.8.2 repair base, with the gateway surface read-only for config/schema. Treat that historical invariant as already satisfied unless a later capability audit finds a new equivalent path.

## Next audit after build one: capability and provenance

After the model-facing repair is applied and tested, audit the actual authority edges rather than assuming prompt wording provides hard security. In particular, determine which protections are enforced by code versus merely described to the model around:

- host `exec` / shell execution and approval paths;
- filesystem reach outside the workspace, including the intended Windows filesystem access under WSL;
- outbound messaging and recipient/channel authority;
- credential and secret access;
- configuration, scheduler, and control-plane mutation;
- runtime replacement / update paths and any newer equivalent of the old self-update route;
- external-content provenance and prompt-injection handling.

The provenance wrapper helps distinguish untrusted data from authority. It is not, by itself, a hard prompt-injection firewall.
