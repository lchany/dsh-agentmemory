'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { DEFAULTS } = require('../src/const')
const { FIELD_TYPES, sanitizeConfig, settingsSchema } = require('../src/config')

test('every default is declared exactly once', () => {
  assert.deepEqual(Object.keys(FIELD_TYPES).sort(), Object.keys(DEFAULTS).sort())
})

test('host-materialised placeholders never reach consumers', () => {
  // dsh 0.2.0-rc.2 materialises `.volatile()` fields of the apply-config as `{}`.
  const raw = { enabled: {}, url: {}, secret: {}, timeoutMs: {}, prefetchLimit: {} }
  assert.deepEqual(sanitizeConfig(raw), {})
})

test('unknown keys and wrong types are dropped, matching types survive', () => {
  const raw = {
    enabled: false,
    url: 'http://h:3111',
    timeoutMs: 2500,
    prefetchLimit: '5',
    nonsense: 'drop me',
    secret: 42,
  }
  assert.deepEqual(sanitizeConfig(raw), { enabled: false, url: 'http://h:3111', timeoutMs: 2500 })
})

test('arrays and non-finite numbers are rejected', () => {
  assert.deepEqual(sanitizeConfig({ url: ['x'], timeoutMs: Number.NaN, prefetchLimit: Infinity }), {})
  assert.deepEqual(sanitizeConfig(null), {})
  assert.deepEqual(sanitizeConfig('nope'), {})
})

test('the schema declares every field the sanitizer knows', () => {
  const S = require('@deepseek-ai/schemastery')
  const schema = settingsSchema(S)
  assert.equal(typeof schema, 'function')
  const keys = Object.keys(schema({}))
  assert.deepEqual(keys.sort(), Object.keys(DEFAULTS).sort())
})

test('without schemastery the plugin simply exposes no form', () => {
  assert.equal(settingsSchema(null), null)
})