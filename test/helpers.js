'use strict'

const http = require('node:http')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** Run `fn` with a throwaway DSH_HOME, restoring the environment afterwards. */
async function withHome (fn) {
  const dir = makeTempHome('agentmemory-')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    return await fn(dir)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    removeTempHome(dir)
  }
}

/** Create a throwaway DSH_HOME under the OS temp dir. */
function makeTempHome (prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/**
 * Delete a throwaway home, refusing anything that is not really under os.tmpdir().
 *
 * dsh injects `DSH_HOME` into every shell command it runs, so a cleanup that
 * deletes an inherited `process.env.DSH_HOME` wipes the real `~/.dsh` (sessions,
 * profiles, storages). This guard turns that class of mistake into a loud
 * failure instead of silent data loss.
 */
function removeTempHome (dir) {
  if (!dir) throw new Error('refusing to delete an empty path')
  if (!fs.existsSync(dir)) return
  const root = fs.realpathSync(os.tmpdir()) + path.sep
  const target = fs.realpathSync(dir) + path.sep
  if (!target.startsWith(root)) {
    throw new Error(`refusing to delete ${dir}: not under ${os.tmpdir()}`)
  }
  fs.rmSync(dir, { recursive: true, force: true })
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

module.exports = { withHome, makeTempHome, removeTempHome, fakeServer, waitFor }