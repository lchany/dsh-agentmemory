'use strict'

/**
 * Recall + turn sync, ported from the Hermes side of the bridge.
 *
 * `prefetch` mirrors `AgentMemoryProvider.prefetch` (smart-search → expandIds →
 * "- title: narrative" lines, capped at 6000 chars). `buildMemoryContextBlock`
 * mirrors `agent/memory_manager.py:372` byte for byte, including the fence tags,
 * the system note, and the sanitize/dedupe passes — a model that sees our block
 * sees exactly what a Hermes model saw.
 */

const { DEFAULTS, LIMITS } = require('./const')
const http = require('./http')
const util = require('./util')

const FENCE_TAG_RE = /<\/?\s*memory-context\s*>/gi
const INTERNAL_CONTEXT_RE = /<\s*memory-context\s*>[\s\S]*?<\/\s*memory-context\s*>/gi
const INTERNAL_NOTE_RE = /\[System note:\s*The following is recalled memory context,\s*NOT new user input\.\s*Treat as (?:informational background data|authoritative reference data[^\]]*)\.\]\s*/gi
const RECALL_BULLET_RE = /^[-*+]\s+\S/

/** Strip fence tags, injected context blocks, and system notes from provider output. */
function sanitizeContext (text) {
  let value = typeof text === 'string' ? text : ''
  for (const pattern of [INTERNAL_CONTEXT_RE, INTERNAL_NOTE_RE, FENCE_TAG_RE]) {
    value = value.replace(pattern, '')
  }
  return value
}

/**
 * Drop duplicate bullet lines, keeping indented continuation lines verbatim.
 * A bullet carrying a continuation is never dropped and never suppresses a
 * later one, because two entries can share a headline and differ underneath.
 */
function dropRepeatedRecallLines (text) {
  const lines = String(text).split('\n')
  const seen = new Set()
  const kept = []
  lines.forEach((line, index) => {
    const stripped = line.trim()
    if (stripped !== '' && /^\s/.test(line)) {
      kept.push(line)
      return
    }
    const isBullet = RECALL_BULLET_RE.test(stripped)
    if (stripped !== '' && !isBullet) seen.clear()
    if (isBullet) {
      const following = index + 1 < lines.length ? lines[index + 1] : ''
      const carriesContinuation = following.trim() !== '' && /^\s/.test(following)
      if (!carriesContinuation) {
        if (seen.has(stripped)) return
        seen.add(stripped)
      }
    }
    kept.push(line)
  })
  return kept.join('\n')
}

/** Wrap prefetched memory in the fenced block the agent prompt expects. */
function buildMemoryContextBlock (rawContext) {
  if (typeof rawContext !== 'string' || rawContext.trim() === '') return ''
  const sanitized = sanitizeContext(rawContext)
  const clean = dropRepeatedRecallLines(sanitized)
  return '<memory-context>\n'
    + '[System note: The following is recalled memory context, '
    + "NOT new user input. Treat as authoritative reference data — "
    + "this is the agent's persistent memory and should inform all responses.]\n\n"
    + `${clean}\n`
    + '</memory-context>'
}

/** `- title: narrative`, first five rows, each field clipped like the provider. */
function formatRecallRows (rows) {
  if (!Array.isArray(rows)) return ''
  const lines = []
  for (const item of rows.slice(0, 5)) {
    if (item === null || typeof item !== 'object') continue
    const observation = item.observation
    if (observation === null || typeof observation !== 'object') continue
    const title = observation.title
    const narrative = observation.narrative
    if (typeof title !== 'string' || typeof narrative !== 'string') continue
    lines.push(`- ${util.truncate(title, LIMITS.RECALL_TITLE_CHARS)}: ${util.truncate(narrative, LIMITS.RECALL_NARRATIVE_CHARS)}`)
  }
  return util.truncate(lines.join('\n'), LIMITS.PREFETCH_TOTAL_CHARS)
}

function recallReferences (rows) {
  const ids = []
  if (!Array.isArray(rows)) return ids
  for (const item of rows.slice(0, 5)) {
    if (item === null || typeof item !== 'object') continue
    if (typeof item.obsId !== 'string' || item.obsId === '') continue
    const reference = { obsId: item.obsId }
    if (typeof item.sessionId === 'string' && item.sessionId !== '') reference.sessionId = item.sessionId
    const duplicate = ids.some((known) => known.obsId === reference.obsId && known.sessionId === reference.sessionId)
    if (!duplicate) ids.push(reference)
  }
  return ids
}

/**
 * Fetch recall context for one prompt.
 *
 * @returns {Promise<{text: string, error?: string}>} `text` is the raw joined
 *   recall lines (not yet fenced); empty when there is nothing to inject.
 */
async function prefetchRecall (options = {}) {
  const endpoint = options.endpoint
  if (endpoint === undefined || endpoint === null || endpoint.valid !== true) {
    return { text: '', error: 'AgentMemory is not configured (invalid url).' }
  }
  const limit = Number.isInteger(options.limit) ? options.limit : DEFAULTS.prefetchLimit
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : DEFAULTS.prefetchTimeoutMs
  const base = { project: options.project, agentId: options.agentId, includeLessons: false }
  const first = await http.api(endpoint.base, 'smart-search', { ...base, query: options.query, limit }, {
    secret: endpoint.secret,
    timeoutMs,
  })
  if (first.error !== undefined) return { text: '', error: first.error }
  let rows = first.results
  const references = recallReferences(rows)
  if (references.length > 0) {
    const expanded = await http.api(endpoint.base, 'smart-search', {
      expandIds: references,
      project: options.project,
      agentId: options.agentId,
    }, { secret: endpoint.secret, timeoutMs })
    if (expanded.error === undefined) rows = expanded.results
  }
  return { text: formatRecallRows(rows) }
}

/** The `observe` payload for one finished turn, clipped like the provider. */
function observePayload ({ sessionId, project, cwd, agentId, user, assistant, now } = {}) {
  const stamp = now instanceof Date ? now : new Date()
  return {
    sessionId,
    project,
    cwd,
    agentId,
    hookType: 'post_tool_use',
    timestamp: `${stamp.toISOString().slice(0, 19)}Z`,
    data: {
      tool_name: 'conversation',
      tool_input: util.truncate(util.sanitizeText(user), DEFAULTS.syncUserChars),
      tool_output: util.truncate(util.sanitizeText(assistant), DEFAULTS.syncAssistantChars),
    },
  }
}

module.exports = {
  sanitizeContext,
  dropRepeatedRecallLines,
  buildMemoryContextBlock,
  formatRecallRows,
  recallReferences,
  prefetchRecall,
  observePayload,
}