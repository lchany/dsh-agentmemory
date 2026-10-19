# Compatibility with the Hermes AgentMemory provider

This plugin is a port, not an interpretation. The baseline is:

- **Provider plugin**: `~/.hermes/plugins/agentmemory/__init__.py`, AgentMemory provider v0.9.30
  (`rohitg00/agentmemory`, the plugin Hermes loads through `memory.provider: agentmemory`).
- **Host side**: `NousResearch/hermes-agent@d923a5eb48` (v0.22.2), files
  `agent/memory_provider.py`, `agent/memory_manager.py`, `agent/turn_context.py`.

Every item below can be re-checked locally by opening the cited file and line.

## Module map

| This package | Source | What is copied |
|---|---|---|
| `src/const.js` `SYSTEM_PROMPT_BLOCK` | provider `system_prompt_block()` (`__init__.py:388`) | the sentence, verbatim |
| `src/const.js` `MEMORY_CONTEXT_HEADER/NOTE/FOOTER` | `agent/memory_manager.py:372` | fence tags + system note, verbatim |
| `src/const.js` `TRIVIAL_PROMPT_RE` | `agent/memory_provider.py:66` | the skip list, verbatim |
| `src/const.js` `WRITE_PATHS` | provider `_request` write set | `remember`, `evolve`, `observe`, `session/start`, `session/end` |
| `src/prefetch.js` `prefetchRecall` | provider `prefetch()` (`:391`) | `smart-search` (limit 5, `includeLessons:false`, project+agentId) → `expandIds` → 5 rows |
| `src/prefetch.js` `formatRecallRows` | provider `prefetch()` | `- {title[:200]}: {narrative[:1000]}`, joined and cut at 6000 chars |
| `src/prefetch.js` `buildMemoryContextBlock` | `agent/memory_manager.py:372` | emptiness check **before** sanitization, then sanitize → dedupe → wrap |
| `src/prefetch.js` `sanitizeContext` | `agent/memory_manager.py:157-174` | the three regexes (`_INTERNAL_CONTEXT_RE`, `_INTERNAL_NOTE_RE`, `_FENCE_TAG_RE`) |
| `src/prefetch.js` `dropRepeatedRecallLines` | `agent/memory_manager.py:323-368` | bullet regex `[-*+]\s+\S`, continuation lines never deduped, headings reset the scope |
| `src/prefetch.js` `observePayload` | provider `sync_turn()` (`:532`) | `hookType: post_tool_use`, `tool_name: conversation`, `tool_input: user[:500]`, `tool_output: assistant[:2000]`, UTC `timestamp` |
| `src/tools.js` three schemas | provider `get_tool_schemas()` (`:439-530`) | names, descriptions, JSON Schema, defaults (`recall` 10 → `search`, `search` 5 → `smart-search`, `save` → `remember`) |
| `src/tools.js` validation | provider `handle_tool_call()` | `content`/`query` non-empty, `limit` integer in 1..100, `agentId` ≠ `*` and ≤128 chars, `targetLayer` enum, CSV→deduped list |
| `src/identity.js` `deriveAgentId` | provider `_agent_id` | `<prefix>-<sha256(json([home, "local", author]))[:32]>` |
| `src/identity.js` `scopedSessionId` | provider `_scoped_session_id` | `<prefix>-<sha256(json([home, agentId, sessionId]))>` |
| `src/identity.js` `sessionPayload` | provider `_session_payload` | `{sessionId, project, cwd, agentId}` |
| `src/util.js` `resolveProject` | provider `_resolve_project` | env → git toplevel basename → cwd basename |
| `src/http.js` error codes | provider `_api` | `authentication` (401/403), `http_error`, `unavailable`; no redirect following |

## Invariants pinned by tests

- The prompt block string and all three tool schemas (`test/index.test.js`, `test/tools.test.js`).
- The `<memory-context>` fence, byte for byte, including the sanitizer's quirks
  (`test/prefetch.test.js`).
- `observe` slicing at 500 / 2000 chars and the UTC timestamp format.
- The digest shapes (`^dsh-[0-9a-f]{32}$`, `^dsh-[0-9a-f]{64}$`) and the "never forward a raw session
  id" rule.
- Fail-open on `unavailable`, `http_error`, and `authentication` (`test/http.test.js`,
  `test/index.test.js`).

## Deviations (deliberate, and why)

| # | Deviation | Reason |
|---|---|---|
| D1 | Python → JavaScript | The host is Node; behaviour is matched, not code shape. |
| D2 | Identity stem defaults to `dsh-` and hashes the DSH home, where the provider uses `hermes-` and the Hermes home | Different harness, different bucket. Set `identityPrefix: "hermes"` and `agentId` to the provider's value to *share* a bucket deliberately. |
| D3 | Recall reaches the model through `agent.inject()` (queued for the next pre-step) instead of appending to the user message's API copy | DSH exposes no request-rewrite hook. Hermes' `api_content` sidecar exists to keep the transcript clean; `inject` achieves the same visibility split, at the cost of possibly landing after the first step. |
| D4 | The identity hash always uses `"local"` for the platform slot | The provider substitutes a platform name only when an author is threaded through; DSH sessions carry no author today. |
| D5 | No `on_pre_compress`, `on_session_switch`, `on_session_end` hooks | DSH removes messages via compaction events the plugin cannot rewrite; recall therefore runs on human prompts only, and `session/end` is never called. |
| D6 | Tool/block gating uses the plugin's own `toolsEnabled` / `systemPromptBlockEnabled` settings | Hermes ties both to the `memory` toolset. DSH toolset names are not exposed to host-plane plugins, so the switches are explicit instead of implicit. |
| D7 | `writeEnabled` guards every write path, without the provider's `agent_context == "primary"` distinction | Host-plane plugins see every session, including subagents. The guard is the equivalent safety, expressed as a switch. |
| D8 | Direct HTTP instead of the MCP bridge | The bridge works (verified: 54 tools, 24 KB of schemas ≈ 8k tokens per request), but a plugin that already runs in-process does not need a second process or the schema payload. |
| D9 | A mismatched `session/start` response only logs a warning | The provider refuses to cache the session; failing the turn over a bookkeeping mismatch would be worse for the user. |

## Not ported

- `on_memory_write` mirroring (the provider copies built-in `MEMORY.md` writes into its own store,
  hash-keyed by `[base, project, agentId, home, target, content]`). `dsh-hermes-evolve` owns the
  built-in layer; wiring the two together is its job, not this package's.
- `on_delegation`, `on_turn_start`, `on_session_switch` hooks.
- The plaintext-bearer **refusal** (the provider refuses to send a secret over non-loopback http). This
  plugin warns once and proceeds, because a self-hosted LAN server is a normal deployment here.
- `session/end` on shutdown: the server's own session TTL handles it.

## Re-checking

```bash
npm test          # 38 tests
npm run check     # syntax, schemas, verbatim strings, manifest
```

Open the cited Hermes/provider files side by side with `src/` — every string in this page is meant to
be findable there by search, not by trust.