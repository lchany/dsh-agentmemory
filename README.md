# dsh-agentmemory

AgentMemory as a persistent-memory provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Hermes Agent runs memory in two layers: the built-in `MEMORY.md` / `USER.md` core, and at most one
external `MemoryProvider` plugin. This package ports the *external* layer — the
[AgentMemory](https://github.com/rohitg00/agentmemory) provider plugin — into DSH: the same static
prompt block, the same recall-before-the-turn prefetch, the same `observe` on a finished turn, and the
same three tools.

It is a behaviour port, not a wrapper: nothing here proxies MCP. The plugin talks to the AgentMemory
HTTP API directly, so no stdio server, no 54-tool schema payload, and no extra process per turn.

## What it does

| Behaviour | When | Effect |
|---|---|---|
| **Prompt block** | once per request | `Use memory_recall to retrieve relevant saved context and memory_save to retain durable facts…` |
| **Recall prefetch** | on each human prompt | `smart-search` → `expandIds` → inject a fenced `<memory-context>` block |
| **Turn sync** | after a `completed` turn | `observe` the exchange so the server can distill it |
| **Tools** | always (can be disabled) | `memory_recall`, `memory_save`, `memory_search` |

Everything is **fail-open**: an unreachable server logs a warning and the turn proceeds. Memory is a
bonus, never a dependency.

## Provenance

Ported from, and diffed against:

- `~/.hermes/plugins/agentmemory/__init__.py` v0.9.30 — the provider plugin (`prefetch`, `sync_turn`,
  tool schemas, argument validation, identity derivation, session payload).
- `hermes-agent` `agent/memory_provider.py:84` — the `MemoryProvider` lifecycle this fills.
- `hermes-agent` `agent/memory_manager.py:372` — `build_memory_context_block`, copied byte for byte
  (fence tags, system note, sanitize pass, bullet dedupe).
- `hermes-agent` `agent/memory_manager.py:117` — tool injection gated by the `memory` toolset.

See [COMPATIBILITY.md](COMPATIBILITY.md) for the line-by-line map and every deliberate deviation.

## Requirements

- Node.js ≥ 22.5 (uses the global `fetch`).
- DeepSeek Harness ≥ 0.2.0-rc.2.
- A reachable AgentMemory server (`AGENTMEMORY_URL`, default `http://localhost:3111`) and its bearer
  secret (`AGENTMEMORY_SECRET`).

## Install

From GitHub:

```bash
dsh plugin --profile web add github:YOUR_GITHUB_USER/dsh-agentmemory
```

Then add the bundle to the same profile's `package.json`:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["…", "dsh-agentmemory"]
    }
  }
}
```

From a local checkout:

```bash
dsh plugin --profile web add file:/path/to/dsh-agentmemory
```

A patch layer also works for a trial run without touching the profile:

```yaml
# /tmp/agentmemory.patch.yml
- insert:
    - id: agentmemory
      name: 'dsh-agentmemory'
```

```bash
dsh --profile web --patch /tmp/agentmemory.patch.yml --port 3099 --no-open
```

## Configure

Settings live in the `agentmemory` namespace. Empty endpoint/secret values fall back to the
environment, then to the documented default.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch |
| `url` | `""` → `AGENTMEMORY_URL` → `http://localhost:3111` | Server base URL (http/https, no credentials/query/fragment) |
| `secret` | `""` → `AGENTMEMORY_SECRET` | Bearer token |
| `timeoutMs` | `5000` | Per-request timeout for tools |
| `project` | `""` → `AGENTMEMORY_PROJECT_NAME` → git root name → cwd name | Project scope |
| `agentId` | `""` → derived | Agent identity (`<prefix>-<sha256[:32]>`) |
| `identityPrefix` | `dsh` | Prefix for the derived identity and scoped session ids |
| `systemPromptBlockEnabled` | `true` | Inject the static prompt block |
| `toolsEnabled` | `true` | Register the three tools |
| `prefetchEnabled` | `true` | Recall before the turn |
| `syncEnabled` | `true` | `observe` after a completed turn |
| `writeEnabled` | `true` | Allow write paths (`session/start`, `observe`, …) |
| `prefetchLimit` | `5` | Candidates requested from `smart-search` |
| `prefetchMaxChars` | `6000` | Cap on the recall text |
| `prefetchTimeoutMs` | `3000` | Recall budget (a slow server never blocks the turn) |
| `prefetchIncludeLessons` | `false` | Forwarded as-is; the provider passes `false` |
| `prefetchCooldownMs` | `30000` | Minimum gap between recalls in one session |
| `syncUserChars` / `syncAssistantChars` | `500` / `2000` | Slicing for `observe` |

## How recall is injected

Hermes appends the recall to the user message's **API copy** (`agent/turn_context.py:119`,
`compose_user_api_content`) and keeps the transcript clean with an `api_content` sidecar. DSH has no
request-rewrite hook, so this plugin uses the closest equivalent: `agent.inject()` — model-facing
context queued for the next pre-step. The model still sees the block in the same turn; it may arrive
after the first step instead of before it. That timing difference is the one honest deviation, and it
is listed as D3 in [COMPATIBILITY.md](COMPATIBILITY.md).

The injected message carries `source.kind = "agentmemory"`, so a transcript can tell it apart from a
human prompt.

## Tools

| Tool | API path | Notes |
|---|---|---|
| `memory_recall` | `search` | Keyword search; `limit` default 10 |
| `memory_save` | `remember` | Types: `pattern`, `preference`, `architecture`, `bug`, `workflow`, `fact` |
| `memory_search` | `smart-search` | Hybrid semantic + keyword; `limit` default 5 |

Schemas, descriptions, and argument errors are copied from the provider plugin; a caller sees the same
messages Hermes produced.

## Verify

```bash
# the plugin declares itself at boot
dsh headless "say ok" 2>&1 | grep agentmemory
# [agentmemory] active — url=http://localhost:3111 project=repo

# the tools are on the surface
curl -s http://127.0.0.1:3080/hermes-evolve/api/status   # if dsh-hermes-evolve is also installed
```

`dsh-hermes-evolve`'s panel reports `tools.mcpServers` and `tools.names`, which is the quickest way to
confirm that `memory_recall` / `memory_save` / `memory_search` are registered.

## Develop

```bash
npm test        # 38 tests, no network, no host
npm run check   # syntax + schema + provenance invariants
```

Layout:

```
src/
  index.js      plugin entry: settings, prompt section, tools, session events
  const.js      defaults, limits, verbatim prompt-visible strings
  config.js     sanitizeConfig + the schemastery form
  http.js       POST <base>/agentmemory/<path>, bearer auth, error codes
  identity.js   endpoint + agentId + scoped session id derivation
  tools.js      the three tool schemas and argument validation
  prefetch.js   recall formatting, the <memory-context> fence, observe payload
test/           tool/http/prefetch/identity/config/index suites
```

## Licence

MIT.