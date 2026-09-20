# Vesper behavioral-shaping audit

Date: 2026-09-20

This note records runtime/model-facing behavioral layers discovered while adapting the Vesper fork to OpenClaw 2026.8.2. The fork's architectural preference is to keep runtime capabilities broad while avoiding ambient temperament, identity, silence, initiative, delegation, or workflow choreography that is not required by an actual authority/capability boundary.

## 1. Shared GPT-5 behavior overlay

### Finding

`src/plugins/provider-runtime.ts` supplied a shared GPT-5 `baseOverlay` through `resolveGpt5SystemPromptContribution()`. The deprecated-looking helper in `src/agents/gpt5-prompt-overlay.ts` was therefore still behaviorally active.

The payload included persona/tone persistence (`<persona_latch>`), interaction-style guidance, heartbeat choreography, execution/tool/output/completion contracts, and related GPT-family behavior shaping. Setting the OpenAI personality option to `off` did not remove the stable behavior contract.

### Fork decision

Remove the shared GPT-5 behavior layer completely rather than merely turning off the friendly interaction style.

Staged repair:

- `scripts/vesper/apply-gpt5-overlay-2026.8.2-repair.mjs`
- `scripts/vesper/apply-gpt5-overlay-tests-2026.8.2-repair.mjs`

The source repair removes the shared provider-runtime injection and converts the historical helper into an inert compatibility tombstone with empty payload exports and a resolver that returns no contribution. Provider-owned prompt-contribution hooks remain available.

## 2. Ambient automation promotion

### Finding

The main system prompt contains an ambient workflow-promotion rule gated only on the automations tool being present:

- on the third repeat of the same job, perform it and offer a routine;
- inspect existing automations;
- restate schedule/task and get approval;
- create the automation;
- force-run it as a visible test;
- remove it if that test fails.

This is product-authored behavior about when Vesper should promote a workflow, not a description of the automation capability itself.

### Fork decision

Remove the repeat-count promotion protocol from the base prompt while preserving the automations tool, scheduler behavior, and ordinary explicit automation requests.

The removal is folded into the already-guarded system-prompt migration so the original exact source-blob guard remains valid:

- `scripts/vesper/apply-system-prompt-2026.8.2-repair.mjs`
- `scripts/vesper/apply-system-prompt-tests-2026.8.2-repair.mjs`

The migrated tests assert that the automations capability remains visible while the `asked a 3rd time` / promotion language is absent.

## 3. `ultra` thinking coupled to proactive subagent orchestration

### Finding

`src/agents/embedded-agent-runner/run/attempt-setup.ts` currently sets:

```ts
const proactiveSubagentOrchestration = params.thinkLevel === "ultra";
```

The value is then returned and forwarded through the embedded-run prompt path before the main system prompt uses it to inject a `Proactive Sub-Agent Orchestration` section including `Ultra active. Use sessions_spawn...` guidance.

This makes a reasoning-level choice silently assign delegation/orchestration behavior.

### Fork decision

Decouple the concerns by removing the Ultra-specific orchestration plumbing rather than carrying an inert false flag. `ultra` remains a reasoning-level choice and its existing reasoning-level mappings remain intact. Delegation tools and explicit delegation modes remain available independently of reasoning effort.

Staged repair:

- `scripts/vesper/apply-ultra-orchestration-2026.8.2-repair.mjs`
- `scripts/vesper/apply-ultra-orchestration-tests-2026.8.2-repair.mjs`
- Ultra-specific parameter/helper/section removal in `scripts/vesper/apply-system-prompt-2026.8.2-repair.mjs`
- matching upstream expectation removal and explicit-delegation invariant in `scripts/vesper/apply-system-prompt-tests-2026.8.2-repair.mjs`

The source migration removes `proactiveSubagentOrchestration` from the attempt setup result and forwarding path. The regression test asserts that an embedded attempt prepared with `thinkLevel: "ultra"` has no `proactiveSubagentOrchestration` property. The main prompt regression preserves explicit `subagentDelegationMode` behavior while asserting that no Ultra orchestration section is injected.

## 4. Related surfaces intentionally preserved

This audit does not classify every imperative-looking prompt sentence as behavioral glass. The following are intentionally preserved unless separate evidence shows a problem:

- `Execution Bias`: act on actionable work, continue until done or genuinely blocked, verify mutable facts, and ground completion claims.
- Actual tool and transport mechanics.
- Authenticated authority, approval, credential, config/scheduler preservation, and provenance boundaries.
- Completion-event delivery.
- Watched-session read-only awareness.
- Standing-intent persistence mechanisms.
- Automation capability itself.
- `sessions_spawn` and explicit delegation capability itself.
- Progress-card storage/UI/capability without ambient maintenance pressure.

## 5. Execution status

These repairs are staged on the branch but have not been claimed as locally executed or test-passing from this room. Run the exact-blob guard checks and application sequence in `scripts/vesper/NEXT-EXECUTION.md` in a real 2026.8.2 checkout.

A failed guard is evidence of source drift. Inspect it rather than weakening the guard.
