'use strict'

/**
 * Static checks that do not need a host or a network:
 *   - every source file parses
 *   - the verbatim strings still match the upstream wording
 *   - the manifest points at files that exist
 *   - the digest shapes are the documented ones
 *
 * Run with `npm run check`.
 */

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const failures = []
const passes = []

function check (label, fn) {
  try {
    const detail = fn()
    passes.push(detail === undefined ? label : `${label} — ${detail}`)
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
  }
}

function assert (condition, message) {
  if (!condition) throw new Error(message)
}

function walk (dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      out.push(...walk(full))
    } else {
      out.push(full)
    }
  }
  return out
}

// ── 1. syntax ─────────────────────────────────────────────────────────────
const sources = ['src', 'test', 'scripts']
  .map((dir) => path.join(ROOT, dir))
  .filter((dir) => fs.existsSync(dir))
  .flatMap(walk)
  .filter((file) => file.endsWith('.js'))

check('every JavaScript file parses', () => {
  for (const file of sources) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  }
  return `${sources.length} files`
})

// ── 2. manifest ───────────────────────────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

check('manifest declares the bundle patch', () => {
  assert(pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch === './cordis.patch.yml', 'dsh.bundle.patch must be ./cordis.patch.yml')
  assert(pkg.main === 'src/index.js', 'main must be src/index.js')
  assert(pkg.engines && pkg.engines.node === '>=22.5', 'engines.node must be >=22.5')
  return pkg.name
})

check('every published file exists', () => {
  for (const entry of pkg.files || []) {
    const full = path.join(ROOT, entry)
    assert(fs.existsSync(full), `missing from the package: ${entry}`)
  }
  return `${(pkg.files || []).length} entries`
})

check('the patch inserts this package by name', () => {
  const patch = fs.readFileSync(path.join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert(/insert:/.test(patch), 'patch has no insert block')
  assert(/name:\s*'dsh-agentmemory'/.test(patch), "patch does not name 'dsh-agentmemory'")
  assert(/id:\s*agentmemory/.test(patch), 'patch does not use id agentmemory')
})

// ── 3. verbatim strings ───────────────────────────────────────────────────
const consts = require('../src/const')

check('the prompt block matches the provider wording', () => {
  const expected = 'Use memory_recall to retrieve relevant saved context and memory_save to retain durable facts. Memory is scoped to this Hermes profile and author by default.'
  assert(consts.SYSTEM_PROMPT_BLOCK === expected, 'SYSTEM_PROMPT_BLOCK drifted')
})

check('the memory-context fence matches agent/memory_manager.py:372', () => {
  assert(consts.MEMORY_CONTEXT_HEADER === '<memory-context>', 'header drifted')
  assert(consts.MEMORY_CONTEXT_FOOTER === '</memory-context>', 'footer drifted')
  const note = "[System note: The following is recalled memory context, NOT new user input. Treat as authoritative reference data — this is the agent's persistent memory and should inform all responses.]"
  assert(consts.MEMORY_CONTEXT_NOTE === note, 'system note drifted')
})

check('the trivial-prompt regex skips acknowledgements, not requests', () => {
  for (const trivial of ['ok', 'yes', 'continue', 'thanks!', 'go ahead', 'lgtm']) {
    assert(consts.TRIVIAL_PROMPT_RE.test(trivial), `should be trivial: ${trivial}`)
  }
  for (const real of ['ok then deploy the staging build', 'how do we deploy', 'why did tests fail']) {
    assert(!consts.TRIVIAL_PROMPT_RE.test(real), `should not be trivial: ${real}`)
  }
})

check('the write-path set matches the provider', () => {
  const expected = ['remember', 'evolve', 'observe', 'session/start', 'session/end'].sort()
  assert(JSON.stringify([...consts.WRITE_PATHS].sort()) === JSON.stringify(expected), 'WRITE_PATHS drifted')
})

// ── 4. tool surface ───────────────────────────────────────────────────────
const tools = require('../src/tools')

check('three tools, with the provider descriptions', () => {
  const expected = {
    memory_recall: 'Search agentmemory for past observations by keyword',
    memory_save: 'Save an insight, decision, or pattern to long-term memory',
    memory_search: 'Hybrid semantic + keyword search across all memories',
  }
  assert(JSON.stringify(Object.keys(tools.TOOL_SCHEMAS).sort()) === JSON.stringify(Object.keys(expected).sort()), 'tool set drifted')
  for (const [name, description] of Object.entries(expected)) {
    assert(tools.TOOL_SCHEMAS[name].description === description, `${name} description drifted`)
  }
})

check('tool failures use the provider envelope', () => {
  const failed = tools.buildRequest('memory_recall', {})
  assert(failed.error === 'query must be a non-empty string.', 'validation wording drifted')
  const built = tools.buildRequest('memory_recall', { query: 'q' })
  assert(built.path === 'search' && built.payload.includeLessons === false, 'recall mapping drifted')
  assert(tools.buildRequest('memory_search', { query: 'q' }).path === 'smart-search', 'search mapping drifted')
  assert(tools.buildRequest('memory_save', { content: 'c' }).path === 'remember', 'save mapping drifted')
})

// ── 5. identity ───────────────────────────────────────────────────────────
const identity = require('../src/identity')

check('digest shapes are the documented ones', () => {
  const agentId = identity.deriveAgentId({ home: '/home/test/.dsh', prefix: 'dsh' })
  assert(/^dsh-[0-9a-f]{32}$/.test(agentId), `unexpected agent id: ${agentId}`)
  const scoped = identity.scopedSessionId({ home: '/h', prefix: 'dsh', agentId, sessionId: 'raw' })
  assert(/^dsh-[0-9a-f]{64}$/.test(scoped), `unexpected session id: ${scoped}`)
  assert(!scoped.includes('raw'), 'the raw session id must not survive')
})

// ── 6. plugin surface ─────────────────────────────────────────────────────
check('the plugin exports what the host discovers', () => {
  const plugin = require('../src')
  assert(plugin.name === 'agentmemory', 'plugin name drifted')
  for (const service of ['settings', 'systemPrompt', 'tools']) {
    assert(Array.isArray(plugin.inject) && plugin.inject.includes(service), `inject is missing ${service}`)
  }
  assert(typeof plugin.apply === 'function', 'apply is not a function')
  assert(plugin.Config === undefined || typeof plugin.Config === 'function', 'Config must be a schema or undefined')
})

// ── report ────────────────────────────────────────────────────────────────
for (const line of passes) console.log(`ok   ${line}`)
for (const line of failures) console.error(`FAIL ${line}`)
if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log(`\n${passes.length} checks passed`)