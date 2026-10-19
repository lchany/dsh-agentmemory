'use strict'

/**
 * Settings: defaults, the schemastery schema the host discovers, and the
 * sanitizer that keeps host-materialised placeholders out of live state.
 *
 * The host projects a volatile setting's default as `{}` during apply-config,
 * so values that arrive here are untrusted; `sanitizeConfig` keeps only keys
 * this plugin declares and only when the value has the declared type.
 */

const { DEFAULTS } = require('./const')

const FIELD_TYPES = {
  enabled: 'boolean',
  url: 'string',
  secret: 'string',
  timeoutMs: 'number',
  project: 'string',
  agentId: 'string',
  identityPrefix: 'string',
  systemPromptBlockEnabled: 'boolean',
  toolsEnabled: 'boolean',
  prefetchEnabled: 'boolean',
  syncEnabled: 'boolean',
  writeEnabled: 'boolean',
  prefetchLimit: 'number',
  prefetchMaxChars: 'number',
  prefetchTimeoutMs: 'number',
  prefetchIncludeLessons: 'boolean',
  prefetchCooldownMs: 'number',
  syncUserChars: 'number',
  syncAssistantChars: 'number',
}

/** Drop unknown keys and host-materialised placeholders (e.g. `{}` for a string). */
function sanitizeConfig (raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [key, type] of Object.entries(FIELD_TYPES)) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
    const value = raw[key]
    const ok = type === 'number'
      ? typeof value === 'number' && Number.isFinite(value)
      : typeof value === type
    if (ok) out[key] = value
  }
  return out
}

function settingsSchema (S) {
  if (!S || typeof S.object !== 'function') return null
  return S.object({
    enabled: S.boolean().default(DEFAULTS.enabled).volatile(),
    url: S.string().default(DEFAULTS.url).volatile(),
    secret: S.string().default(DEFAULTS.secret).volatile(),
    timeoutMs: S.number().min(100).default(DEFAULTS.timeoutMs).volatile(),
    project: S.string().default(DEFAULTS.project).volatile(),
    agentId: S.string().default(DEFAULTS.agentId).volatile(),
    identityPrefix: S.string().default(DEFAULTS.identityPrefix).volatile(),

    systemPromptBlockEnabled: S.boolean().default(DEFAULTS.systemPromptBlockEnabled).volatile(),
    toolsEnabled: S.boolean().default(DEFAULTS.toolsEnabled).volatile(),
    prefetchEnabled: S.boolean().default(DEFAULTS.prefetchEnabled).volatile(),
    syncEnabled: S.boolean().default(DEFAULTS.syncEnabled).volatile(),
    writeEnabled: S.boolean().default(DEFAULTS.writeEnabled).volatile(),

    prefetchLimit: S.number().min(1).max(20).default(DEFAULTS.prefetchLimit).volatile(),
    prefetchMaxChars: S.number().min(200).default(DEFAULTS.prefetchMaxChars).volatile(),
    prefetchTimeoutMs: S.number().min(100).default(DEFAULTS.prefetchTimeoutMs).volatile(),
    prefetchIncludeLessons: S.boolean().default(DEFAULTS.prefetchIncludeLessons).volatile(),
    prefetchCooldownMs: S.number().min(0).default(DEFAULTS.prefetchCooldownMs).volatile(),

    syncUserChars: S.number().min(50).default(DEFAULTS.syncUserChars).volatile(),
    syncAssistantChars: S.number().min(100).default(DEFAULTS.syncAssistantChars).volatile(),
  }).default(DEFAULTS)
}

module.exports = { FIELD_TYPES, sanitizeConfig, settingsSchema }