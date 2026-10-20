'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const mirror = require('../src/mirror')
const { withHome, fakeServer } = require('./helpers')

const PROJECT = 'demo'
const AGENT = 'dsh-0123456789abcdef0123456789abcdef'

function ownerOf (segment) {
  return {
    status: 200,
    body: {
      success: true,
      memory: { id: `mem_${segment}`, content: undefined, project: PROJECT, agentId: AGENT },
    },
  }
}

/** Serve `remember`/`evolve` and echo the content back so the ownership check
 *  passes (the provider echoes what it stored; a mismatch is a real signal). */
function server () {
  return fakeServer((call) => {
    const body = call.body || {}
    if (call.url.endsWith('/agentmemory/remember')) {
      return { status: 200, body: { success: true, memory: { id: 'mem_1', content: body.content, project: body.project, agentId: body.agentId } } }
    }
    if (call.url.endsWith('/agentmemory/evolve')) {
      return { status: 200, body: { success: true, memory: { id: body.memoryId, content: body.newContent, project: PROJECT, agentId: AGENT } } }
    }
    return { status: 200, body: { success: true } }
  })
}

function deps (home, url, extra = {}) {
  return {
    endpoint: { base: url, secret: 'sec', valid: true },
    project: PROJECT,
    agentId: AGENT,
    home,
    timeoutMs: 2000,
    writeEnabled: true,
    warn: () => {},
    ...extra,
  }
}

test('an added entry is remembered and its id recorded for later replacement', async () => {
  await withHome(async (home) => {
    const srv = await server()
    try {
      const outcome = await mirror.mirrorMemoryWrite({ action: 'add', target: 'user', content: 'Prefers Chinese answers.' }, deps(home, srv.url))
      assert.equal(outcome.status, 'remembered')
      const call = srv.calls.at(-1)
      assert.match(call.url, /\/agentmemory\/remember$/)
      assert.deepEqual(call.body, { content: 'Prefers Chinese answers.', type: 'fact', project: PROJECT, agentId: AGENT })
      assert.equal(call.authorization, 'Bearer sec')
      const records = JSON.parse(fs.readFileSync(path.join(home, mirror.MIRROR_FILE), 'utf8'))
      const key = mirror.mirrorKey({ base: srv.url, project: PROJECT, agentId: AGENT, home, target: 'user', content: 'Prefers Chinese answers.' })
      assert.equal(records[key], 'mem_1')
    } finally {
      await srv.close()
    }
  })
})

test('a replacement evolves the record the provider minted earlier', async () => {
  await withHome(async (home) => {
    const srv = await server()
    try {
      await mirror.mirrorMemoryWrite({ action: 'add', target: 'memory', content: 'Old fact.' }, deps(home, srv.url))
      const outcome = await mirror.mirrorMemoryWrite(
        { action: 'replace', target: 'memory', content: 'New fact.', previous_content: 'Old fact.' },
        deps(home, srv.url),
      )
      assert.equal(outcome.status, 'evolved')
      const call = srv.calls.at(-1)
      assert.match(call.url, /\/agentmemory\/evolve$/)
      assert.deepEqual(call.body, { memoryId: 'mem_1', newContent: 'New fact.' })
      const records = JSON.parse(fs.readFileSync(path.join(home, mirror.MIRROR_FILE), 'utf8'))
      const keys = Object.keys(records)
      assert.equal(keys.length, 1, 'the old ownership key is dropped once superseded')
      assert.equal(
        keys[0],
        mirror.mirrorKey({ base: srv.url, project: PROJECT, agentId: AGENT, home, target: 'memory', content: 'New fact.' }),
      )
    } finally {
      await srv.close()
    }
  })
})

test('a replacement with no recorded ownership is remembered, not evolved', async () => {
  await withHome(async (home) => {
    const srv = await server()
    const warnings = []
    try {
      const outcome = await mirror.mirrorMemoryWrite(
        { action: 'replace', target: 'memory', content: 'New fact.', previous_content: 'Never seen.' },
        deps(home, srv.url, { warn: (message) => warnings.push(message) }),
      )
      assert.equal(outcome.status, 'remembered')
      assert.match(srv.calls.at(-1).url, /\/agentmemory\/remember$/)
      assert.ok(warnings.some((line) => line.includes('could not be superseded')))
    } finally {
      await srv.close()
    }
  })
})

test('removals are not mirrored and blank content is ignored', async () => {
  await withHome(async (home) => {
    const srv = await server()
    try {
      assert.equal((await mirror.mirrorMemoryWrite({ action: 'remove', target: 'memory', content: 'gone' }, deps(home, srv.url))).status, 'skipped')
      assert.equal((await mirror.mirrorMemoryWrite({ action: 'add', target: 'memory', content: '   ' }, deps(home, srv.url))).status, 'skipped')
      assert.equal((await mirror.mirrorMemoryWrite({ action: 'add', target: 'memory', content: 'x' }, deps(home, srv.url, { writeEnabled: false }))).status, 'skipped')
      assert.equal(srv.calls.length, 0)
    } finally {
      await srv.close()
    }
  })
})

test('a provider that does not echo the write leaves ownership untouched', async () => {
  await withHome(async (home) => {
    const srv = await fakeServer(() => ({
      status: 200,
      body: { success: true, memory: { id: 'mem_9', content: 'something else', project: PROJECT, agentId: AGENT } },
    }))
    const warnings = []
    try {
      const outcome = await mirror.mirrorMemoryWrite(
        { action: 'add', target: 'memory', content: 'Kept.' },
        deps(home, srv.url, { warn: (message) => warnings.push(message) }),
      )
      assert.equal(outcome.status, 'error')
      assert.equal(outcome.detail, 'ownership-mismatch')
      assert.ok(!fs.existsSync(path.join(home, mirror.MIRROR_FILE)))
      assert.ok(warnings.some((line) => line.includes('did not establish record ownership')))
    } finally {
      await srv.close()
    }
  })
})

test('an unreadable ownership file is reported and never overwritten', async () => {
  await withHome(async (home) => {
    const srv = await server()
    fs.writeFileSync(path.join(home, mirror.MIRROR_FILE), '{"broken":1')
    const warnings = []
    try {
      const outcome = await mirror.mirrorMemoryWrite(
        { action: 'add', target: 'memory', content: 'Kept.' },
        deps(home, srv.url, { warn: (message) => warnings.push(message) }),
      )
      assert.equal(outcome.status, 'error')
      assert.equal(fs.readFileSync(path.join(home, mirror.MIRROR_FILE), 'utf8'), '{"broken":1')
      assert.ok(warnings.some((line) => line.includes('could not complete')))
    } finally {
      await srv.close()
    }
  })
})