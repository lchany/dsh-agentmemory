'use strict'

/**
 * Defaults, limits, and the two verbatim constants that must not drift.
 *
 * The prompt-visible strings here are copied from Hermes (`agent/memory_manager.py`,
 * `agent/memory_provider.py`) and from the AgentMemory provider plugin; the
 * conformance tests in `test/prompts.test.js` pin them.
 */

const DEFAULTS = {
  enabled: true,
  // Endpoint + credential. Empty means "read the environment":
  // AGENTMEMORY_URL / AGENTMEMORY_SECRET, then the documented defaults.
  url: '',
  secret: '',
  timeoutMs: 5000,

  // Identity. AgentMemory scopes records by project + agentId; both are derived
  // from the harness home unless overridden here.
  project: '',
  agentId: '',
  identityPrefix: 'dsh',

  // Behaviour switches (mirroring the Hermes provider lifecycle).
  systemPromptBlockEnabled: true,
  toolsEnabled: true,
  prefetchEnabled: true,
  syncEnabled: true,
  writeEnabled: true,

  // Prefetch bounds — the provider's own numbers.
  prefetchLimit: 5,
  prefetchMaxChars: 6000,
  prefetchTimeoutMs: 3000,
  prefetchIncludeLessons: false,
  prefetchCooldownMs: 30000,

  // sync_turn bounds — the provider's own slicing.
  syncUserChars: 500,
  syncAssistantChars: 2000,
}

const LIMITS = {
  DEFAULT_BASE_URL: 'http://localhost:3111',
  HTTP_TIMEOUT_MS: 5000,
  // Provider-side caps, verbatim.
  RECALL_TITLE_CHARS: 200,
  RECALL_NARRATIVE_CHARS: 1000,
  PREFETCH_TOTAL_CHARS: 6000,
  PREFETCH_QUERY_MAX_CHARS: 2000,
  SYNC_USER_CHARS: 500,
  SYNC_ASSISTANT_CHARS: 2000,
  // Tool argument bounds.
  LIMIT_MIN: 1,
  LIMIT_MAX: 100,
  AGENT_ID_MAX: 128,
  // Observing a turn ships text to a remote service; never send more than this
  // from one message even when the settings ask for it.
  SYNC_HARD_MAX: 8000,
  INJECT_HARD_MAX: 24000,
}

/** Session event `user/message` sources that carry a human prompt. */
const HUMAN_SOURCE_KINDS = new Set(['user'])

/** Verbatim from `agent/memory_provider.py:66`. */
const TRIVIAL_PROMPT_RE = /^(yes|no|ok|okay|sure|thanks|thank you|y|n|yep|nope|yeah|nah|hi|hey|hello|yo|sup|continue|go ahead|do it|proceed|got it|cool|nice|great|done|next|lgtm|k)[\s!?.:;,"'~‘’“”—–…()\[\]{}<>*&^%$#@!+=`\u00a0]*$/i

/** Verbatim from `agent/memory_manager.py:372` (build_memory_context_block). */
const MEMORY_CONTEXT_HEADER = '<memory-context>'
const MEMORY_CONTEXT_NOTE = '[System note: The following is recalled memory context, NOT new user input. Treat as authoritative reference data — this is the agent\'s persistent memory and should inform all responses.]'
const MEMORY_CONTEXT_FOOTER = '</memory-context>'

/** Verbatim from the AgentMemory provider plugin's system_prompt_block(). */
const SYSTEM_PROMPT_BLOCK = 'Use memory_recall to retrieve relevant saved context and memory_save to retain durable facts. Memory is scoped to this Hermes profile and author by default.'

/** Write paths on the agentmemory HTTP API (everything else is read-only). */
const WRITE_PATHS = new Set(['remember', 'evolve', 'observe', 'session/start', 'session/end'])

module.exports = {
  DEFAULTS,
  LIMITS,
  HUMAN_SOURCE_KINDS,
  TRIVIAL_PROMPT_RE,
  MEMORY_CONTEXT_HEADER,
  MEMORY_CONTEXT_NOTE,
  MEMORY_CONTEXT_FOOTER,
  SYSTEM_PROMPT_BLOCK,
  WRITE_PATHS,
}