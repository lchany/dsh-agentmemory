'use strict'

/**
 * The AgentMemory HTTP client.
 *
 * One shape only: POST `<base>/agentmemory/<path>` with a bearer secret and a
 * JSON body. Error codes mirror the provider plugin's `_api` result contract
 * (`authentication`, `http_error`, `unavailable`) so a caller can distinguish
 * "the secret is wrong" from "the server is down" without parsing prose.
 */

const { LIMITS, WRITE_PATHS } = require('./const')

const DEFAULT_TIMEOUT_MS = LIMITS.HTTP_TIMEOUT_MS

/** Accept only http(s) URLs without credentials, query, or fragment. */
function validateUrl (base) {
  if (typeof base !== 'string' || base.trim() === '') return false
  if (/\s/.test(base) || base.includes('?') || base.includes('#')) return false
  let parsed
  try {
    parsed = new URL(base)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') return false
  return parsed.hostname !== ''
}

function endpointFor (base, apiPath) {
  return `${String(base).replace(/\/+$/, '')}/agentmemory/${String(apiPath).replace(/^\/+/, '')}`
}

function isWritePath (apiPath) {
  return WRITE_PATHS.has(apiPath)
}

/**
 * POST one agentmemory API call.
 *
 * Never throws: transport and protocol failures come back as
 * `{ error, errorCode, status? }` so the caller stays fail-open.
 */
async function api (base, apiPath, body, options = {}) {
  if (!validateUrl(base)) {
    return { error: 'invalid endpoint (expected an http(s) URL without credentials, query, or fragment)', errorCode: 'configuration' }
  }
  const secret = typeof options.secret === 'string' ? options.secret : ''
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : DEFAULT_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  const headers = { 'content-type': 'application/json' }
  if (secret !== '') headers.authorization = `Bearer ${secret}`
  try {
    const response = await fetch(endpointFor(base, apiPath), {
      method: 'POST',
      headers,
      body: JSON.stringify(body === undefined ? {} : body),
      signal: controller.signal,
      redirect: 'error',
    })
    const text = await response.text()
    let payload = null
    if (text !== '') {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = null
      }
    }
    if (response.status === 401 || response.status === 403) {
      return { error: 'AgentMemory rejected the credential', errorCode: 'authentication', status: response.status, body: payload }
    }
    if (!response.ok) {
      const detail = payload !== null && typeof payload === 'object' && typeof payload.error === 'string'
        ? payload.error
        : text.slice(0, 300)
      return { error: `AgentMemory HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`, errorCode: 'http_error', status: response.status, body: payload }
    }
    if (payload === null) return { success: true }
    return payload
  } catch (error) {
    const name = error !== null && typeof error === 'object' ? error.name : ''
    const detail = name === 'AbortError'
      ? `timed out after ${timeoutMs}ms`
      : (error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error))
    return { error: `AgentMemory unavailable: ${detail}`, errorCode: 'unavailable', detail }
  } finally {
    clearTimeout(timer)
  }
}

module.exports = { api, validateUrl, endpointFor, isWritePath, DEFAULT_TIMEOUT_MS }