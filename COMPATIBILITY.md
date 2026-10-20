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
| `src/mirror.js` `mirrorMemoryWrite` | provider `on_memory_write()` (`:598`) | hash-keyed ownership ledger, evolve-on-replace, warn-once when ownership is not established |

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
| D3 | Recall is appended to the batch at `agent/pre-step` as its own logged message (`source.kind: "agentmemory"`, `form: "recall"`) instead of to the user message's API copy | DSH exposes no request-rewrite hook (`agent/request` "cannot mutate messages"), but pre-step may add messages to the batch it commits, so the recall rides the same request as the prompt, as in Hermes (`agent/turn_context.py:119`). It stays in the transcript, where Hermes keeps it only in the API copy. The wait is capped at 8 s (`_EXTERNAL_PREFETCH_TIMEOUT_S`); a timeout skips recall for the turn. |
| D4 | The identity hash always uses `"local"` for the platform slot | The provider substitutes a platform name only when an author is threaded through; DSH `SessionHeader` carries no author or platform field (only `origin`), so there is nothing to thread. `resolveAgentId` still accepts an author for a host that gains one. |
| D5 | `on_pre_compress` is not ported | Hermes passes its text to the compressor as `memory_context` and, when the engine does not accept it, continues without it (`agent/conversation_compression.py:2965`). DSH appends `compaction/*` as log-only session events and the only compaction waterfall (`compaction/summary-error`) runs on failure, so there is no prompt seam. Recall blocks are already in the transcript, so a summary carries them. |
| D6 | Tool/block gating uses the plugin's own `toolsEnabled` / `systemPromptBlockEnabled` settings | Hermes ties both to the `memory` toolset. DSH toolset names are not exposed to host-plane plugins, so the switches are explicit instead of implicit. |
| D7 | `writeEnabled` plus DSH's `meta.origin: "subagent"` replace the provider's `agent_context == "primary"` | Host-plane plugins see every session, including subagents. Every write path (`session/start`, `observe`, `remember`/`evolve` tools, `session/end`) and the pre-step recall are skipped for `origin: "subagent"` (Hermes builds those agents with `skip_memory=True`); an unset origin counts as primary. The `hermes-evolve/memory-write` event carries no session identity, so mirroring is gated only by `writeEnabled` / `mirrorBuiltinMemory`; `dsh-hermes-evolve` is the only emitter. |
| D8 | Direct HTTP instead of the MCP bridge | The bridge works (verified: 54 tools, 24 KB of schemas ≈ 8k tokens per request), but a plugin that already runs in-process does not need a second process or the schema payload. |
| D9 | A mismatched `session/start` response is not cached; the plugin warns once per scoped id and keeps the turn fail-open | Aligned with the provider (`__init__.py:265-268`), which caches the session only when `session.id == scoped`. Nothing is cached for a mismatched answer; the next turn retries `session/start`. (`sync_turn` still sends `observe` with the scoped id, exactly as the provider does after a failed start.) |

## Not ported

- `on_delegation` (mirroring a delegate's transcript into the provider). DSH has no equivalent
  delegation hook on the agent event plane.
- `on_turn_start`'s author attribution and queued-prefetch cache (`__init__.py:352-355`). DSH
  sessions have no message author, and DSH recall is fetched at pre-step rather than from a manually primed
  queue; the session bookkeeping that `on_turn_start` also covers is kept on the human-prompt and
  `turn/end` paths.
- The provider's opt-in plaintext-bearer **refusal** (`AGENTMEMORY_REQUIRE_HTTPS=1`). This plugin
  always matches the provider's default: warn once and proceed. A deployment that needs refusal must
  enforce it at the endpoint (TLS terminator or network policy).

Everything else in the provider's hook surface is mapped:

| Provider hook | DSH seam | Status |
|---|---|---|
| `on_turn_start` | `session/event` `user/message` + `turn/end` | session open kept; author/cache deliberately skipped |
| `prefetch` | `agent/pre-step` (claimed human message) | ported; same request as the prompt (see D3) |
| `sync_turn` | `session/event` `turn/end` (`reason.kind == "completed"`) | ported |
| `on_session_end` | `session/disposed`, `agent/disposed`, plugin disposal | ported, idempotent per scoped id |
| `on_session_switch` | `agent/created` (`startup` / `resume` / `clear` / `compact`) | ported; closes the previous scoped session first |
| `on_pre_compress` | none | not ported (see D5) |
| `on_memory_write` | `hermes-evolve/memory-write` | ported (`src/mirror.js`) |
| `shutdown` | `ctx.effect` cleanup | ported (best-effort `session/end`) |

## Re-checking

```bash
npm test          # 51 tests
npm run check     # syntax, schemas, verbatim strings, manifest
```

Open the cited Hermes/provider files side by side with `src/` — every string in this page is meant to
be findable there by search, not by trust.