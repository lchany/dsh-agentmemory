'use strict'

/**
 * Small helpers: text flattening, digests, path/home resolution, sanitization.
 *
 * Nothing here talks to the network; `http.js` owns that.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

function dshHome () {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv === '' ? path.join(os.homedir(), '.dsh') : fromEnv
}

function sha256 (value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')
}

/** Join message content blocks into plain text; non-text blocks are skipped. */
function contentToText (content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

function messageText (message) {
  if (message === null || typeof message !== 'object') return ''
  return contentToText(message.content)
}

/** True when a message came from a human prompt rather than an injection. */
function isHumanMessage (message) {
  const source = message !== null && typeof message === 'object' ? message.source : undefined
  if (source === null || typeof source !== 'object') return false
  return source.kind === 'user'
}

function truncate (text, max) {
  const value = typeof text === 'string' ? text : String(text ?? '')
  const limit = Number(max)
  if (!Number.isFinite(limit) || limit <= 0) return ''
  return value.length <= limit ? value : value.slice(0, limit)
}

/** Collapse whitespace and strip zero-width/control characters. */
function sanitizeText (text) {
  const value = typeof text === 'string' ? text : ''
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim()
}

/** The provider's `is_trivial_prompt`: empty, slash command, or a bare acknowledgement. */
function isTrivialPrompt (text, pattern) {
  const stripped = sanitizeText(text)
  if (stripped === '') return true
  if (stripped.startsWith('/')) return true
  return pattern.test(stripped)
}

/**
 * Canonical project scope, mirroring the provider's `_resolve_project` order:
 * explicit setting, environment override, git repository basename, cwd basename.
 */
function resolveProject ({ explicit, cwd, envValue } = {}) {
  const fromSetting = typeof explicit === 'string' ? explicit.trim() : ''
  if (fromSetting !== '') return fromSetting
  const fromEnv = typeof envValue === 'string' ? envValue.trim() : ''
  if (fromEnv !== '') return fromEnv
  const dir = typeof cwd === 'string' && cwd.trim() !== '' ? cwd : process.cwd()
  try {
    const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (out !== '') return path.basename(out)
  } catch {
    // Not a repository, or git is unavailable: fall through to the directory name.
  }
  try {
    return path.basename(fs.realpathSync(dir))
  } catch {
    return path.basename(dir) || 'default'
  }
}

module.exports = {
  dshHome,
  sha256,
  contentToText,
  messageText,
  isHumanMessage,
  truncate,
  sanitizeText,
  isTrivialPrompt,
  resolveProject,
}