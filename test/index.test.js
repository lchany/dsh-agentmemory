'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const plugin = require('../src')
const { fakeServer, waitFor } = require('./helpers')

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