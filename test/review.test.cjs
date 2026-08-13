'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseDocument, projectRecord, renderHandback, reviewFile } = require('../src/review.cjs');

test('projects terminal Codex events and treats file changes as review work', () => {
  const record = [
    { type: 'item.started', item: { id: '1', type: 'command_execution', status: 'in_progress' } },
    { type: 'item.completed', item: { id: '1', type: 'command_execution', status: 'completed', exit_code: 0 } },
    { type: 'item.completed', item: { id: '2', type: 'file_change', status: 'completed', changes: [{ path: 'secret-name.txt' }] } },
    { type: 'item.completed', item: { id: '3', type: 'agent_message', text: 'Everything definitely worked.' } },
  ];
  const projection = projectRecord(record, 'safe');
  assert.equal(projection.format, 'codex-exec-jsonl');
  assert.equal(projection.eventCount, 3);
  assert.equal(projection.verdict, 'review_needed');
  assert.match(projection.attention.join(' '), /file-change/);
  const markdown = renderHandback(projection, 'run.jsonl');
  assert.doesNotMatch(markdown, /secret-name|Everything definitely worked/);
  assert.match(markdown, /Agent-reported/);
});

test('does not interpret an unset OTLP status as success', () => {
  const record = {
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'private-service' } }] },
      scopeSpans: [{ spans: [{ name: 'chat private operation', status: { code: 0 }, attributes: [] }] }],
    }],
  };
  const projection = projectRecord(record, 'safe');
  assert.equal(projection.format, 'opentelemetry-otlp-json');
  assert.equal(projection.verdict, 'review_needed');
  const markdown = renderHandback(projection, 'trace.json');
  assert.match(markdown, /UNSET/);
  assert.doesNotMatch(markdown, /private-service|private operation/);
});

test('rejects unsupported JSON instead of inventing an interpretation', () => {
  assert.throws(() => projectRecord({ hello: 'world' }), /Unsupported record/);
});

test('parses NDJSON and writes a bounded handback', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'traceplain-action-'));
  const source = path.join(directory, 'run.jsonl');
  fs.writeFileSync(source, [
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', status: 'completed', exit_code: 0, command: 'do-not-leak --token secret' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'private completion claim' } }),
  ].join('\n'));
  const parsed = parseDocument(fs.readFileSync(source, 'utf8'));
  assert.equal(parsed.container, 'ndjson');
  const { projection, handback } = reviewFile(source, { detail: 'safe' });
  assert.equal(projection.verdict, 'no_explicit_failure');
  assert.doesNotMatch(handback, /do-not-leak|token secret|private completion claim/);
});
