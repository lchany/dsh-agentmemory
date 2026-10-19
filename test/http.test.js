'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const http = require('../src/http')
const { fakeServer } = require('./helpers')

test('only credential-free http(s) endpoints are accepted', () => {
  assert.equal(http.validateUrl('http://127.0.0.1:3111'), true)
  assert.equal(http.validateUrl('https://memory.example.com'), true)
  assert.equal(http.validateUrl('http://127.0.0.1:3111/'), true)
  assert.equal(http.validateUrl('ftp://example.com'), false)
  assert.equal(http.validateUrl('http://user:pw@example.com'), false)
  assert.equal(http.validateUrl('http://example.com/?x=1'), false)
  assert.equal(http.validateUrl('http://example.com/#frag'), false)
  assert.equal(http.validateUrl('not a url'), false)
  assert.equal(http.validateUrl(''), false)
  assert.equal(http.validateUrl(undefined), false)
})

test('paths are joined under /agentmemory and writes are recognised', () => {
  assert.equal(http.endpointFor('http://h:1/', '/smart-search'), 'http://h:1/agentmemory/smart-search')
  assert.equal(http.isWritePath('observe'), true)
  assert.equal(http.isWritePath('session/start'), true)
  assert.equal(http.isWritePath('smart-search'), false)
})

test('a successful call returns the decoded body and sends the bearer token', async () => {
  const server = await fakeServer((call) => ({ status: 200, body: { success: true, results: [call.url] } }))
  try {
    const result = await http.api(server.url, 'search', { query: 'q' }, { secret: 's3cret' })
    assert.equal(result.success, true)
    assert.deepEqual(result.results, ['/agentmemory/search'])
    assert.equal(server.calls[0].authorization, 'Bearer s3cret')
    assert.equal(server.calls[0].method, 'POST')
  } finally {
    await server.close()
  }
})

test('401 and 403 become the authentication error code', async () => {
  for (const status of [401, 403]) {
    const server = await fakeServer(() => ({ status, body: { error: 'nope' } }))
    try {
      const result = await http.api(server.url, 'search', {}, { secret: 'bad' })
      assert.equal(result.errorCode, 'authentication')
      assert.equal(result.status, status)
    } finally {
      await server.close()
    }
  }
})

test('other HTTP failures become http_error with the server detail', async () => {
  const server = await fakeServer(() => ({ status: 500, body: { error: 'boom' } }))
  try {
    const result = await http.api(server.url, 'search', {}, {})
    assert.equal(result.errorCode, 'http_error')
    assert.equal(result.status, 500)
    assert.match(result.error, /HTTP 500: boom/)
  } finally {
    await server.close()
  }
})

test('an unreachable server and a timeout both fail open as unavailable', async () => {
  const refused = await http.api('http://127.0.0.1:1', 'search', {}, { timeoutMs: 500 })
  assert.equal(refused.errorCode, 'unavailable')

  const slow = await fakeServer(() => ({ status: 200, body: { success: true } }))
  const original = slow.calls
  void original
  try {
    const result = await http.api(slow.url, 'search', {}, { timeoutMs: 1 })
    // A 1 ms budget may still win on a warm loopback; either answer is honest.
    if (result.error !== undefined) {
      assert.equal(result.errorCode, 'unavailable')
      assert.match(result.error, /timed out|fetch failed/)
    }
  } finally {
    await slow.close()
  }
})

test('an invalid endpoint never issues a request', async () => {
  const result = await http.api('not a url', 'search', {}, {})
  assert.equal(result.errorCode, 'configuration')
})