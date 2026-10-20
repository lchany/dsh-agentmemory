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
    const cwd = exec !== null && exec !== undefined && exec.agent !== undefined && exec.agent !== null
      ? sessionState(exec.agent.session).cwd
      : undefined
    return {
      endpoint: endpoint(),
      project: projectFor(cwd),
      agentId: agentId(),
      timeoutMs: settings.timeoutMs,
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
  // Scoped session ids this process has opened, so `on_session_end` can close
  // exactly the ones we started (Hermes: "for each matching scoped session").
  const startedSessions = new Set()
  const states = new WeakMap()
  function sessionState (session) {
    let state = states.get(session)
    if (state === undefined) {
      state = {
        id: session !== null && session !== undefined && typeof session.id === 'string' ? session.id : '',
        cwd: session !== null && session !== undefined && session.header !== undefined && typeof session.header.cwd === 'string'
          ? session.header.cwd
          : undefined,
        started: false,
        lastUserText: '',
        lastAssistantText: '',
        lastQuery: '',
        inFlight: false,
        injected: new Set(),
        idle: false,
      }
      states.set(session, state)
    }
    return state
  }

  const callApi = (apiPath, body, state) => http.api(endpoint().base, apiPath, body, {
    secret: endpoint().secret,
    timeoutMs: settings.timeoutMs,
  })

  const startSession = async (state) => {
    if (state.started || !active() || settings.writeEnabled === false) return
    state.started = true
    const resolvedAgent = agentId()
    if (resolvedAgent === '') return
    warnOnce()
    const scoped = state.id === ''
      ? ''
      : identity.scopedSessionId({ home, prefix: settings.identityPrefix, agentId: resolvedAgent, sessionId: state.id })
    const result = await callApi('session/start', {
      sessionId: scoped,
      project: projectFor(state.cwd),
      cwd: state.cwd,
      agentId: resolvedAgent,
    }, state)
    if (result.error !== undefined) {
      state.started = false
      logger.warn?.(`[${PLUGIN}] session/start failed: ${result.error}`)
      return
    }
    if (scoped !== '') startedSessions.add(scoped)
    const returned = result.session !== null && typeof result.session === 'object' ? result.session.id : undefined
    if (typeof returned === 'string' && returned !== '' && returned !== scoped) {
      logger.warn?.(`[${PLUGIN}] server returned a different session id (${returned}); writes may land in another bucket`)
    }
  }

  // ── turn sync ───────────────────────────────────────────────────────────
  const observeTurn = async (state, session) => {
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

  // ── session end ─────────────────────────────────────────────────────────
  //
  // Hermes' `on_session_end` fires "only at real session boundaries, never
  // per-turn" and posts `session/end` for every scoped session it opened
  // (`__init__.py:555`). DSH's session log has no session-end event (only
  // `session/end-seed`), so the real boundary available to a host plugin is
  // our own disposal — process shutdown or plugin unload. Nothing is sent
  // per turn: an idle session keeps its provider record open.
  const endSessions = async () => {
    if (settings.writeEnabled === false) return
    const resolved = endpoint()
    if (resolved.valid !== true) return
    const ids = [...startedSessions]
    startedSessions.clear()
    for (const sessionId of ids) {
      const result = await http.api(resolved.base, 'session/end', { sessionId }, {
        secret: resolved.secret,
        timeoutMs: settings.timeoutMs,
      })
      if (result.error !== undefined) logger.warn?.(`[${PLUGIN}] session/end failed: ${result.error}`)
    }
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
          state.injected.clear()
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
          if (!active() || settings.syncEnabled === false || settings.writeEnabled === false) return
          void (async () => {
            try {
              await startSession(state)
              await observeTurn(state, session)
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