# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Closes the lifecycle deviations left open in 0.1.0. Every write still fails open; the provider's
verbatim strings, schemas, digests, fence, and error codes are unchanged.

### Added

- **Lifecycle parity** — `on_session_end` runs exactly once per opened scoped session, on
  `session/disposed`, `agent/disposed`, or plugin disposal (idempotent, confirmed by the server before
  the scoped id is marked closed). `on_session_switch` runs on `agent/created` for
  `startup` / `resume` / `clear` / `compact`: the previous scoped session is closed, then the new one
  opened. Implemented in `src/index.js` (`startSession`, `endScoped`, `endSessionState`, the
  `agentmemory: lifecycle` effect).
- **Subagent write gating** — sessions whose header carries `origin: "subagent"` never call
  `session/start`, `observe`, `session/end`, or the `remember` / `evolve` tools; the tool envelope
  uses the provider's `read_only_context` error. `writeEnabled` still switches every write path.
- **Native memory mirroring** — `hermes-evolve/memory-write` rows are mirrored through
  `src/mirror.js` (hash-keyed ownership ledger, evolve-on-replace, warn-once when ownership is not
  established). `mirrorBuiltinMemory` (default `true`) controls the subscription.
- **Tests** — 57 tests: the two pre-existing failures are fixed, plus coverage for session disposal
  (once), resume/clear switching (end before start), mismatched `session/start` (warn once, retry),
  subagent read-only behaviour, and the pre-step recall (same-request delivery, skip on timeout or
  abort, no recall for subagent sessions, retry after a failure, recall on every turn, no recall
  from `user/message` or `compaction/start`).

### Changed

- **Recall now enters the same request as the prompt.** It is fetched inside `agent/pre-step` from
  the claimed human message and appended to the batch the loop is about to commit
  (`source: {kind: "agentmemory", form: "recall"}`), so the model sees it on the first step. The old
  path started the search on the `user/message` event, which the loop emits only after pre-step, so it
  could never land on step 1. The wait is capped at 8 s (Hermes' `_EXTERNAL_PREFETCH_TIMEOUT_S`) and is
  also bounded by `prefetchTimeoutMs` and the step's abort signal; on timeout or error the turn goes
  ahead without recall and a late answer is dropped, as in Hermes.
- **Recall follows Hermes' per-agent gating.** Sessions with `origin: "subagent"` (delegates and
  review forks, which DSH marks the same way) get no recall, matching `skip_memory=True` in
  `tools/delegate_tool.py:279`, `agent/background_review.py:915-927` and `agent/curator.py:1119`.
  A failed prefetch no longer pins the prompt: the next turn asks again, and an identical prompt on
  a later turn recalls again because Hermes prefetches once per turn.
- **Removed the `compaction/start` recall (`on_pre_compress` stand-in).** Hermes hands that text to the
  compressor as `memory_context` and continues without it when the engine does not accept one;
  `dsh-compaction-basic` has no such parameter (see D5).
- `agent_context == "primary"` parity now rides on DSH's `meta.origin` (D7) instead of a bare
  `writeEnabled` switch.
- A mismatched `session/start` response is no longer used or cached: the plugin warns once and stays
  fail-open, matching the provider (D9).
- The config schema now declares `mirrorBuiltinMemory`, so the schema and the sanitizer agree.

### Fixed

- The pre-existing `node --test test/` failures: the schema/sanitizer field mismatch and the
  disposal test timing out because a scoped session was only opened during prefetch. Session
  bookkeeping now starts on the human prompt path, independent of `prefetchEnabled`.
- `COMPATIBILITY.md`: `on_memory_write` is ported, the plaintext-bearer guard is warn-only by
  default (`AGENTMEMORY_REQUIRE_HTTPS=1` is the provider's opt-in refusal), and the event mapping is
  listed hook by hook.

## [0.1.0] — 2026-10-20

First release: the external memory layer of Hermes (`MemoryProvider` + the AgentMemory provider
plugin), ported to DeepSeek Harness.

### Added

- **Prompt block** — the provider's static `system_prompt_block()` injected as a system-prompt
  section (`agentmemory:guidance`, order 52), switchable via `systemPromptBlockEnabled`.
- **Recall prefetch** — on each human prompt: `smart-search` → `expandIds` → `- title: narrative`
  rows, sliced at 200 / 1000 / 6000 chars, wrapped in the verbatim `<memory-context>` fence
  (`agent/memory_manager.py:372`), and delivered with `agent.inject()`. Trivial prompts, slash
  commands, repeated prompts, and in-flight recalls are skipped.
- **Turn sync** — after a `completed` turn, `observe` with `hookType: post_tool_use`,
  `tool_input: user[:500]`, `tool_output: assistant[:2000]`, and a UTC timestamp.
- **Tools** — `memory_recall` (`search`), `memory_save` (`remember`), `memory_search`
  (`smart-search`), with the provider's schemas, defaults, and argument error strings.
- **Identity** — `<prefix>-<sha256[:32]>` agent ids, digest-scoped session ids, project resolution
  (setting → env → git root → cwd), and `session/start` bookkeeping.
- **Settings** — 20 keys in the `agentmemory` namespace, exported as a schemastery `Config` for host
  auto-discovery; endpoint and secret fall back to `AGENTMEMORY_URL` / `AGENTMEMORY_SECRET`.
- **Fail-open everywhere** — `authentication` / `http_error` / `unavailable` are logged, never thrown;
  a slow recall is bounded by `prefetchTimeoutMs`.
- **Tests** — 38 tests over tool validation, HTTP error mapping, the fence and dedupe rules, digest
  shapes, settings sanitization, and the full event → prefetch → inject / turn → observe paths.
  `npm run check` verifies syntax, the verbatim strings, and the manifest.
- **Docs** — `README.md` and `COMPATIBILITY.md` (module map, invariants, 9 deliberate deviations, and
  what is not ported).

### Notes

- Requires Node.js ≥ 22.5 and DeepSeek Harness ≥ 0.2.0-rc.2.
- The recall block reaches the model through `agent.inject()`; DSH has no request-rewrite hook, so it
  can land after the first step of a turn. See deviation D3 in `COMPATIBILITY.md`.