'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const prefetch = require('../src/prefetch')
const { fakeServer } = require('./helpers')

const NOTE = '[System note: The following is recalled memory context, NOT new user input. Treat as authoritative reference data — this is the agent\'s persistent memory and should inform all responses.]'

test('an empty recall produces no block at all', () => {
  assert.equal(prefetch.buildMemoryContextBlock(''), '')
  assert.equal(prefetch.buildMemoryContextBlock('   \n '), '')
})

test('the block is byte-identical to the Hermes fence', () => {
  const block = prefetch.buildMemoryContextBlock('- prefers draft PRs')
  assert.equal(block, `<memory-context>\n${NOTE}\n\n- prefers draft PRs\n</memory-context>`)
})

test('a provider-supplied block is stripped as a whole, and stray tags vanish', () => {
  // Hermes drops the entire pre-wrapped block (`_INTERNAL_CONTEXT_RE` runs first)
  // and still emits the fence around the now-empty body: the emptiness check runs
  // before sanitization, not after. Faithful port, warts included.
  const raw = `<memory-context>\n${NOTE}\n\n- one\n</memory-context>`
  assert.equal(prefetch.buildMemoryContextBlock(raw), `<memory-context>\n${NOTE}\n\n\n</memory-context>`)
  assert.equal(prefetch.buildMemoryContextBlock('a </memory-context> b'), `<memory-context>\n${NOTE}\n\na  b\n</memory-context>`)
  const noteOnly = `${NOTE} tail`
  assert.equal(prefetch.buildMemoryContextBlock(noteOnly), `<memory-context>\n${NOTE}\n\ntail\n</memory-context>`)
})

test('duplicate bullets collapse, continuations survive', () => {
  const raw = [
    '- prefs: draft PRs',
    '  (logged 12 Jan, builtin)',
    '- prefs: draft PRs',
    '- deploy uses staging token',
  ].join('\n')
  const kept = prefetch.dropRepeatedRecallLines(raw)
  assert.equal(kept, [
    '- prefs: draft PRs',
    '  (logged 12 Jan, builtin)',
    '- prefs: draft PRs',
    '- deploy uses staging token',
  ].join('\n'))

  const plain = ['- same', '- same', 'heading', '- same'].join('\n')
  assert.equal(prefetch.dropRepeatedRecallLines(plain), ['- same', 'heading', '- same'].join('\n'))
})

test('recall rows are clipped exactly like the provider', () => {
  const rows = Array.from({ length: 7 }, (_, index) => ({
    observation: { title: `t${index}`.padEnd(300, 'x'), narrative: `n${index}`.padEnd(2000, 'y') },
  }))
  const text = prefetch.formatRecallRows(rows)
  const lines = text.split('\n')
  assert.equal(lines.length, 5)
  assert.match(lines[0], /^\- t0x+: n0y+$/)
  assert.ok(lines[0].length < 300 + 1000 + 5)
  assert.equal(prefetch.formatRecallRows([{ observation: { title: 1 } }]), '')
  assert.equal(prefetch.formatRecallRows(null), '')
})

test('prefetchRecall expands ids and forwards the bearer secret', async () => {
  const server = await fakeServer((call) => {
    if (call.body !== null && Array.isArray(call.body.expandIds)) {
      return { status: 200, body: { results: [{ observation: { title: 'expanded', narrative: 'narrative text' } }] } }
    }
    return { status: 200, body: { results: [{ obsId: 'o1', sessionId: 's1' }] } }
  })
  try {
    const result = await prefetch.prefetchRecall({
      endpoint: { base: server.url, secret: 'sekret', valid: true },
      project: 'proj',
      agentId: 'agent',
      query: 'how do we deploy',
    })
    assert.equal(result.error, undefined)
    assert.equal(result.text, '- expanded: narrative text')
    assert.equal(server.calls.length, 2)
    assert.equal(server.calls[0].url, '/agentmemory/smart-search')
    assert.equal(server.calls[0].authorization, 'Bearer sekret')
    assert.deepEqual(server.calls[0].body.expandIds, undefined)
    assert.deepEqual(server.calls[1].body.expandIds, [{ obsId: 'o1', sessionId: 's1' }])
  } finally {
    await server.close()
  }
})

test('prefetch fails open with a usable error', async () => {
  const result = await prefetch.prefetchRecall({
    endpoint: { base: 'http://127.0.0.1:1', secret: '', valid: true },
    query: 'x',
    timeoutMs: 500,
  })
  assert.equal(result.text, '')
  assert.match(result.error, /unavailable/)
  const unconfigured = await prefetch.prefetchRecall({ endpoint: { valid: false }, query: 'x' })
  assert.match(unconfigured.error, /not configured/)
})

test('observe payload matches the provider shape', () => {
  const payload = prefetch.observePayload({
    sessionId: 'dsh-abc',
    project: 'proj',
    cwd: '/tmp/p',
    agentId: 'agent',
    user: 'u'.repeat(900),
    assistant: 'a'.repeat(3000),
    now: new Date('2026-10-20T10:11:12.345Z'),
  })
  assert.equal(payload.hookType, 'post_tool_use')
  assert.equal(payload.timestamp, '2026-10-20T10:11:12Z')
  assert.equal(payload.data.tool_name, 'conversation')
  assert.equal(payload.data.tool_input.length, 500)
  assert.equal(payload.data.tool_output.length, 2000)
  assert.equal(payload.sessionId, 'dsh-abc')
})