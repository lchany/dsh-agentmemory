'use strict'

/**
 * dsh-agentmemory — AgentMemory as a DSH memory provider.
 *
 * Hermes runs memory in two layers: the built-in MEMORY.md/USER.md core, plus at
 * most one external `MemoryProvider` plugin (`agent/memory_provider.py:84`).
 * This plugin ports the external layer's *behaviour*, not just its tools:
 *
 *   1. a static `system_prompt_block()` telling the model how to use memory;
 *   2. `prefetch()` — recall before the turn and inject a fenced
 *      `<memory-context>` block (built by the same sanitizer/deduper Hermes uses);
 *   3. `sync_turn()` — after a finished turn, `observe` the exchange so the
 *      server can distill it into long-term observations;
 *   4. the three tools `memory_recall` / `memory_save` / `memory_search`.
 *
 * The service is fail-open everywhere: an unreachable server must never break a
 * turn, so every hook catches and logs instead of throwing.
 */

const { randomUUID } = require('node:crypto')

const { DEFAULTS, LIMITS, SYSTEM_PROMPT_BLOCK, TRIVIAL_PROMPT_RE } = require('./const')
const { sanitizeConfig, settingsSchema } = require('./config')
const util = require('./util')
const http = require('./http')
const identity = require('./identity')
const tools = require('./tools')
const prefetch = require('./prefetch')
const mirror = require('./mirror')

const SETTINGS_NS = 'agentmemory'
const PLUGIN = 'agentmemory'
const SETTINGS_EVENT = 'settings/document-updated'

let schemastery = null
try {
  schemastery = require('@deepseek-ai/schemastery')
} catch {
  // Without the schema the plugin still works; the host just shows no form.
  schemastery = null
}

/** Exported at module level: the host discovers `Config` by symbol. */
const Config = schemastery !== null ? settingsSchema(schemastery) : undefined

function pickLogger (ctx) {
  try {
    if (ctx && ctx.logger && typeof ctx.logger === 'object') return ctx.logger
  } catch { /* no logger */ }
  return {
    info: (...args) => console.log(...args),
    warn: (...args) => console.warn(...args),
    debug: () => {},
  }
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorText (error) {
  if (error === null || error === undefined) return 'unknown error'
  if (typeof error === 'string') return error
  return typeof error.message === 'string' ? error.message : String(error)
}

function apply (ctx, config = {}) {
  const logger = pickLogger(ctx)
  const settings = { ...DEFAULTS, ...sanitizeConfig(config) }
  const home = util.dshHome()

  // ── settings ────────────────────────────────────────────────────────────
  const refreshLive = () => {
    try {
      const descriptor = ctx.settings.describe().find((entry) => entry.ns === SETTINGS_NS)
      if (descriptor !== undefined && descriptor.value !== null && typeof descriptor.value === 'object') {
        Object.assign(settings, sanitizeConfig(descriptor.value))
      }
    } catch { /* settings not ready yet */ }
  }
  refreshLive()
  void (async () => {
    // The projection may not exist at apply time; retry like the other plugins.
    for (let attempt = 0; attempt < 15; attempt += 1) {
      refreshLive()
      try {
        if (ctx.settings.describe().some((entry) => entry.ns === SETTINGS_NS)) break
      } catch { /* not ready */ }
      await sleep(2000)
    }
    // Defer one tick: `endpoint`/`projectFor` are defined below this closure.
    const announce = setTimeout(() => {
      try {
        logger.info?.(`[${PLUGIN}] active — url=${endpoint().base} project=${projectFor(undefined)} tools=${settings.toolsEnabled !== false}`)
      } catch { /* no logger */ }
    }, 0)
    if (typeof announce.unref === 'function') announce.unref()
  })()

  ctx.effect(() => {
    const off = ctx.on(SETTINGS_EVENT, (ns) => {
      if (ns !== SETTINGS_NS) return
      refreshLive()
    })
    return () => { try { off() } catch { /* gone */ } }
  }, `${PLUGIN}: settings subscription`)

  const active = () => settings.enabled !== false

  // ── endpoint + identity ─────────────────────────────────────────────────
  const endpoint = () => identity.resolveEndpoint(settings)
  const projectFor = (cwd) => util.resolveProject({
    explicit: settings.project,
    cwd,
    envValue: identity.envValue('AGENTMEMORY_PROJECT_NAME'),
  })
  const agentId = () => {
    try {
      return identity.resolveAgentId(settings, { home })
    } catch (error) {
      logger.warn?.(`[${PLUGIN}] ${errorText(error)}; memory is disabled until the setting is fixed`)
      return ''
    }
  }

  let warnedPlaintext = false
  const warnOnce = () => {
    if (warnedPlaintext) return
    const resolved = endpoint()
    if (resolved.plaintextBearer !== true) return
    warnedPlaintext = true
    logger.warn?.(`[${PLUGIN}] sending a bearer token over plaintext http to ${resolved.base}; use https or loopback`)
  }

  // ── system prompt: the provider's static block ──────────────────────────
  ctx.effect(() => {
    const dispose = ctx.systemPrompt.section({
      name: `${PLUGIN}:guidance`,
      order: 52,
      text: () => (active() && settings.systemPromptBlockEnabled !== false ? SYSTEM_PROMPT_BLOCK : ''),
    })
    return () => { try { dispose() } catch { /* gone */ } }
  }, `${PLUGIN}: system prompt block`)

  // ── tools ───────────────────────────────────────────────────────────────
  const existingToolNames = (() => {
    try { return new Set(ctx.tools.schemas().map((schema) => schema.name)) } catch { return new Set() }
  })()
  const toolContext = (exec) => {
    const agent = exec !== null && exec !== undefined && exec.agent !== undefined ? exec.agent : null
    const state = agent !== null && agent.session !== undefined && agent.session !== null
      ? sessionState(agent.session)
      : undefined
    return {
      endpoint: endpoint(),
      project: projectFor(state === undefined ? undefined : state.cwd),
      agentId: agentId(),
      timeoutMs: settings.timeoutMs,
      // D7: subagent sessions are read-only. The provider's gate is
      // `agent_context == "primary"` (`__init__.py:328-330`).
      writeEnabled: active() && settings.writeEnabled !== false && (state === undefined || state.primary !== false),
    }
  }
  if (active() && settings.toolsEnabled !== false) {
    const built = tools.buildToolSet({ resolveContext: toolContext })
    ctx.effect(() => {
      const disposers = []
      for (const definition of built.definitions) {
        if (existingToolNames.has(definition.name)) continue
        try {
          disposers.push(ctx.tools.register(definition))
        } catch (error) {
          logger.warn?.(`[${PLUGIN}] cannot register ${definition.name}: ${errorText(error)}`)
        }
      }
      return () => {
        for (const dispose of disposers) { try { dispose() } catch { /* gone */ } }
      }
    }, `${PLUGIN}: memory tools`)
  }

  // ── per-session state ───────────────────────────────────────────────────
  // Scoped session ids this process has opened, so the lifecycle hooks close
  // exactly the ones we started (Hermes: "for each matching scoped session").
  // `closedSessions` remembers confirmed ends, so a session that is disposed
  // and later resumed gets exactly one `session/end` per open.
  const startedSessions = new Set()
  const closedSessions = new Set()
  const closingSessions = new Set()
  // `session/start` requests still awaiting their answer. Disposal waits for
  // them before closing, or a session opened during shutdown would be missed.
  const pendingStarts = new Set()
  const states = new WeakMap()
  function sessionState (session) {
    let state = states.get(session)
    if (state === undefined) {
      const header = session !== null && session !== undefined
        && session.header !== null && typeof session.header === 'object'
        ? session.header
        : {}
      state = {
        id: session !== null && session !== undefined && typeof session.id === 'string' ? session.id : '',
        cwd: typeof header.cwd === 'string' ? header.cwd : undefined,
        // D7: DSH marks subagent sessions with `meta.origin: 'subagent'`.
        // The provider's equivalent gate is `agent_context == "primary"`.
        primary: header.origin !== 'subagent',
        // Scoped id confirmed by the server; empty until `session/start`
        // succeeds and echoes it back (D9: a mismatch is never cached).
        scoped: '',
        starting: false,
        lastUserText: '',
        lastAssistantText: '',
        lastQuery: '',
        inFlight: false,
        compressing: false,
        injected: new Set(),
      }
      states.set(session, state)
    }
    return state
  }

  const callApi = (apiPath, body, state) => http.api(endpoint().base, apiPath, body, {
    secret: endpoint().secret,
    timeoutMs: settings.timeoutMs,
  })

  const scopedIdFor = (state, resolvedAgent = agentId()) => {
    if (state.primary === false || state.id === '' || resolvedAgent === '') return ''
    return identity.scopedSessionId({
      home,
      prefix: settings.identityPrefix,
      agentId: resolvedAgent,
      sessionId: state.id,
    })
  }

  // D9: a session/start answer that does not echo our scoped id is not used.
  // Warn once per scoped id instead of once per retry; the session stays
  // uncached and the next turn tries again, exactly like Hermes.
  const warnSessionMismatch = (() => {
    const warned = new Set()
    return (scoped, returned) => {
      if (warned.has(scoped)) return
      warned.add(scoped)
      logger.warn?.(`[${PLUGIN}] session/start did not confirm ${scoped} (returned ${returned === undefined ? 'no session' : returned}); it stays uncached`)
    }
  })()

  const startSession = async (state) => {
    if (state.primary === false || !active() || settings.writeEnabled === false) return
    if (state.scoped !== '' || state.starting) return
    const resolvedAgent = agentId()
    const scoped = scopedIdFor(state, resolvedAgent)
    if (scoped === '') return
    state.starting = true
    let settle
    const pending = new Promise((resolve) => { settle = resolve })
    pendingStarts.add(pending)
    try {
      warnOnce()
      const result = await callApi('session/start', {
        sessionId: scoped,
        project: projectFor(state.cwd),
        cwd: state.cwd,
        agentId: resolvedAgent,
      }, state)
      if (result.error !== undefined) {
        logger.warn?.(`[${PLUGIN}] session/start failed: ${result.error}`)
        return
      }
      // Hermes caches the scoped session only when the answer echoes it
      // (`__init__.py:537-543`). A mismatch must never become the session we
      // write under; the turn stays fail-open with the session uncached.
      const returned = result.session !== null && typeof result.session === 'object' ? result.session.id : undefined
      if (returned !== scoped) {
        warnSessionMismatch(scoped, returned)
        return
      }
      state.scoped = scoped
      startedSessions.add(scoped)
      closedSessions.delete(scoped)
    } finally {
      state.starting = false
      pendingStarts.delete(pending)
      settle()
    }
  }

  const endScoped = async (scoped) => {
    if (scoped === '' || settings.writeEnabled === false) return false
    if (!startedSessions.has(scoped) || closedSessions.has(scoped) || closingSessions.has(scoped)) return false
    const resolved = endpoint()
    if (resolved.valid !== true) return false
    closingSessions.add(scoped)
    try {
      const result = await http.api(resolved.base, 'session/end', { sessionId: scoped }, {
        secret: resolved.secret,
        timeoutMs: settings.timeoutMs,
      })
      if (result.error !== undefined) {
        logger.warn?.(`[${PLUGIN}] session/end failed: ${result.error}`)
        return false
      }
      // Hermes marks a session ended only after the server confirms it
      // (`__init__.py:559-562`); a failed or unconfirmed close stays retryable.
      if (result.success !== true) return false
      closedSessions.add(scoped)
      startedSessions.delete(scoped)
      return true
    } finally {
      closingSessions.delete(scoped)
    }
  }

  const endSessionState = async (state) => {
    if (state === undefined || state === null || state.scoped === '') return false
    const scoped = state.scoped
    const ended = await endScoped(scoped)
    // A closed session is reopened by `on_session_switch`; clearing the cached
    // id is what lets `startSession` run again for the same scoped id.
    if (state.scoped === scoped && (ended === true || closedSessions.has(scoped))) state.scoped = ''
    return ended
  }

  // ── turn sync ───────────────────────────────────────────────────────────
  const observeTurn = async (state) => {
    if (state.primary === false) return
    const user = state.lastUserText
    const assistant = state.lastAssistantText
    if (user === '' || assistant === '') return
    const resolvedAgent = agentId()
    if (resolvedAgent === '') return
    const scoped = state.id === ''
      ? ''
      : identity.scopedSessionId({ home, prefix: settings.identityPrefix, agentId: resolvedAgent, sessionId: state.id })
    const payload = prefetch.observePayload({
      sessionId: scoped,
      project: projectFor(state.cwd),
      cwd: state.cwd,
      agentId: resolvedAgent,
      user,
      assistant,
    })
    const result = await callApi('observe', payload, state)
    if (result.error !== undefined) logger.warn?.(`[${PLUGIN}] observe failed: ${result.error}`)
    state.lastUserText = ''
    state.lastAssistantText = ''
  }

  // ── recall injection ────────────────────────────────────────────────────
  //
  // Hermes appends the recall to the user message's API copy before the first
  // request (`agent/turn_context.py:119`). DSH has no request-rewrite hook, so
  // the closest equivalent is `agent.inject()` — model-facing context queued for
  // the next pre-step. When it lands after the first step, the model still sees
  // it in the same turn; that timing difference is the one honest deviation.
  const injectRecall = (session, state, text) => {
    if (text === '' || state.injected.has(text)) return
    state.injected.add(text)
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'agentmemory', form: 'recall' },
    }
    let agent = null
    try {
      const registry = ctx.agents !== undefined && ctx.agents !== null
        ? ctx.agents
        : (typeof ctx.get === 'function' ? ctx.get('agents') : undefined)
      if (registry !== undefined && registry !== null && typeof registry.get === 'function') agent = registry.get(state.id) || null
    } catch { /* no registry */ }
    try {
      if (agent !== null && typeof agent.inject === 'function') {
        agent.inject(message)
        return
      }
      if (session !== null && session !== undefined && typeof session.append === 'function') {
        session.append('user/message', message)
      }
    } catch (error) {
      logger.warn?.(`[${PLUGIN}] cannot inject recall: ${errorText(error)}`)
    }
  }

  const runPrefetch = async (session, state, query) => {
    if (!active() || settings.prefetchEnabled === false) return
    if (state.inFlight) return
    if (query === '' || query === state.lastQuery) return
    if (util.isTrivialPrompt(query, TRIVIAL_PROMPT_RE)) return
    const resolved = endpoint()
    if (resolved.valid !== true) return
    state.lastQuery = query
    state.inFlight = true
    try {
      warnOnce()
      await startSession(state)
      const result = await prefetch.prefetchRecall({
        endpoint: resolved,
        project: projectFor(state.cwd),
        agentId: agentId(),
        query: util.truncate(util.sanitizeText(query), LIMITS.PREFETCH_QUERY_MAX_CHARS),
        limit: settings.prefetchLimit,
        timeoutMs: settings.prefetchTimeoutMs,
      })
      if (result.error !== undefined) {
        logger.warn?.(`[${PLUGIN}] recall failed: ${result.error}`)
        return
      }
      const block = prefetch.buildMemoryContextBlock(result.text)
      if (block !== '') injectRecall(session, state, block)
    } catch (error) {
      logger.warn?.(`[${PLUGIN}] recall crashed: ${errorText(error)}`)
    } finally {
      state.inFlight = false
    }
  }

  // ── pre-compress recall (on_pre_compress) ───────────────────────────────
  //
  // Hermes' `on_pre_compress(messages)` returns `prefetch(query)` and the host
  // splices that text into the compaction summary prompt (`__init__.py:578`,
  // `memory_manager.py:340`). DSH exposes the compaction only as durable,
  // log-only session events: `compaction/start` is appended before
  // summarization, and the sole related waterfall (`compaction/summary-error`)
  // is for error recovery, not prompt contribution. The port therefore runs
  // the same query selection and recall fetch and injects the fenced block via
  // `agent.inject()`: the model gets the memory at/after compaction instead of
  // inside the summary prompt.
  const runPreCompress = async (session, state) => {
    if (!active() || settings.prefetchEnabled === false || state.compressing) return
    state.compressing = true
    try {
      const messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
      const parts = []
      for (const message of messages.slice(-5)) {
        if (message === null || typeof message !== 'object') continue
        const text = util.messageText(message)
        if (typeof text === 'string' && text.trim() !== '') parts.push(text)
      }
      // Provider: " ".join(content of the last five messages), then the last
      // 2000 characters (`__init__.py:579-580`).
      const query = parts.join(' ').slice(-LIMITS.PREFETCH_QUERY_MAX_CHARS).trim()
      if (query === '') return
      const resolved = endpoint()
      if (resolved.valid !== true) return
      warnOnce()
      const result = await prefetch.prefetchRecall({
        endpoint: resolved,
        project: projectFor(state.cwd),
        agentId: agentId(),
        query,
        limit: settings.prefetchLimit,
        timeoutMs: settings.timeoutMs,
      })
      if (result.error !== undefined) {
        logger.warn?.(`[${PLUGIN}] pre-compress recall failed: ${result.error}`)
        return
      }
      const block = prefetch.buildMemoryContextBlock(result.text)
      if (block !== '') injectRecall(session, state, block)
    } catch (error) {
      logger.warn?.(`[${PLUGIN}] pre-compress recall crashed: ${errorText(error)}`)
    } finally {
      state.compressing = false
    }
  }

  // ── lifecycle: on_session_end / on_session_switch ───────────────────────
  //
  // Hermes posts `session/end` for every scoped session it opened, only at real
  // session boundaries (`__init__.py:555` and `:565`). DSH has no provider-level
  // session-end event; the boundaries a host plugin sees are
  //   * `session/disposed` — a session leaves the live store (`Session` docs),
  //   * `agent/disposed`   — the agent's driver has shut down.
  // Both close the scoped id idempotently, so whichever fires first performs
  // the single `session/end`. `agent/created` is the `on_session_switch`
  // equivalent: a resume/clear/compact lifecycle closes the previous scoped
  // session (Hermes: `on_session_end([])`) before opening the new one.
  ctx.effect(() => {
    const warnLifecycle = (what) => (error) => {
      logger.warn?.(`[${PLUGIN}] ${what} failed: ${errorText(error)}`)
    }
    const onSessionDisposed = (session) => {
      try { void endSessionState(sessionState(session)) } catch (error) { warnLifecycle('session disposal')(error) }
    }
    const onAgentDisposed = (payload) => {
      try {
        const agent = payload !== null && typeof payload === 'object' ? payload.agent : undefined
        const session = agent !== null && typeof agent === 'object' ? agent.session : undefined
        if (session !== undefined && session !== null) void endSessionState(sessionState(session))
      } catch (error) { warnLifecycle('agent disposal')(error) }
    }
    const onAgentCreated = (payload) => {
      try {
        const agent = payload !== null && typeof payload === 'object' ? payload.agent : undefined
        const session = agent !== null && typeof agent === 'object' ? agent.session : undefined
        if (session === undefined || session === null) return
        const state = sessionState(session)
        if (state.primary === false) return
        const source = payload !== null && typeof payload === 'object' && typeof payload.source === 'string'
          ? payload.source
          : 'startup'
        void (async () => {
          if (source !== 'startup') await endSessionState(state)
          await startSession(state)
        })().catch(warnLifecycle('session switch'))
      } catch (error) { warnLifecycle('agent creation')(error) }
    }
    const offSession = ctx.on('session/disposed', onSessionDisposed)
    const offAgent = ctx.on('agent/disposed', onAgentDisposed)
    const offCreated = ctx.on('agent/created', onAgentCreated)
    return () => {
      try { offSession() } catch { /* gone */ }
      try { offAgent() } catch { /* gone */ }
      try { offCreated() } catch { /* gone */ }
    }
  }, `${PLUGIN}: session lifecycle`)

  const endSessions = async () => {
    if (settings.writeEnabled === false) return
    // Let an in-flight `session/start` land first: otherwise its session is
    // opened after this loop read the set, and no `session/end` is ever sent.
    if (pendingStarts.size > 0) await Promise.allSettled([...pendingStarts])
    for (const scoped of [...startedSessions]) await endScoped(scoped)
  }

  // ── built-in memory mirror (on_memory_write) ────────────────────────────
  //
  // hermes-evolve owns the built-in MEMORY.md/USER.md store and announces each
  // applied operation as `hermes-evolve/memory-write`. Hermes' provider hook is
  // the same idea one layer down: mirror the write so the provider's recall can
  // find what the native store learned. Serialised through one promise chain:
  // two writes racing on the ownership file would drop an id.
  let mirrorChain = Promise.resolve()
  const handleMirror = (payload) => {
    if (!active() || settings.mirrorBuiltinMemory === false || settings.writeEnabled === false) return Promise.resolve()
    const rows = payload !== null && typeof payload === 'object' && Array.isArray(payload.rows) ? payload.rows : []
    if (rows.length === 0) return Promise.resolve()
    const run = async () => {
      const resolved = endpoint()
      if (resolved.valid !== true) return
      warnOnce()
      for (const row of rows) {
        const outcome = await mirror.mirrorMemoryWrite(row, {
          endpoint: resolved,
          project: projectFor(undefined),
          agentId: agentId(),
          home,
          timeoutMs: settings.timeoutMs,
          writeEnabled: settings.writeEnabled !== false && active(),
          warn: (message) => logger.warn?.(message),
        })
        if (outcome.status === 'error') logger.warn?.(`[${PLUGIN}] memory mirror: ${outcome.detail || 'failed'}`)
      }
    }
    mirrorChain = mirrorChain.then(run, run).catch((error) => {
      logger.warn?.(`[${PLUGIN}] memory mirror crashed: ${errorText(error)}`)
    })
    return mirrorChain
  }

  ctx.effect(() => {
    const off = ctx.on('hermes-evolve/memory-write', (payload) => { void handleMirror(payload) })
    return () => { try { off() } catch { /* gone */ } }
  }, `${PLUGIN}: built-in memory mirror`)

  // ── session events ──────────────────────────────────────────────────────
  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      try {
        if (event === null || typeof event !== 'object') return
        const state = sessionState(session)
        if (event.type === 'compaction/start') {
          // D5: the closest DSH expression of `on_pre_compress`. The event is
          // appended before summarization, so recall is fetched while the
          // compaction is being prepared.
          void runPreCompress(session, state)
          return
        }
        if (event.type === 'user/message') {
          const message = event.data
          if (!util.isHumanMessage(message)) return
          const text = util.messageText(message)
          state.lastUserText = text
          state.lastAssistantText = ''
          state.injected.clear()
          // on_turn_start bookkeeping (`__init__.py:352-355`) opens the scoped
          // session at a turn boundary before any write. The other half of
          // that hook (per-turn author ContextVar + queued-prefetch cache) has
          // no DSH equivalent: DSH session meta exposes no author/platform and
          // this port prefetches inline instead of queueing.
          if (state.primary !== false && active() && settings.syncEnabled !== false && settings.writeEnabled !== false) {
            void startSession(state)
          }
          void runPrefetch(session, state, text)
          return
        }
        if (event.type === 'assistant/message') {
          const message = event.data !== null && typeof event.data === 'object' ? event.data.message : undefined
          const text = util.messageText(message)
          if (text.trim() !== '') state.lastAssistantText = text
          return
        }
        if (event.type === 'turn/end') {
          const reason = event.data !== null && typeof event.data === 'object' ? event.data.reason : undefined
          const kind = reason !== null && typeof reason === 'object' ? reason.kind : undefined
          if (kind !== 'completed') {
            state.lastUserText = ''
            state.lastAssistantText = ''
            return
          }
          if (!active() || state.primary === false || settings.syncEnabled === false || settings.writeEnabled === false) return
          void (async () => {
            try {
              await startSession(state)
              await observeTurn(state)
            } catch (error) {
              logger.warn?.(`[${PLUGIN}] sync crashed: ${errorText(error)}`)
            }
          })()
        }
      } catch (error) {
        logger.warn?.(`[${PLUGIN}] event handler failed: ${errorText(error)}`)
      }
    })
    return () => { try { off() } catch { /* gone */ } }
  }, `${PLUGIN}: session events`)

  ctx.effect(() => () => { void endSessions() }, `${PLUGIN}: session end`)

}

module.exports = {
  name: PLUGIN,
  inject: ['settings', 'systemPrompt', 'tools', 'agents'],
  Config,
  apply,
  __internals: { sanitizeConfig, sessionPayload: identity.sessionPayload },
}