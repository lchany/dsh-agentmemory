# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- **Settings** — 19 keys in the `agentmemory` namespace, exported as a schemastery `Config` for host
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