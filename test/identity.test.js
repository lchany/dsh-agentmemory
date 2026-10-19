'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const identity = require('../src/identity')

test('the derived agent id is stable, prefixed, and home-scoped', () => {
  const one = identity.deriveAgentId({ home: '/home/u/.dsh', prefix: 'dsh' })
  const two = identity.deriveAgentId({ home: '/home/u/.dsh', prefix: 'dsh' })
  assert.equal(one, two)
  assert.match(one, /^dsh-[0-9a-f]{32}$/)
  assert.notEqual(one, identity.deriveAgentId({ home: '/home/u/other', prefix: 'dsh' }))
  assert.ok(identity.deriveAgentId({ home: '/home/u/.dsh', prefix: 'hx' }).startsWith('hx-'))
})

test('an explicit agent id wins and is validated', () => {
  assert.equal(identity.resolveAgentId({ agentId: 'team-agent' }), 'team-agent')
  assert.throws(() => identity.resolveAgentId({ agentId: '*' }), /wildcard/)
  assert.throws(() => identity.resolveAgentId({ agentId: 'a'.repeat(129) }), /at most 128/)
})

test('session ids are digested, never forwarded raw', () => {
  const scoped = identity.scopedSessionId({ home: '/h', prefix: 'dsh', agentId: 'a', sessionId: 'raw-session' })
  assert.match(scoped, /^dsh-[0-9a-f]{64}$/)
  assert.ok(!scoped.includes('raw-session'))
  assert.notEqual(scoped, identity.scopedSessionId({ home: '/h', prefix: 'dsh', agentId: 'b', sessionId: 'raw-session' }))
  assert.deepEqual(identity.sessionPayload({ home: '/h', prefix: 'dsh', agentId: 'a', sessionId: 'raw-session', project: 'p', cwd: '/c' }), {
    sessionId: scoped,
    project: 'p',
    cwd: '/c',
    agentId: 'a',
  })
})

test('endpoint resolution prefers settings, then the environment, then the default', () => {
  const savedUrl = process.env.AGENTMEMORY_URL
  const savedSecret = process.env.AGENTMEMORY_SECRET
  try {
    delete process.env.AGENTMEMORY_URL
    delete process.env.AGENTMEMORY_SECRET
    assert.deepEqual(identity.resolveEndpoint({}), {
      base: 'http://localhost:3111',
      secret: '',
      valid: true,
      plaintextBearer: false,
    })

    process.env.AGENTMEMORY_URL = 'https://env.example.com'
    process.env.AGENTMEMORY_SECRET = 'env-secret'
    const fromEnv = identity.resolveEndpoint({})
    assert.equal(fromEnv.base, 'https://env.example.com')
    assert.equal(fromEnv.secret, 'env-secret')

    const fromSettings = identity.resolveEndpoint({ url: 'http://127.0.0.1:9000', secret: 's' })
    assert.equal(fromSettings.base, 'http://127.0.0.1:9000')
    assert.equal(fromSettings.secret, 's')
    assert.equal(fromSettings.plaintextBearer, false, 'loopback http is not flagged')
  } finally {
    if (savedUrl === undefined) delete process.env.AGENTMEMORY_URL
    else process.env.AGENTMEMORY_URL = savedUrl
    if (savedSecret === undefined) delete process.env.AGENTMEMORY_SECRET
    else process.env.AGENTMEMORY_SECRET = savedSecret
  }
})

test('a bearer token over remote plaintext http is flagged', () => {
  const resolved = identity.resolveEndpoint({ url: 'http://101.42.3.30:3111', secret: 's' })
  assert.equal(resolved.plaintextBearer, true)
  assert.equal(identity.isLoopback('http://127.0.0.1:3111'), true)
  assert.equal(identity.isLoopback('http://localhost:3111'), true)
  assert.equal(identity.isLoopback('http://101.42.3.30:3111'), false)
})