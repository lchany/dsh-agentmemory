'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const tools = require('../src/tools')

test('memory_recall validates and targets the search endpoint', () => {
  const built = tools.buildRequest('memory_recall', { query: 'deploy' }, { project: 'p', agentId: 'a' })
  assert.equal(built.error, undefined)
  assert.equal(built.path, 'search')
  assert.deepEqual(built.payload, {
    query: 'deploy',
    project: 'p',
    agentId: 'a',
    limit: 10,
    includeLessons: false,
  })
})

test('memory_search defaults to five results on smart-search', () => {
  const built = tools.buildRequest('memory_search', { query: 'deploy', limit: 3, targetLayer: 'observation' })
  assert.equal(built.path, 'smart-search')
  assert.equal(built.payload.limit, 3)
  assert.equal(built.payload.targetLayer, 'observation')
  assert.equal(built.payload.includeLessons, false)
})

test('memory_save defaults to fact and dedupes CSV lists', () => {
  const built = tools.buildRequest('memory_save', {
    content: 'The deploy needs the staging token.',
    concepts: 'deploy, token , deploy',
    files: 'a.py,b.py',
  })
  assert.equal(built.path, 'remember')
  assert.equal(built.payload.type, 'fact')
  assert.deepEqual(built.payload.concepts, ['deploy', 'token'])
  assert.deepEqual(built.payload.files, ['a.py', 'b.py'])
})

test('invalid arguments are rejected with the provider wording', () => {
  assert.match(tools.buildRequest('memory_recall', {}).error, /^query must be a non-empty string\.$/)
  assert.match(tools.buildRequest('memory_save', { content: 'x', type: 'nope' }).error, /^Invalid memory type\.$/)
  assert.match(tools.buildRequest('memory_search', { query: 'x', limit: 0 }).error, /^limit must be an integer between 1 and 100\.$/)
  assert.match(tools.buildRequest('memory_search', { query: 'x', limit: 101 }).error, /^limit must be an integer between 1 and 100\.$/)
  assert.match(tools.buildRequest('memory_recall', { query: 'x', limit: 1.5 }).error, /^limit must be an integer/)
  assert.match(tools.buildRequest('memory_search', { query: 'x', targetLayer: 'nope' }).error, /^Invalid targetLayer\.$/)
})

test('agentId must be bounded and never a wildcard', () => {
  assert.match(tools.buildRequest('memory_recall', { query: 'x', agentId: '*' }).error, /cannot be a wildcard/)
  const long = 'a'.repeat(129)
  assert.match(tools.buildRequest('memory_recall', { query: 'x', agentId: long }).error, /at most 128 characters/)
  assert.equal(tools.buildRequest('memory_recall', { query: 'x', agentId: 'agent-1' }).payload.agentId, 'agent-1')
})

test('definitions carry the provider schemas and render arrays', () => {
  const { definitions, schemas } = tools.buildToolSet({ context: {} })
  assert.deepEqual(definitions.map((entry) => entry.name).sort(), ['memory_recall', 'memory_save', 'memory_search'])
  for (const definition of definitions) {
    assert.equal(definition.parameters, schemas[definition.name].parameters)
    assert.match(definition.description, /\S/)
    const rendered = definition.output.render({}, 'body')
    assert.ok(Array.isArray(rendered), 'render must return ContentBlock[]')
    assert.equal(rendered[0].type, 'text')
    assert.equal(rendered[0].text, 'body')
  }
})