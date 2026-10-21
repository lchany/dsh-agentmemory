'use strict'

/**
 * Session replay — rebuild AgentMemory from archived DSH sessions.
 *
 * AgentMemory distills `observe` events server-side; a session that was imported
 * (dsh-chat-import) never ran through this plugin, so its turns were never
 * observed. This module walks the transcript of a finished session and emits the
 * same lifecycle Hermes emits live (`__init__.py` `sync_turn` / `on_session_end`):
 *
 *   session/start → observe (one per turn) → session/end
 *
 * It is deliberately CLI-first (`node src/replay.js`) so a backfill does not
 * need a restarted host, and exportable (`__internals.replaySessions`) so a
 * future automatic importer can reuse it.
 *
 * Safety: every write is keyed by the same identity formula the live plugin uses
 * (`identity.scopedSessionId`), a per-session ledger makes reruns incremental,
 * and failures are reported per session instead of aborting the run.
 */

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const { DEFAULTS, LIMITS } = require('./const')
const util = require('./util')
const http = require('./http')
const identity = require('./identity')
const prefetch = require('./prefetch')

const ZSTD_MAGIC = 0xfd2fb528
/** Review forks are meta-sessions about the memory system itself; never replay them. */
const META_SESSION_PREFIX = 'hermes-evolve-review-'
const LEDGER_NAME = 'replay-ledger.json'

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Split a multi-frame Zstandard container into complete frame ranges.
 *
 * DSH appends one frame per durable batch, so a session file is a concatenation:
 * the whole-buffer magic check fails and a single-shot decompress only yields the
 * first frame. The scanner is the same header walk the session store uses
 * (`dsh-session-persistence-jsonl` `scanZstdFrames`), with a torn tail ignored.
 */
function scanZstdFrames (buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) break
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    let torn = false
    for (;;) {
      if (buffer.length - offset < 3) { torn = true; break }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) { torn = true; break }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) { torn = true; break }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (torn) break
    if (checksum) {
      if (buffer.length - offset < 4) break
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

/** Decode a session artifact (plain jsonl or multi-frame zstd) into JSONL text. */
function decodeSessionFile (file) {
  const raw = fs.readFileSync(file)
  if (raw.length >= 4 && raw.readUInt32LE(0) === ZSTD_MAGIC) {
    const parts = []
    for (const frame of scanZstdFrames(raw)) {
      try {
        parts.push(zlib.zstdDecompressSync(raw.subarray(frame.start, frame.end)))
      } catch { /* skip a corrupt frame, keep the readable ones */ }
    }
    return Buffer.concat(parts).toString('utf8')
  }
  return raw.toString('utf8')
}

/** Path of the newest session artifact inside a session directory. */
function artifactOf (dir) {
  let names = []
  try { names = fs.readdirSync(dir) } catch { return '' }
  const candidates = names
    .filter((name) => /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(name))
    .map((name) => path.join(dir, name))
  if (candidates.length === 0) return ''
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return candidates[0]
}

/** Parse JSONL text into events; malformed lines are skipped, not fatal. */
function parseEvents (text) {
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const value = JSON.parse(trimmed)
      if (value !== null && typeof value === 'object') events.push(value)
    } catch { /* torn final line */ }
  }
  return events
}

/**
 * Pair each human prompt with the assistant's final response in that turn.
 *
 * Hermes calls `sync_turn(user, assistant)` once per completed turn with the
 * turn's final assistant message (`agent/turn_context.py`), so only the last
 * non-empty assistant text before the next user prompt is used.
 */
function turnPairs (events) {
  const pairs = []
  let user = ''
  let assistant = ''
  let stamp = ''
  const flush = () => {
    if (user !== '' && assistant !== '') pairs.push({ user, assistant, time: stamp })
    user = ''
    assistant = ''
  }
  for (const event of events) {
    const type = event.type
    if (type === 'user/message') {
      const data = event.data && typeof event.data === 'object' ? event.data : {}
      const kind = data.source && typeof data.source === 'object' ? data.source.kind : ''
      if (typeof kind === 'string' && kind !== '' && kind !== 'user') continue
      const text = util.contentToText(data.content).trim()
      if (text === '') continue
      flush()
      user = text
      stamp = typeof event.time === 'string' ? event.time : ''
    } else if (type === 'assistant/message') {
      if (user === '') continue
      const data = event.data && typeof event.data === 'object' ? event.data : {}
      const message = data.message && typeof data.message === 'object' ? data.message : {}
      const text = util.contentToText(message.content).trim()
      if (text === '') continue
      assistant = util.truncate(text, LIMITS.SYNC_HARD_MAX)
    }
  }
  flush()
  return pairs
}

/** Read one archived session into `{id, workspace, cwd, title, pairs}`. */
function loadSession (workspaceId, sessionId) {
  const dir = path.join(util.dshHome(), 'sessions', workspaceId, sessionId)
  const file = artifactOf(dir)
  if (file === '') return null
  const events = parseEvents(decodeSessionFile(file))
  let cwd
  let title
  for (const event of events) {
    if (event.type === 'session') {
      const data = event.data && typeof event.data === 'object' ? event.data : {}
      cwd = typeof event.cwd === 'string' ? event.cwd : (typeof data.cwd === 'string' ? data.cwd : undefined)
      if (typeof event.title === 'string') title = event.title
    } else if (event.type === 'session/title') {
      const data = event.data && typeof event.data === 'object' ? event.data : {}
      if (typeof data.title === 'string') title = data.title
    }
  }
  const pairs = turnPairs(events)
  if (pairs.length === 0) return null
  return { id: sessionId, workspace: workspaceId, cwd, title, pairs, file }
}

/** Enumerate archived sessions, newest first, skipping empty/meta sessions. */
function listSessions (options = {}) {
  const root = path.join(util.dshHome(), 'sessions')
  const includeMeta = options.includeMeta === true
  const only = Array.isArray(options.sessionIds) ? new Set(options.sessionIds) : null
  const rows = []
  let workspaces = []
  try { workspaces = fs.readdirSync(root) } catch { return rows }
  for (const workspace of workspaces) {
    const workspaceDir = path.join(root, workspace)
    let entries = []
    try {
      if (!fs.statSync(workspaceDir).isDirectory()) continue
      entries = fs.readdirSync(workspaceDir)
    } catch { continue }
    for (const sessionId of entries) {
      if (!includeMeta && sessionId.startsWith(META_SESSION_PREFIX)) continue
      if (only !== null && !only.has(sessionId)) continue
      const dir = path.join(workspaceDir, sessionId)
      try { if (!fs.statSync(dir).isDirectory()) continue } catch { continue }
      if (artifactOf(dir) === '') continue
      rows.push({ workspace, id: sessionId, mtime: fs.statSync(dir).mtimeMs })
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime)
  if (Number.isFinite(Number(options.limit)) && Number(options.limit) > 0) return rows.slice(0, Number(options.limit))
  return rows
}

function ledgerPath (home) {
  return path.join(home || util.dshHome(), 'agentmemory', LEDGER_NAME)
}

function readLedger (home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ledgerPath(home), 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.sessions === 'object') return parsed
  } catch { /* first run */ }
  return { version: 1, sessions: {} }
}

function writeLedger (home, ledger) {
  const file = ledgerPath(home)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2))
    fs.renameSync(tmp, file)
  } catch { /* a lost ledger only costs a rerun */ }
}

/**
 * Replay one session.
 *
 * @returns {Promise<{ok:boolean, skipped?:string, observed?:number, failed?:number, ended?:boolean, error?:string}>}
 */
async function replaySession (session, options = {}) {
  const home = options.home || util.dshHome()
  const settings = { ...DEFAULTS, ...(options.settings || {}) }
  const endpoint = options.endpoint || identity.resolveEndpoint(settings)
  const logger = options.logger || { warn: () => {}, info: () => {} }
  if (endpoint.valid !== true) return { ok: false, error: 'AgentMemory endpoint is not configured' }
  const agentId = options.agentId || identity.resolveAgentId(settings, { home })
  if (agentId === '') return { ok: false, error: 'agentId is empty' }
  const project = typeof options.project === 'string' && options.project.trim() !== ''
    ? options.project.trim()
    : util.resolveProject({
      explicit: settings.project,
      cwd: session.cwd,
      envValue: identity.envValue('AGENTMEMORY_PROJECT_NAME'),
    })
  const scoped = identity.scopedSessionId({
    home,
    prefix: settings.identityPrefix,
    agentId,
    sessionId: session.id,
  })
  const timeoutMs = settings.timeoutMs
  const call = (apiPath, body) => http.api(endpoint.base, apiPath, body, { secret: endpoint.secret, timeoutMs })

  const started = await call('session/start', {
    sessionId: scoped,
    project,
    cwd: session.cwd,
    agentId,
  })
  if (started.error !== undefined) return { ok: false, error: `session/start: ${started.error}` }
  const echoed = started.session !== null && typeof started.session === 'object' ? started.session.id : undefined
  if (echoed !== scoped) return { ok: false, error: `session/start did not echo ${scoped}` }

  let observed = 0
  let failed = 0
  let lastError = ''
  for (const pair of session.pairs) {
    const payload = prefetch.observePayload({
      sessionId: scoped,
      project,
      cwd: session.cwd,
      agentId,
      user: pair.user,
      assistant: pair.assistant,
      now: pair.time === '' ? undefined : new Date(pair.time),
    })
    const result = await call('observe', payload)
    if (result.error !== undefined) {
      failed += 1
      lastError = result.error
      logger.warn?.(`[agentmemory] observe failed for ${session.id}: ${result.error}`)
    } else {
      observed += 1
    }
    if (Number(options.delayMs) > 0) await sleep(Number(options.delayMs))
  }

  const ended = await call('session/end', { sessionId: scoped })
  return {
    ok: failed === 0,
    observed,
    failed,
    ended: ended.success === true,
    project,
    error: failed === 0 ? undefined : `observe: ${lastError}`,
  }
}

/**
 * Replay many sessions sequentially, updating the ledger after each one.
 *
 * @returns {Promise<{sessions:number, observed:number, failed:number, skipped:number, results:object[]}>}
 */
async function replaySessions (options = {}) {
  const home = options.home || util.dshHome()
  const logger = options.logger || { warn: () => {}, info: () => {} }
  const ledger = readLedger(home)
  const force = options.force === true
  const rows = options.sessions || listSessions(options)
  const summary = { sessions: 0, observed: 0, failed: 0, skipped: 0, results: [] }
  for (const row of rows) {
    const session = row.pairs !== undefined ? row : loadSession(row.workspace, row.id)
    if (session === null) { summary.skipped += 1; continue }
    const known = ledger.sessions[session.id]
    if (!force && known !== undefined && known.turns === session.pairs.length && known.error === undefined) {
      summary.skipped += 1
      continue
    }
    if (options.dryRun === true) {
      summary.sessions += 1
      summary.observed += session.pairs.length
      summary.results.push({ id: session.id, workspace: session.workspace, turns: session.pairs.length, dryRun: true })
      logger.info?.(`[agentmemory] would replay ${session.id} (${session.pairs.length} turns)`)
      continue
    }
    const result = await replaySession(session, { ...options, home })
    summary.sessions += 1
    summary.observed += result.observed || 0
    summary.failed += result.failed || 0
    summary.results.push({ id: session.id, workspace: session.workspace, turns: session.pairs.length, ...result })
    ledger.sessions[session.id] = {
      turns: session.pairs.length,
      observed: result.observed || 0,
      failed: result.failed || 0,
      at: new Date().toISOString(),
      ...(result.ok ? {} : { error: result.error || 'failed' }),
    }
    writeLedger(home, ledger)
    logger.info?.(`[agentmemory] replayed ${session.id}: ${result.observed || 0}/${session.pairs.length} observed, failed=${result.failed || 0}`)
  }
  return summary
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgs (argv) {
  const options = { dryRun: false, force: false, includeMeta: false, limit: 0, delayMs: 0, verbose: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--force') options.force = true
    else if (arg === '--include-meta') options.includeMeta = true
    else if (arg === '--include-current') options.includeCurrent = true
    else if (arg === '--verbose') options.verbose = true
    else if (arg === '--limit') options.limit = Number(argv[++i]) || 0
    else if (arg === '--delay-ms') options.delayMs = Number(argv[++i]) || 0
    else if (arg === '--project') options.project = argv[++i]
    else if (arg === '--session') options.sessionIds = [argv[++i]]
    else if (arg === '--workspace') options.workspace = argv[++i]
    else if (arg === '--help' || arg === '-h') options.help = true
  }
  return options
}

async function main () {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(`Usage: node src/replay.js [options]

Replay archived DSH sessions into AgentMemory (session/start → observe → session/end).

  --limit N        replay at most N sessions (newest first)
  --session ID     replay one session id (repeatable via comma? no: once)
  --workspace W    restrict to one workspace directory name
  --project NAME   override the derived project scope
  --dry-run        print what would be replayed; no writes, no ledger
  --force          replay even sessions the ledger marks complete
  --include-meta   include hermes-evolve review forks
  --delay-ms N     pause between observe calls
  --verbose        log each session`);
    return 0
  }
  const endpoint = identity.resolveEndpoint({
    url: process.env.AGENTMEMORY_URL || '',
    secret: process.env.AGENTMEMORY_SECRET || '',
  })
  if (endpoint.valid !== true) {
    console.error('AgentMemory endpoint is not configured (set AGENTMEMORY_URL).')
    return 2
  }
  let rows = listSessions(options)
  if (typeof options.workspace === 'string' && options.workspace !== '') {
    rows = rows.filter((row) => row.workspace === options.workspace)
  }
  // The live session is still appending turns and its plugin path already
  // observes each one; replaying it would double-write the same exchanges.
  const current = typeof process.env.DSH_SESSION_ID === 'string' ? process.env.DSH_SESSION_ID.trim() : ''
  if (current !== '' && options.includeCurrent !== true) rows = rows.filter((row) => row.id !== current)
  const summary = await replaySessions({
    ...options,
    sessions: rows,
    endpoint,
    logger: {
      info: (message) => { if (options.verbose) console.log(message) },
      warn: (message) => console.warn(message),
    },
  })
  console.log(JSON.stringify({
    sessions: summary.sessions,
    observed: summary.observed,
    failed: summary.failed,
    skipped: summary.skipped,
  }))
  return summary.failed === 0 ? 0 : 1
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code }).catch((error) => {
    console.error(error && error.stack ? error.stack : error)
    process.exitCode = 1
  })
}

module.exports = {
  scanZstdFrames,
  decodeSessionFile,
  parseEvents,
  turnPairs,
  loadSession,
  listSessions,
  replaySession,
  replaySessions,
  readLedger,
  ledgerPath,
}