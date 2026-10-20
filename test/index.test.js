'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const plugin = require('../src')
const { fakeServer, waitFor, makeTempHome, removeTempHome } = require('./helpers')

const SYSTEM_BLOCK = 'Use memory_recall to retrieve relevant saved context and memory_save to retain durable facts. Memory is scoped to this Hermes profile and author by default.'

function makeHost (settingsValue) {
  const registered = []
  const sections = []
  const handlers = new Map()
  const warnings = []
  const agent = {
    injected: [],
    inject (message) { this.injected.push(message) },
  }
  const session = {
    id: 'sess-1',
    header: { cwd: '/tmp/project' },
    appended: [],
    append (type, data) { this.appended.push({ type, data }) },
  }
  const ctx = {
    logger: {
      info () {},
      debug () {},
      warn (...args) { warnings.push(args.join(' ')) },
    },
    settings: { describe: () => settingsValue },
    systemPrompt: { section: (section) => { sections.push(section); return () => {} } },
    tools: { schemas: () => [], register: (definition) => { registered.push(definition); return () => {} } },
    agents: { get: (id) => (id === 'sess-1' ? agent : undefined) },
    on: (name, handler) => {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
    effect: (factory) => { factory() },
  }
  return { ctx, registered, sections, handlers, agent, session, warnings }
}

function emit (host, event) {
  const handler = host.handlers.get('session/event')
  assert.equal(typeof handler, 'function', 'session/event is subscribed')
  handler(host.session, event)
}

function humanTurn (text) {
  return {
    type: 'user/message',
    data: { content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}

test('apply declares its surface: one prompt section and three tools', async () => {
  const server = await fakeServer(() => ({ status: 200, body: { results: [] } }))
  try {
    const host = makeHost([{ ns: 'agentmemory', value: { url: server.url, secret: 's' } }])
    plugin.apply(host.ctx, {})
    assert.equal(host.sections.length, 1)
    assert.equal(host.sections[0].name, 'agentmemory:guidance')
    assert.equal(host.sections[0].order, 52)
    assert.equal(host.sections[0].text({}), SYSTEM_BLOCK)
    assert.deepEqual(host.registered.map((entry) => entry.name).sort(), ['memory_recall', 'memory_save', 'memory_search'])
    assert.ok(host.handlers.has('settings/document-updated'))
  } finally {
    await server.close()
  }
})

test('a human prompt triggers recall and injects the fenced block', async () => {
  const server = await fakeServer((call) => {
    if (call.url === '/agentmemory/smart-search' && call.body.query !== undefined) {
      return { status: 200, body: { results: [{ obsId: 'o1' }] } }
    }
    return { status: 200, body: { results: [{ observation: { title: 'deploy', narrative: 'staging needs the token' } }] } }
  })
  try {
    const host = makeHost([{ ns: 'agentmemory', value: { url: server.url, secret: 'sekret' } }])
    plugin.apply(host.ctx, {})
    emit(host, humanTurn('how do we deploy?'))
    await waitFor(() => host.agent.injected.length > 0)
    const message = host.agent.injected[0]
    assert.equal(message.role, 'user')
    assert.equal(message.source.kind, 'agentmemory')
    assert.match(message.content[0].text, /^<memory-context>\n/)
    assert.match(message.content[0].text, /- deploy: staging needs the token/)
    assert.match(message.content[0].text, /<\/memory-context>$/)
    const recall = server.calls.find((call) => call.url === '/agentmemory/smart-search')
    assert.equal(recall.authorization, 'Bearer sekret')
    assert.equal(recall.body.query, 'how do we deploy?')
    assert.equal(recall.body.includeLessons, false)
    assert.ok(server.calls.some((call) => call.url === '/agentmemory/session/start'))
  } finally {
    await server.close()
  }
})

test('trivial prompts and repeated prompts do not recall', async () => {
  const server = await fakeServer(() => ({ status: 200, body: { results: [] } }))
  try {
    const host = makeHost([{ ns: 'agentmemory', value: { url: server.url, secret: 's' } }])
    plugin.apply(host.ctx, {})
    emit(host, humanTurn('ok'))
    emit(host, humanTurn('continue'))
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(server.calls.filter((call) => call.url === '/agentmemory/smart-search').length, 0)
    assert.equal(host.agent.injected.length, 0)
  } finally {
    await server.close()
  }
})

test('a completed turn is observed; an aborted one is not', async () => {
  const server = await fakeServer(() => ({ status: 200, body: { success: true } }))
  try {
    const host = makeHost([{ ns: 'agentmemory', value: { url: server.url, secret: 's', prefetchEnabled: false } }])
    plugin.apply(host.ctx, {})
    emit(host, humanTurn('please refactor the loader'))
    emit(host, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } })
    emit(host, { type: 'turn/end', data: { reason: { kind: 'aborted' } } })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(server.calls.filter((call) => call.url === '/agentmemory/observe').length, 0)

    emit(host, humanTurn('please refactor the loader'))
    emit(host, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } })
    emit(host, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await waitFor(() => server.calls.some((call) => call.url === '/agentmemory/observe'))
    const observe = server.calls.find((call) => call.url === '/agentmemory/observe')
    assert.equal(observe.body.hookType, 'post_tool_use')
    assert.equal(observe.body.data.tool_name, 'conversation')
    assert.equal(observe.body.data.tool_input, 'please refactor the loader')
    assert.equal(observe.body.data.tool_output, 'done')
    assert.match(observe.body.sessionId, /^dsh-[0-9a-f]{64}$/)
    assert.equal(observe.body.project, 'project')
    assert.equal(observe.body.cwd, '/tmp/project')
  } finally {
    await server.close()
  }
})

test('disabling the plugin removes the prompt block and the tools', async () => {
  const server = await fakeServer(() => ({ status: 200, body: { results: [] } }))
  try {
    const host = makeHost([{ ns: 'agentmemory', value: { enabled: false, url: server.url, secret: 's' } }])
    plugin.apply(host.ctx, {})
    assert.equal(host.sections[0].text({}), '')
    assert.equal(host.registered.length, 0)
    emit(host, humanTurn('how do we deploy?'))
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(server.calls.length, 0)
  } finally {
    await server.close()
  }
})

test('an unreachable server never breaks the turn', async () => {
  const host = makeHost([{ ns: 'agentmemory', value: { url: 'http://127.0.0.1:1', secret: 's' } }])
  plugin.apply(host.ctx, {})
  emit(host, humanTurn('how do we deploy?'))
  emit(host, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'answer' }] } } })
  emit(host, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(host.agent.injected.length, 0)
  assert.ok(host.warnings.some((line) => line.includes('unavailable')) || host.warnings.some((line) => line.includes('observe failed')))
})
// ── on_memory_write / on_session_end ─────────────────────────────────────
//
// Hermes' provider hooks are the reason these exist: a native memory write is
// mirrored into the provider (`on_memory_write`), and the scoped sessions this
// process opened are closed once, at a real boundary (`on_session_end`).

function makeDisposableHost (settingsValue) {
  const cleanups = []
  const handlers = new Map()
  const warnings = []
  const ctx = {
    logger: { info () {}, debug () {}, warn (...args) { warnings.push(args.join(' ')) } },
    settings: { describe: () => settingsValue },
    systemPrompt: { section: () => () => {} },
    tools: { schemas: () => [], register: () => () => {} },
    agents: { get: () => undefined },
    on: (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name) },
    effect: (factory) => {
      const cleanup = factory()
      if (typeof cleanup === 'function') cleanups.push(cleanup)
    },
  }
  return { ctx, cleanups, handlers, warnings }
}

test('a mirrored native write reaches the provider', async () => {
  const server = await fakeServer((call) => {
    if (call.url.endsWith('/agentmemory/remember')) {
      return { status: 200, body: { success: true, memory: { id: 'mem_7', content: call.body.content, project: call.body.project, agentId: call.body.agentId } } }
    }
    return { status: 200, body: { success: true } }
  })
  const previousHome = process.env.DSH_HOME
  const tempHome = makeTempHome('agentmemory-mirror-')
  process.env.DSH_HOME = tempHome
  try {
    const host = makeDisposableHost([{ ns: 'agentmemory', value: { url: server.url, secret: 'sec' } }])
    plugin.apply(host.ctx, {})
    const handler = host.handlers.get('hermes-evolve/memory-write')
    assert.equal(typeof handler, 'function', 'the mirror subscription exists')
    handler({ rows: [{ action: 'add', target: 'user', content: 'Prefers terse answers.', previous_content: '' }] })
    await waitFor(() => server.calls.some((call) => call.url.endsWith('/agentmemory/remember')))
    const call = server.calls.find((entry) => entry.url.endsWith('/agentmemory/remember'))
    assert.equal(call.body.content, 'Prefers terse answers.')
    assert.equal(call.body.type, 'fact')
    await waitFor(() => fs.existsSync(path.join(process.env.DSH_HOME, 'agentmemory-mirrors.json')))
  } finally {
    await server.close()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    // Guarded: refuses anything outside os.tmpdir(), so an inherited
    // DSH_HOME (dsh injects it into every shell command) can never be wiped.
    removeTempHome(tempHome)
  }
})

test('disposal closes the sessions this process opened, exactly once', async () => {
  const server = await fakeServer((call) => {
    if (call.url.endsWith('/agentmemory/session/start')) {
      return { status: 200, body: { success: true, session: { id: call.body.sessionId } } }
    }
    return { status: 200, body: { success: true } }
  })
  const previousHome = process.env.DSH_HOME
  const tempHome = makeTempHome('agentmemory-end-')
  process.env.DSH_HOME = tempHome
  try {
    const host = makeDisposableHost([{ ns: 'agentmemory', value: { url: server.url, secret: 'sec', prefetchEnabled: false } }])
    plugin.apply(host.ctx, {})
    const session = { id: 'sess-end', header: { cwd: '/tmp/project' }, append () {} }
    const onEvent = host.handlers.get('session/event')
    onEvent(session, { type: 'user/message', data: { content: [{ type: 'text', text: 'Remember this please.' }], source: { kind: 'user' } } })
    await waitFor(() => server.calls.some((call) => call.url.endsWith('/agentmemory/session/start')))
    for (const cleanup of host.cleanups.reverse()) cleanup()
    await waitFor(() => server.calls.some((call) => call.url.endsWith('/agentmemory/session/end')))
    const ends = server.calls.filter((call) => call.url.endsWith('/agentmemory/session/end'))
    assert.equal(ends.length, 1)
    assert.match(ends[0].body.sessionId, /^dsh-[0-9a-f]{64}$/)
  } finally {
    await server.close()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    // Guarded: refuses anything outside os.tmpdir(), so an inherited
    // DSH_HOME (dsh injects it into every shell command) can never be wiped.
    removeTempHome(tempHome)
  }
})

// ── lifecycle hooks (D5/D7/D9) ────────────────────────────────────────────

const startCalls = (server) => server.calls.filter((call) => call.url.endsWith('/agentmemory/session/start'))
const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms))
const endCalls = (server) => server.calls.filter((call) => call.url.endsWith('/agentmemory/session/end'))

function echoSessionStart (call) {
  if (call.url.endsWith('/agentmemory/session/start')) {
    return { status: 200, body: { success: true, session: { id: call.body.sessionId } } }
  }
  return { status: 200, body: { success: true } }
}

test('session disposal closes the scoped session once; agent disposal does not repeat it', async () => {
  const server = await fakeServer(echoSessionStart)
  const previousHome = process.env.DSH_HOME
  const tempHome = makeTempHome('agentmemory-disposed-')
  process.env.DSH_HOME = tempHome
  try {
    const host = makeDisposableHost([{ ns: 'agentmemory', value: { url: server.url, secret: 'sec', prefetchEnabled: false } }])
    plugin.apply(host.ctx, {})
    const session = { id: 'sess-dispose', header: { cwd: '/tmp/project' }, append () {} }
    host.handlers.get('session/event')(session, humanTurn('Remember this please.'))
    await waitFor(() => startCalls(server).length === 1)
    await settle()
    host.handlers.get('session/disposed')(session)
    await waitFor(() => endCalls(server).length === 1)
    host.handlers.get('agent/disposed')({ agent: { session } })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(endCalls(server).length, 1)
    assert.match(endCalls(server)[0].body.sessionId, /^dsh-[0-9a-f]{64}$/)
  } finally {
    await server.close()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    removeTempHome(tempHome)
  }
})

test('a resumed/cleared lifecycle closes the previous scoped session, then opens one', async () => {
  const server = await fakeServer(echoSessionStart)
  const previousHome = process.env.DSH_HOME
  const tempHome = makeTempHome('agentmemory-switch-')
  process.env.DSH_HOME = tempHome
  try {
    const host = makeDisposableHost([{ ns: 'agentmemory', value: { url: server.url, secret: 'sec', prefetchEnabled: false } }])
    plugin.apply(host.ctx, {})
    const session = { id: 'sess-switch', header: { cwd: '/tmp/project' }, append () {} }
    host.handlers.get('session/event')(session, humanTurn('first turn'))
    await waitFor(() => startCalls(server).length === 1)
    await settle()
    host.handlers.get('agent/created')({ agent: { session }, source: 'resume' })
    await waitFor(() => startCalls(server).length === 2)
    await waitFor(() => endCalls(server).length === 1)
    // Hermes' on_session_switch ends the old scoped session before opening the
    // new one (`__init__.py:565-576`); the scoped id is unchanged for a resume.
    const endIndex = server.calls.findIndex((call) => call.url.endsWith('/agentmemory/session/end'))
    const secondStartIndex = server.calls.findIndex((call, index) => index > 0 && call.url.endsWith('/agentmemory/session/start'))
    assert.ok(endIndex < secondStartIndex, 'session/end precedes the reopened session/start')
    assert.equal(startCalls(server)[0].body.sessionId, startCalls(server)[1].body.sessionId)
  } finally {
    await server.close()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    removeTempHome(tempHome)
  }
})

test('a mismatched session/start is never cached, warns once, and is retried', async () => {
  const server = await fakeServer((call) => {
    if (call.url.endsWith('/agentmemory/session/start')) {
      return { status: 200, body: { success: true, session: { id: 'someone-elses-session' } } }
    }
    return { status: 200, body: { success: true } }
  })
  const previousHome = process.env.DSH_HOME
  const tempHome = makeTempHome('agentmemory-mismatch-')
  process.env.DSH_HOME = tempHome
  try {
    const host = makeDisposableHost([{ ns: 'agentmemory', value: { url: server.url, secret: 'sec', prefetchEnabled: false } }])
    plugin.apply(host.ctx, {})
    const session = { id: 'sess-mismatch', header: { cwd: '/tmp/project' }, append () {} }
    const onEvent = host.handlers.get('session/event')
    onEvent(session, humanTurn('first ask'))
    await waitFor(() => startCalls(server).length === 1)
    await settle()
    onEvent(session, humanTurn('second ask'))
    await waitFor(() => startCalls(server).length === 2)
    for (const cleanup of host.cleanups.reverse()) cleanup()
    await new Promise((resolve) => setTimeout(resolve, 150))
    // D9: an uncached session is never closed, and the warning is emitted once
    // even though the start was retried.
    assert.equal(endCalls(server).length, 0)
    assert.equal(host.warnings.filter((line) => line.includes('did not confirm')).length, 1)
  } finally {
    await server.close()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    removeTempHome(tempHome)
  }
})

test('subagent sessions never start, observe, or save', async () => {
  const server = await fakeServer(() => ({ status: 200, body: { success: true } }))
  try {
    const host = makeHost([{ ns: 'agentmemory', value: { url: server.url, secret: 's', prefetchEnabled: false } }])
    plugin.apply(host.ctx, {})
    const session = { id: 'sub-1', header: { cwd: '/tmp/project', origin: 'subagent' }, append () {} }
    const onEvent = host.handlers.get('session/event')
    onEvent(session, humanTurn('child task'))
    onEvent(session, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'child done' }] } } })
    onEvent(session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(server.calls.length, 0)
    const save = host.registered.find((definition) => definition.name === 'memory_save')
    const output = await save.execute({ content: 'nope' }, { agent: { session } })
    const parsed = JSON.parse(output)
    assert.equal(parsed.success, false)
    assert.equal(parsed.errorCode, 'read_only_context')
    assert.equal(parsed.error, 'AgentMemory writes are disabled outside the primary active session.')
  } finally {
    await server.close()
  }
})

test('compaction/start recalls the last five messages and injects the fenced block', async () => {
  const server = await fakeServer((call) => {
    if (call.url.endsWith('/agentmemory/smart-search')) {
      return { status: 200, body: { results: [{ observation: { title: 'deploy', narrative: 'staging needs the token' } }] } }
    }
    return { status: 200, body: { success: true } }
  })
  try {
    const host = makeHost([{ ns: 'agentmemory', value: { url: server.url, secret: 's' } }])
    plugin.apply(host.ctx, {})
    host.session.deriveMessages = () => ['one', 'two', 'three', 'four', 'five', 'six'].map((text) => ({
      role: 'user',
      content: [{ type: 'text', text }],
    }))
    emit(host, { type: 'compaction/start', data: { compactionId: 'c1', turn: 1 } })
    await waitFor(() => host.agent.injected.length > 0)
    const recall = server.calls.find((call) => call.url.endsWith('/agentmemory/smart-search'))
    assert.equal(recall.body.query, 'two three four five six')
    assert.match(host.agent.injected[0].content[0].text, /^<memory-context>\n/)
    assert.match(host.agent.injected[0].content[0].text, /- deploy: staging needs the token/)
  } finally {
    await server.close()
  }
})
