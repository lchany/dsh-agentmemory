'use strict'

// Ported from the Hermes AgentMemory provider's `on_memory_write` hook
// (`~/.hermes/plugins/agentmemory/__init__.py:582-660`).
//
// Hermes fires this hook after every successful write of the BUILT-IN memory
// store (MEMORY.md / USER.md): "Mirror a built-in memory-tool write (action:
// add | replace | remove; target: memory | user; metadata: provenance …)".
// Only add/update/replace are mirrored; a native replacement is propagated to
// the provider as an `evolve` of the record this provider created earlier, so
// the provider never accumulates a second copy of the same fact.
//
// Ownership discipline (the reason this file exists): only ids this provider
// returned may be evolved later. The id must start with `mem_` and the returned
// record must echo back the content/project/agentId we sent — otherwise the
// mirror write is reported and nothing is recorded, because evolving somebody
// else's record would rewrite an unrelated memory.

const fs = require('node:fs/promises')
const path = require('node:path')
const { sha256 } = require('./util')
const http = require('./http')

const MIRROR_FILE = 'agentmemory-mirrors.json'
const MIRROR_ACTIONS = new Set(['add', 'update', 'replace'])
const REPLACING_ACTIONS = new Set(['replace', 'update'])

/** Ownership keys are scoped to the endpoint + identity + target + content, so a
 *  different server or agent never inherits an id it did not mint. */
function mirrorKey ({ base, project, agentId, home, target, content }) {
  return sha256(JSON.stringify([String(base), String(project), String(agentId), String(home), String(target), String(content)]))
}

function mirrorPath (home) {
  return path.join(home, MIRROR_FILE)
}

async function readMirrors (home) {
  const file = mirrorPath(home)
  let raw
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return {}
    throw error
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error('invalid native mirror ownership file')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid native mirror ownership file')
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof key !== 'string' || typeof value !== 'string') {
      throw new Error('invalid native mirror ownership file')
    }
  }
  return parsed
}

async function writeMirrors (home, records) {
  const file = mirrorPath(home)
  const temporary = path.join(home, `.agentmemory-mirrors-${process.pid}-${Date.now().toString(36)}`)
  await fs.writeFile(temporary, JSON.stringify(records), { mode: 0o600 })
  try {
    await fs.rename(temporary, file)
  } catch (error) {
    try { await fs.unlink(temporary) } catch { /* already gone */ }
    throw error
  }
}

/**
 * Mirror one built-in memory write into the provider.
 *
 * @param {{action:string,target:string,content:string,previous_content?:string}} row
 * @param {{endpoint:{base:string,secret:string,valid:boolean}, project:string, agentId:string,
 *          home:string, timeoutMs:number, writeEnabled:boolean, stopped?:()=>boolean,
 *          warn?:(message:string)=>void}} deps
 * @returns {Promise<{status:'skipped'|'evolved'|'remembered'|'error', detail?:string}>}
 */
async function mirrorMemoryWrite (row, deps) {
  const warn = typeof deps.warn === 'function' ? deps.warn : () => {}
  if (row === null || typeof row !== 'object') return { status: 'skipped' }
  const action = typeof row.action === 'string' ? row.action : ''
  const target = typeof row.target === 'string' ? row.target : 'memory'
  const content = typeof row.content === 'string' ? row.content : ''
  if (!MIRROR_ACTIONS.has(action) || content.trim() === '') return { status: 'skipped' }
  if (deps.writeEnabled !== true) return { status: 'skipped' }
  if (typeof deps.stopped === 'function' && deps.stopped()) return { status: 'skipped' }
  if (deps.endpoint === undefined || deps.endpoint.valid !== true) return { status: 'skipped' }

  const base = deps.endpoint.base
  const secret = deps.endpoint.secret
  const project = deps.project
  const agentId = deps.agentId
  if (typeof agentId !== 'string' || agentId === '') return { status: 'skipped' }

  const previous = typeof row.previous_content === 'string' && row.previous_content !== '' ? row.previous_content : ''
  const replacing = REPLACING_ACTIONS.has(action)

  let records
  try {
    records = await readMirrors(deps.home)
  } catch (error) {
    warn(`[agentmemory] native memory mirroring could not complete (${errorText(error)}); check the active DSH home and retry.`)
    return { status: 'error', detail: errorText(error) }
  }

  const oldKey = previous !== '' ? mirrorKey({ base, project, agentId, home: deps.home, target, content: previous }) : null
  const oldId = oldKey !== null ? records[oldKey] : undefined

  let result
  let mode
  if (replacing && typeof oldId === 'string' && oldId !== '') {
    if (previous === content) return { status: 'skipped' }
    mode = 'evolved'
    result = await http.api(base, 'evolve', { memoryId: oldId, newContent: content }, { secret, timeoutMs: deps.timeoutMs })
    if (result.success !== true) {
      warn('[agentmemory] native replacement could not evolve its previous record; inspect the reported error before retrying.')
      return { status: 'error', detail: result.error }
    }
  } else {
    mode = 'remembered'
    result = await http.api(base, 'remember', { content, type: 'fact', project, agentId }, { secret, timeoutMs: deps.timeoutMs })
  }

  const memory = result !== null && typeof result === 'object' && typeof result.memory === 'object' && result.memory !== null
    ? result.memory
    : {}
  const newId = typeof memory.id === 'string' ? memory.id : ''
  if (result.success !== true || newId === '') return { status: 'error', detail: result.error }
  if (!newId.startsWith('mem_') ||
      memory.content !== content ||
      memory.project !== project ||
      memory.agentId !== agentId) {
    warn('[agentmemory] native mirror write did not establish record ownership; replacement tracking was not updated.')
    return { status: 'error', detail: 'ownership-mismatch' }
  }

  const newKey = mirrorKey({ base, project, agentId, home: deps.home, target, content })
  records[newKey] = newId
  if (replacing && oldKey !== null && oldKey !== newKey && typeof oldId === 'string') delete records[oldKey]
  try {
    await writeMirrors(deps.home, records)
  } catch (error) {
    warn(`[agentmemory] native memory mirroring could not complete (${errorText(error)}); check the active DSH home and retry.`)
    return { status: 'error', detail: errorText(error) }
  }
  if (replacing && (oldKey === null || typeof oldId !== 'string')) {
    warn('[agentmemory] native replacement saved; previous record ownership is unavailable, so the previous record could not be superseded.')
  }
  return { status: mode }
}

function errorText (error) {
  return error === null || error === undefined
    ? 'unknown error'
    : (typeof error.message === 'string' ? error.message : String(error))
}

module.exports = {
  MIRROR_FILE,
  MIRROR_ACTIONS,
  REPLACING_ACTIONS,
  mirrorKey,
  mirrorPath,
  readMirrors,
  writeMirrors,
  mirrorMemoryWrite,
}