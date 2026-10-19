'use strict'

/**
 * Endpoint + identity resolution.
 *
 * AgentMemory scopes every record by `project` and `agentId`, and every write by
 * a *scoped* session id (a digest, so a raw harness session id is never sent).
 * The provider derives those from the Hermes home; here the harness home plays
 * that role, so two profiles (or two harnesses) stay in separate buckets unless
 * the operator pins them together with the `project` / `agentId` settings.
 */

const { LIMITS, DEFAULTS } = require('./const')
const util = require('./util')
const { validateUrl } = require('./http')

function envValue (name) {
  const raw = process.env[name]
  return typeof raw === 'string' ? raw.trim() : ''
}

/**
 * Resolve `{ base, secret }` from settings, then the environment, then defaults.
 * Settings win so an operator can point one profile at another server without
 * exporting variables into the host process.
 */
function resolveEndpoint (settings = {}) {
  const settingUrl = typeof settings.url === 'string' ? settings.url.trim() : ''
  const envUrl = envValue('AGENTMEMORY_URL')
  const base = settingUrl !== '' ? settingUrl : (envUrl !== '' ? envUrl : LIMITS.DEFAULT_BASE_URL)
  const settingSecret = typeof settings.secret === 'string' ? settings.secret.trim() : ''
  const secret = settingSecret !== '' ? settingSecret : envValue('AGENTMEMORY_SECRET')
  return {
    base,
    secret,
    valid: validateUrl(base),
    // A bearer token over plaintext http is only tolerable on loopback; say so
    // once instead of silently shipping the credential across the network.
    plaintextBearer: secret !== '' && base.startsWith('http://') && !isLoopback(base),
  }
}

function isLoopback (base) {
  try {
    const host = new URL(base).hostname.toLowerCase()
    if (host === 'localhost') return true
    return host === '127.0.0.1' || host === '::1' || host === '[::1]'
  } catch {
    return false
  }
}

/**
 * `<prefix>-<sha256(json([home, "local", author]))[:32]>`, the provider's formula
 * with the harness home in the identity slot.
 */
function deriveAgentId ({ home, prefix, author } = {}) {
  const identity = [String(home || util.dshHome()), 'local', typeof author === 'string' ? author : '']
  const digest = util.sha256(JSON.stringify(identity)).slice(0, 32)
  const stem = typeof prefix === 'string' && prefix.trim() !== '' ? prefix.trim() : DEFAULTS.identityPrefix
  return `${stem}-${digest}`
}

/** The identity used for this install: explicit setting, else derived. */
function resolveAgentId (settings = {}, extra = {}) {
  const explicit = typeof settings.agentId === 'string' ? settings.agentId.trim() : ''
  if (explicit !== '') {
    if (explicit === '*' || explicit.length > LIMITS.AGENT_ID_MAX) {
      throw new Error(`agentId must be at most ${LIMITS.AGENT_ID_MAX} characters and cannot be a wildcard`)
    }
    return explicit
  }
  return deriveAgentId({
    home: extra.home || util.dshHome(),
    prefix: settings.identityPrefix,
    author: extra.author,
  })
}

/** Digest scoped session id — the raw harness session id never leaves the host. */
function scopedSessionId ({ home, prefix, agentId, sessionId } = {}) {
  const identity = [String(home || util.dshHome()), String(agentId || ''), String(sessionId || '')]
  const digest = util.sha256(JSON.stringify(identity))
  const stem = typeof prefix === 'string' && prefix.trim() !== '' ? prefix.trim() : DEFAULTS.identityPrefix
  return `${stem}-${digest}`
}

function sessionPayload ({ home, prefix, agentId, sessionId, project, cwd } = {}) {
  return {
    sessionId: scopedSessionId({ home, prefix, agentId, sessionId }),
    project,
    cwd,
    agentId,
  }
}

module.exports = {
  envValue,
  resolveEndpoint,
  isLoopback,
  deriveAgentId,
  resolveAgentId,
  scopedSessionId,
  sessionPayload,
}