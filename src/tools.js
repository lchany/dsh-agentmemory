'use strict'

/**
 * The three memory tools, ported from the AgentMemory provider plugin
 * (`~/.hermes/plugins/agentmemory/__init__.py:439-530`).
 *
 * Names, descriptions, JSON Schemas, and the argument validation are copied;
 * only the transport differs (a direct fetch instead of an MCP round trip).
 */

const { LIMITS, DEFAULTS } = require('./const')
const http = require('./http')
const identity = require('./identity')

const MEMORY_RECALL_SCHEMA = {
  name: 'memory_recall',
  description: 'Search agentmemory for past observations by keyword',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      project: { type: 'string', description: 'Project scope; defaults to the current project' },
      agentId: { type: 'string', description: 'Agent identity filter' },
      targetLayer: { type: 'string', enum: ['all', 'memory', 'observation'] },
      limit: { type: 'integer', description: 'Max results', default: 10 },
    },
    required: ['query'],
  },
}

const MEMORY_SAVE_SCHEMA = {
  name: 'memory_save',
  description: 'Save an insight, decision, or pattern to long-term memory',
  parameters: {
    type: 'object',
    properties: {
      content: { type: 'string', description: 'What to remember' },
      concepts: { type: 'string', description: 'Comma-separated concepts' },
      files: { type: 'string', description: 'Comma-separated relevant file paths' },
      project: { type: 'string', description: 'Project scope; defaults to the current project' },
      agentId: { type: 'string', description: 'Agent identity owning the memory' },
      type: {
        type: 'string',
        enum: ['pattern', 'preference', 'architecture', 'bug', 'workflow', 'fact'],
        description: 'Memory type',
      },
    },
    required: ['content'],
  },
}

const MEMORY_SEARCH_SCHEMA = {
  name: 'memory_search',
  description: 'Hybrid semantic + keyword search across all memories',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      project: { type: 'string', description: 'Project scope; defaults to the current project' },
      agentId: { type: 'string', description: 'Agent identity filter' },
      targetLayer: { type: 'string', enum: ['all', 'memory', 'observation'] },
      limit: { type: 'integer', default: 5 },
    },
    required: ['query'],
  },
}

const TOOL_SCHEMAS = {
  memory_recall: MEMORY_RECALL_SCHEMA,
  memory_save: MEMORY_SAVE_SCHEMA,
  memory_search: MEMORY_SEARCH_SCHEMA,
}

const MEMORY_TYPES = new Set(['pattern', 'preference', 'architecture', 'bug', 'workflow', 'fact'])
const TARGET_LAYERS = new Set(['all', 'memory', 'observation'])

function fail (error) {
  return JSON.stringify({ success: false, error })
}

/** Turn CSV text (or an array) into the deduped string array the API expects. */
function conceptList (value, field) {
  let items = value
  if (typeof items === 'string') items = items.split(',')
  if (items === undefined || items === null) items = []
  if (!Array.isArray(items)) return { error: `${field} must be CSV text or an array of strings.` }
  if (!items.every((item) => typeof item === 'string')) return { error: `${field} must be CSV text or an array of strings.` }
  const cleaned = []
  const seen = new Set()
  for (const item of items) {
    const trimmed = item.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    cleaned.push(trimmed)
  }
  return { value: cleaned }
}

/**
 * Validate one call and return `{ path, payload }` or `{ error }`.
 * Pure: no network, so the tests can exercise every branch cheaply.
 */
function buildRequest (name, args, context = {}) {
  if (!Object.prototype.hasOwnProperty.call(TOOL_SCHEMAS, name)) {
    return { error: `Unknown tool: ${name}` }
  }
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { error: 'Tool arguments must be an object.' }
  }
  const field = name === 'memory_save' ? 'content' : 'query'
  const primary = args[field]
  if (typeof primary !== 'string' || primary.trim() === '') {
    return { error: `${field} must be a non-empty string.` }
  }
  const payload = { [field]: primary, project: context.project, agentId: context.agentId }
  if (typeof payload.project !== 'string' || payload.project === '') delete payload.project
  if (typeof payload.agentId !== 'string' || payload.agentId === '') delete payload.agentId
  for (const key of ['project', 'agentId']) {
    if (!Object.prototype.hasOwnProperty.call(args, key)) continue
    const value = args[key]
    if (typeof value !== 'string' || value.trim() === '') {
      return { error: `${key} must be a non-empty string.` }
    }
    payload[key] = value.trim()
    if (key === 'agentId' && (payload[key] === '*' || payload[key].length > LIMITS.AGENT_ID_MAX)) {
      return { error: `agentId must be at most ${LIMITS.AGENT_ID_MAX} characters and cannot be a wildcard.` }
    }
  }
  if (name === 'memory_save') {
    const kind = args.type === undefined ? 'fact' : args.type
    if (typeof kind !== 'string' || !MEMORY_TYPES.has(kind)) return { error: 'Invalid memory type.' }
    payload.type = kind
    for (const key of ['concepts', 'files']) {
      const parsed = conceptList(args[key], key)
      if (parsed.error !== undefined) return { error: parsed.error }
      payload[key] = parsed.value
    }
    return { path: 'remember', payload }
  }
  const fallbackLimit = name === 'memory_recall' ? 10 : 5
  const limit = args.limit === undefined ? fallbackLimit : args.limit
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < LIMITS.LIMIT_MIN || limit > LIMITS.LIMIT_MAX) {
    return { error: `limit must be an integer between ${LIMITS.LIMIT_MIN} and ${LIMITS.LIMIT_MAX}.` }
  }
  payload.limit = limit
  if (Object.prototype.hasOwnProperty.call(args, 'targetLayer')) {
    if (!TARGET_LAYERS.has(args.targetLayer)) return { error: 'Invalid targetLayer.' }
    payload.targetLayer = args.targetLayer
  }
  payload.includeLessons = false
  return { path: name === 'memory_recall' ? 'search' : 'smart-search', payload }
}

function toolDefinition (schema, handler, resolveContext) {
  return {
    name: schema.name,
    description: schema.description,
    parameters: schema.parameters,
    output: {
      schema: { type: 'string' },
      render (_args, value) {
        return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
      },
    },
    async execute (args, exec) {
      const context = typeof resolveContext === 'function' ? resolveContext(exec) : (resolveContext || {})
      return handler(args, context)
    },
  }
}

/**
 * @param {object} options
 * @param {(exec: unknown) => object} [options.resolveContext] - per-call context
 *   ({ endpoint, project, agentId, timeoutMs }); a static object also works.
 * @returns {{definitions: object[], schemas: object}}
 */
function buildToolSet (options = {}) {
  const resolveContext = options.resolveContext || options.context || {}
  const call = async (name, args, context) => {
    const built = buildRequest(name, args, context)
    if (built.error !== undefined) return fail(built.error)
    const endpoint = context.endpoint || identity.resolveEndpoint({})
    if (endpoint.valid !== true) return fail('AgentMemory is not configured (invalid url).')
    const result = await http.api(endpoint.base, built.path, built.payload, {
      secret: endpoint.secret,
      timeoutMs: context.timeoutMs || DEFAULTS.timeoutMs,
    })
    if (result !== null && typeof result === 'object' && typeof result.error === 'string' && result.success !== true) {
      return JSON.stringify({ success: false, error: result.error, errorCode: result.errorCode })
    }
    return JSON.stringify(result)
  }
  const definitions = Object.keys(TOOL_SCHEMAS).map((name) => toolDefinition(
    TOOL_SCHEMAS[name],
    (args, context) => call(name, args, context),
    resolveContext,
  ))
  return { definitions, schemas: TOOL_SCHEMAS }
}

module.exports = {
  MEMORY_RECALL_SCHEMA,
  MEMORY_SAVE_SCHEMA,
  MEMORY_SEARCH_SCHEMA,
  TOOL_SCHEMAS,
  buildRequest,
  buildToolSet,
}