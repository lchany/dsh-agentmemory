'use strict'

const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** Run `fn` with a throwaway DSH_HOME, restoring the environment afterwards. */
async function withHome (fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    return await fn(dir)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** Start a throwaway AgentMemory-shaped server; returns `{url, calls, close}`. */
async function fakeServer (handler) {
  const calls = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      let parsed = null
      try { parsed = JSON.parse(body) } catch { parsed = null }
      const call = { method: req.method, url: req.url, body: parsed, authorization: req.headers.authorization }
      calls.push(call)
      const reply = handler(call) || { status: 200, body: { success: true } }
      res.writeHead(reply.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply.body))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function waitFor (predicate, { timeoutMs = 3000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve()
      if (Date.now() > deadline) return reject(new Error('timed out waiting for condition'))
      setTimeout(tick, intervalMs)
    }
    tick()
  })
}

module.exports = { withHome, fakeServer, waitFor }