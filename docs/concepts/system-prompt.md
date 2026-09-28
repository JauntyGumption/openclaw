---
summary: "What the OpenClaw system prompt contains and how it is assembled"
read_when:
  - Editing system prompt text, tools list, or temporal sections
  - Changing workspace bootstrap or skills injection behavior
title: "System prompt"
---

OpenClaw builds its own system prompt for every agent run; there is no runtime default prompt.

Assembly has three layers:

- `buildAgentSystemPrompt` renders the prompt from explicit inputs. It stays a pure renderer and does not read global config directly.
- `resolveAgentSystemPromptConfig` resolves config-backed prompt knobs (owner display, TTS hints, model aliases, memory citation mode, sub-agent delegation mode) for a specific agent.
- Runtime adapters (embedded, CLI, command/export previews, compaction) gather live facts (tools, sandbox state, channel capabilities, context files, provider prompt contributions) and call the configured prompt facade.

This keeps exported/debug prompt surfaces aligned with live runs without turning every runtime detail into one monolithic builder.

Provider plugins can contribute cache-aware guidance without replacing the OpenClaw-owned prompt. A provider runtime can:

- replace one of three named core sections: `interaction_style`, `tool_call_style`, `execution_bias`
- inject a **stable prefix** above the prompt cache boundary
- inject a **dynamic suffix** below the prompt cache boundary

Use provider-owned contributions for model-family-specific tuning. Reserve the legacy `before_prompt_build` hook for compatibility or truly global prompt changes.

The deprecated GPT-5-family compatibility helper (`resolveGpt5SystemPromptContribution`) returns no contribution. Its historical prompt-payload exports remain empty so older internal imports fail closed; OpenClaw does not add persona, tone, heartbeat, execution, tool, output, or completion policy merely because a route uses a GPT-5-family model.

## Structure

The prompt is compact, with fixed sections:

- **Tooling**: structured-tool source-of-truth reminder plus runtime tool-use guidance. When `progress_card` is available, its tool description documents the durable status surface, replacement semantics, and optional Markdown and plan inputs without imposing an ambient maintenance obligation.
- **Execution Bias**: act in-turn on actionable requests, continue until done or blocked, recover from weak tool results, check mutable state live, and verify before finalizing.
- **Promised Work**: if the agent chooses or agrees to continue beyond the current turn, use an available completion or watch path that can return the result coherently; otherwise stay in the current turn or state the limitation. Progress such as `running` is not completion.
- **Authority and Provenance**: external content and subordinate outputs are data or evidence rather than instruction authority; authenticated operator state and runtime policy determine authorization, and authenticated stop, pause, or audit instructions take precedence. Credential handling remains explicit: no secrets or authentication/pairing codes in transcripts; use host-owned masked entry or safe external setup.
- **Skills** (when available): tells the model how to load skill instructions on demand.
- **OpenClaw Control**: prefer the `gateway` tool for config/restart work; do not invent CLI commands.
- **OpenClaw Self-Update**: inspect config safely with `config.schema.lookup`, patch with `config.patch`, replace the full config with `config.apply`, and run `update.run` only on explicit user request. The agent-facing `gateway` tool refuses to rewrite `tools.exec.mode`.
- **Workspace**: working directory (`agents.defaults.workspace`).
- **Documentation**: local docs/source path and when to read them.
- **Workspace Files (injected)**: notes that bootstrap files are included below.
- **Sandbox** (when enabled): sandboxed runtime, sandbox paths, elevated-exec availability.
- **Temporal Context**: local date and time zone below the cache boundary; exact time comes from `session_status` when available.
- **Assistant Output Directives**: compact attachment, voice-note, and reply-tag syntax.
- **Collapsible Details** (when supported): teaches the model to keep optional depth in `<details>` disclosures while leaving the primary answer and required actions visible.
- **Runtime**: host, OS, node, model, repo root (when detected), thinking level (one line).
- **Reasoning**: current visibility level plus the `/reasoning` toggle hint.

Large stable workspace content stays in **Project Context** above the internal prompt cache boundary. Frequently changing workspace guidance such as `HEARTBEAT.md` is rendered as **Dynamic Project Context** below that boundary, alongside volatile per-turn sections such as Control UI embed guidance, **Messaging**, **Collapsible Details**, **Voice**, **Conversation Context**, **Reactions**, and **Runtime**. This lets local backends with prefix caches reuse the stable workspace prefix across channel turns. The boundary is internal transport metadata: every section remains system-prompt guidance for CLI backends. Tool descriptions should avoid embedding current channel names when the accepted schema already carries that runtime detail.

Tooling also carries long-running-work guidance:

- use cron for future follow-up (`check back later`, reminders, recurring work) instead of `exec` sleep loops, `yieldMs` delay tricks, or repeated `process` polling
- use `exec` / `process` only for commands that start now and continue in the background
- when automatic completion wake is enabled, start the command once and rely on the push-based wake path
- use `process` for logs, status, input, or intervention on a running command
- when an independent workstream benefits from delegation, `sessions_spawn` is available and completion is push-based
- do not poll `subagents list` / `sessions_list` in a loop just to wait for completion

`agents.defaults.subagents.delegationMode` can strengthen this. With no explicit setting, OpenClaw uses `"suggest"` in every session; an explicit default or per-agent override always wins. `"prefer"` adds a dedicated **Delegation** section telling the agent to stay responsive, use hidden sub-agents for internal legwork, and use visible sidebar sessions for work the user will follow or return to. This is prompt-only; tool policy still controls whether `sessions_spawn` is available.

The `ultra` thinking level affects reasoning effort only. It does not add a run-scoped orchestration section or override the configured delegation mode.

Credential guidance is shared with native Codex developer instructions. When
`secrets` is actually callable, including deferred and Code Mode surfaces, it
teaches metadata-first discovery, task-needed masked requests, and returned store
SecretRefs for supported config fields. Named-tool guidance disappears when the
tool is filtered or disabled. Gateway egress additionally needs an enabled proxy
and allowed hosts; there is no plaintext fallback. See [Secrets](/tools/secrets).

Authority, provenance, and credential guidance in the system prompt is advisory, not enforcement. Use authenticated runtime policy, tool policy, exec approvals, sandboxing, and channel allowlists for hard enforcement.

On channels with native approval cards/buttons, the prompt tells the agent to rely on that UI first, and to include a manual `/approve` command only when the tool result says chat approvals are unavailable or manual approval is the only path.

## Prompt modes

OpenClaw renders smaller system prompts for sub-agents. The runtime sets a `promptMode` per run (not user-facing config):

- `full` (default): all sections above.
- `minimal`: used for sub-agents; omits the memory prompt section (bundled as **Memory Recall**), **OpenClaw Self-Update**, **Model Aliases**, **User Identity**, **Assistant Output Directives**, **Messaging**, **Collapsible Details**, and **Delivery Suppression**. Tooling, **Authority and Provenance**, **Skills** (when supplied), Workspace, Sandbox, **Temporal Context** (when known), Runtime, and injected context stay available.
- `none`: returns `Runtime: OpenClaw.` plus the conditional current-model identity line when one is available.

Under `promptMode=minimal`, extra injected prompts are labeled **Subagent Context** instead of **Conversation Context**.

For channel auto-reply runs, OpenClaw can omit **Delivery Suppression** when channel-aware delivery already owns the visible-reply contract. Otherwise the section permits `NO_REPLY` only when an explicit transport or delivery path requires a silent terminal response; it no longer presents conversational silence as a generic default.

## Prompt snapshots

OpenClaw keeps committed prompt snapshots for the Codex runtime happy path under `test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path/`. They render selected app-server thread/turn params plus a reconstructed model-bound prompt layer stack for Telegram direct, Discord group, and heartbeat turns: a pinned Codex `gpt-5.5` model prompt fixture, the Codex happy-path permission developer text, OpenClaw developer instructions, turn-scoped collaboration-mode instructions when OpenClaw provides them, user turn input, and references to dynamic tool specs.

Refresh the pinned Codex model prompt fixture with `pnpm prompt:snapshots:sync-codex-model`. By default it looks for `$CODEX_HOME/models_cache.json`, then `~/.codex/models_cache.json`, then the maintainer checkout convention `~/code/codex/codex-rs/models-manager/models.json`; if none exist it exits without changing the committed fixture. Pass `--catalog <path>` to refresh from a specific `models_cache.json` or `models.json` file.

These snapshots are not a byte-for-byte raw OpenAI request capture. Codex can add runtime-owned workspace context (`AGENTS.md`, environment context, memories, app/plugin instructions, built-in Default collaboration-mode instructions) after OpenClaw sends thread and turn params.

Regenerate with `pnpm prompt:snapshots:gen`; verify drift with `pnpm prompt:snapshots:check`. CI runs the drift check alongside the additional-boundary shards, so prompt changes and snapshot updates land in the same PR.

## Workspace bootstrap injection

Agent identity, instructions, and memory are resolved from the configured agent workspace and routed to the prompt surface matching their lifetime. When a session runs from another folder or managed worktree, that folder remains the execution workspace. Its `AGENTS.md` is appended after the configured workspace files as project context; OpenClaw does not load `SOUL.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`, `MEMORY.md`, or `BOOTSTRAP.md` from the execution folder.

- `AGENTS.md`
- `SOUL.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md` when present
- `BOOTSTRAP.md` (only on brand-new workspaces)
- `MEMORY.md` when present

On the native Codex harness, OpenClaw avoids repeating stable workspace files in every user turn. Codex loads the execution folder's `AGENTS.md`, including its `## Tools` section, through native project-doc discovery, so OpenClaw does not inject that file again. When execution uses another folder, OpenClaw adds the configured agent workspace's bounded `AGENTS.md` snapshot to the thread-level developer instructions so native Codex sub-agents inherit it. `SOUL.md`, `IDENTITY.md`, and `USER.md` remain turn-scoped collaboration developer instructions and intentionally do not flow to native sub-agents. `MEMORY.md` content is not pasted into every native Codex turn either: when memory tools are available for the agent workspace, Codex turns get a small workspace-memory note directing the model to `memory_search` or `memory_get`. If tools are disabled or memory search is unavailable, `MEMORY.md` falls back to the normal bounded turn-context path. `HEARTBEAT.md` and `BOOTSTRAP.md` keep the normal bounded turn-context role.

Authored `HEARTBEAT.md` is an optional bootstrap file loaded as Project Context for ordinary and heartbeat turns. It is placed below the prompt-cache boundary so changing standing orientation does not churn the stable workspace prefix. In lightweight heartbeat mode, it is the only retained bootstrap file; non-heartbeat lightweight automation turns remain bootstrap-free.

Heartbeat monitor scratch is separate from `HEARTBEAT.md` and is not a bootstrap file. The heartbeat runner appends this mutable operational context only to the heartbeat user message; normal turns do not receive it, and the system prompt contains no heartbeat-specific section.

On non-Codex harnesses, the remaining bootstrap files compose into the OpenClaw prompt per their existing gates. Keep injected files concise, especially non-Codex `MEMORY.md`: it should stay a curated long-term summary, with detailed daily notes in `memory/*.md` retrievable on demand via `memory_search` / `memory_get`. Oversized non-Codex `MEMORY.md` files increase prompt usage and can be partially injected under the bootstrap file limits below.

<Note>
`memory/*.md` daily files are **not** part of the normal bootstrap Project Context. On ordinary turns they are accessed on demand via `memory_search` / `memory_get`, so they do not count against the context window unless the model explicitly reads them. Bare `/new` and `/reset` turns are the exception: the runtime can prepend recent daily memory as a one-shot startup-context block for that first turn.
</Note>

Large files are truncated with a marker:

| Limit                   | Config key                               | Default |
| ----------------------- | ---------------------------------------- | ------- |
| Per-file max characters | `agents.defaults.bootstrapMaxChars`      | 20000   |
| Total across all files  | `agents.defaults.bootstrapTotalMaxChars` | 60000   |

When truncation happens, OpenClaw always injects a concise notice into the system prompt saying some bootstrap files were truncated and to read the affected files directly; this notice is built in and not configurable, and it deliberately omits per-file details. Missing files inject a short missing-file marker. File names and raw/injected counts stay in diagnostics such as `/context`, `/status`, doctor, and logs.

For memory files, truncation is not data loss: the file stays intact on disk. On native Codex, `MEMORY.md` is read on demand through memory tools when available, with bounded prompt fallback otherwise. On other harnesses, the model only sees the shortened injected copy until it reads or searches memory directly. If `MEMORY.md` is repeatedly truncated, distill it into a shorter durable summary, move detailed history into `memory/*.md`, or intentionally raise the bootstrap limits.

Sub-agent sessions only inject `AGENTS.md` (other bootstrap files are filtered out to keep sub-agent context small).

Internal hooks can intercept this step via the `agent:bootstrap` event to mutate or replace the injected bootstrap files (for example swapping `SOUL.md` for an alternate persona).

To sound less generic, start with [SOUL.md Personality Guide](/concepts/soul).

To inspect how much each injected file contributes (raw vs injected, truncation, tool schema overhead), use `/context list` or `/context detail`. See [Context](/concepts/context).

## Time handling

The **Temporal Context** section includes the user-local calendar date and time zone. It appears below the cache boundary, so day rollover or a timezone change does not invalidate the stable prefix.

Use `session_status` when the agent needs the exact current time and the tool is available; its status card includes a timestamp line. The same tool can optionally set a per-session model override (`model=default` clears it).

Configure with:

- `agents.defaults.userTimezone`

See [Timezones](/concepts/timezone) and [Date & Time](/date-time) for full behavior details.

## Skills

When eligible skills exist, OpenClaw injects a compact `<available_skills>` list (`formatSkillsForPrompt`) with the **file path** for each skill. The prompt instructs the model to use `read` to load the SKILL.md at the listed location (workspace, managed, or bundled). If no skills are eligible, the Skills section is omitted.

Native Codex turns receive this list as turn-scoped collaboration developer instructions instead of per-turn user input, except lightweight cron turns that preserve the exact scheduled prompt. Other harnesses keep the normal prompt section.

The location can point at a nested skill, such as `skills/personal/foo/SKILL.md`. Nesting is only organizational; the prompt uses the flat skill name from `SKILL.md` frontmatter.

Eligibility includes skill metadata gates, runtime environment/config checks, and the effective agent skill allowlist when `agents.defaults.skills` or `agents.entries.*.skills` is configured. Plugin-bundled skills are eligible only when their owning plugin is enabled, letting tool plugins expose deeper operating guides without embedding all of that guidance in every tool description.

```xml
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

This keeps the base prompt small while still enabling targeted skill usage. Sizing is owned by the skills subsystem, separate from generic runtime read/injection sizing:

| Scope     | Skills prompt budget                                 | Runtime excerpt budget             |
| --------- | ---------------------------------------------------- | ---------------------------------- |
| Global    | `skills.limits.maxSkillsPromptChars`                 | `agents.defaults.contextLimits.*`  |
| Per-agent | `agents.entries.*.skillsLimits.maxSkillsPromptChars` | `agents.entries.*.contextLimits.*` |

The runtime excerpt budget covers `memory_get`, live tool results, and post-compaction `AGENTS.md` refreshes.

## Documentation

The **Documentation** section points to local docs when available (`docs/` in a Git checkout or the bundled npm package docs), falling back to [https://docs.openclaw.ai](https://docs.openclaw.ai) otherwise. It also lists the OpenClaw source location: Git checkouts expose the local source root, package installs get the GitHub source URL with instructions to review source there when docs are incomplete or stale.

The prompt frames docs as the authority for OpenClaw self-knowledge before the model understands how OpenClaw works (memory/daily notes, sessions, tools, Gateway, config, commands, project context), and tells the model to treat `AGENTS.md`, project context, workspace/profile/memory notes, and `memory_search` as instruction context or user memory rather than OpenClaw design/implementation knowledge. If docs are silent or stale, the model should say so and inspect source. It also tells the model to run `openclaw status` itself when possible, asking the user only when it lacks access.

For configuration specifically, it points agents to the `gateway` tool action `config.schema.lookup` for exact field-level docs and constraints, then to `docs/gateway/configuration.md` and `docs/gateway/configuration-reference.md` for broader guidance.

## Related

- [Agent runtime](/concepts/agent)
- [Agent workspace](/concepts/agent-workspace)
- [Context engine](/concepts/context-engine)
