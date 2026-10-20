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
        inFlight: false,
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

  // ── recall (prefetch) ───────────────────────────────────────────────────
  //
  // Hermes runs `prefetch_all` synchronously on the turn path and appends the
  // fenced block to the user message's API copy before the first request
  // (`agent/turn_context.py:927`, `:119`); a provider that does not answer within
  // `_EXTERNAL_PREFETCH_TIMEOUT_S` is skipped for that turn
  // (`memory_manager.py:545-552`). DSH has no request-rewrite seam
  // (`agent/request` "cannot mutate messages"), but `agent/pre-step` may append
  // logged messages to the batch it is about to commit, so the recall is fetched
  // there and enters the same request as the prompt. It cannot be started from
  // the `user/message` event: the loop commits the batch only AFTER pre-step.
  const fetchRecall = async (state, query) => {
    if (!active() || settings.prefetchEnabled === false) return ''
    if (state.inFlight) return ''
    if (query === '') return ''
    if (util.isTrivialPrompt(query, TRIVIAL_PROMPT_RE)) return ''
    const resolved = endpoint()
    if (resolved.valid !== true) return ''
    state.inFlight = true
    try {
      warnOnce()
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
        return ''
      }
      return prefetch.buildMemoryContextBlock(result.text)
    } catch (error) {
      logger.warn?.(`[${PLUGIN}] recall crashed: ${errorText(error)}`)
      return ''
    } finally {
      state.inFlight = false
    }
  }

  /** Resolve with `fetchRecall`'s block, or '' once the cap or the step's abort wins. */
  const recallWithin = (state, query, signal) => new Promise((resolve) => {
    let timer = null
    let onAbort = null
    const done = (value) => {
      if (timer !== null) clearTimeout(timer)
      if (onAbort !== null && signal) signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    timer = setTimeout(() => done(''), LIMITS.PREFETCH_WAIT_MS)
    if (typeof timer.unref === 'function') timer.unref()
    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted) return done('')
      onAbort = () => done('')
      signal.addEventListener('abort', onAbort, { once: true })
    }
    fetchRecall(state, query).then(done, () => done(''))
  })

  ctx.effect(() => {
    const off = ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      try {
        if (decision === null || typeof decision !== 'object' || decision.kind !== 'enter') return decision
        const session = payload !== null && typeof payload === 'object' && payload.agent !== null && typeof payload.agent === 'object'
          ? payload.agent.session
          : undefined
        if (session === undefined || session === null) return decision
        const claimed = Array.isArray(payload.messages) ? payload.messages : []
        const prompts = claimed.filter((message) => util.isHumanMessage(message))
        if (prompts.length === 0) return decision
        const query = util.messageText(prompts[prompts.length - 1])
        const state = sessionState(session)
        // Hermes builds delegate/review/curator agents with `skip_memory=True`
        // (`tools/delegate_tool.py:279`, `agent/background_review.py:915-927`,
        // `agent/curator.py:1119`): no provider, so no prefetch and no recall.
        if (state.primary === false) return decision
        const block = await recallWithin(state, query, payload.signal)
        if (block === '') return decision
        return {
          ...decision,
          messages: [...decision.messages, {
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: block }],
            source: { kind: 'agentmemory', form: 'recall' },
          }],
        }
      } catch (error) {
        logger.warn?.(`[${PLUGIN}] cannot attach recall: ${errorText(error)}`)
        return decision
      }
    })
    return () => { try { off() } catch { /* gone */ } }
  }, `${PLUGIN}: recall at pre-step`)

  // `on_pre_compress` (`__init__.py:578`) has no DSH counterpart by design:
  // Hermes hands its text to the compressor as `memory_context` and, when the
  // engine does not accept it, continues without it
  // (`conversation_compression.py:2965`). `dsh-compaction-basic` exposes only the
  // log-only `compaction/*` events and the `compaction/summary-error` recovery
  // waterfall, so there is no prompt seam to contribute to.

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
        if (event.type === 'user/message') {
          const message = event.data
          if (!util.isHumanMessage(message)) return
          const text = util.messageText(message)
          state.lastUserText = text
          state.lastAssistantText = ''
          // on_turn_start bookkeeping (`__init__.py:352-355`) opens the scoped
          // session at a turn boundary before any write. The other half of
          // that hook (per-turn author ContextVar + queued-prefetch cache) has
          // no DSH equivalent: DSH session meta exposes no author/platform and
          // this port prefetches inline instead of queueing.
          if (state.primary !== false && active() && settings.syncEnabled !== false && settings.writeEnabled !== false) {
            void startSession(state)
          }
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