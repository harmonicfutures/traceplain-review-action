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

test('pairs Claude Code tool uses with results and suppresses imported content in safe mode', () => {
  const source = path.join(__dirname, 'fixtures', 'claude-code-stream.jsonl');
  const { projection, handback } = reviewFile(source, { detail: 'safe' });
  assert.equal(projection.format, 'claude-code-stream-json');
  assert.equal(projection.eventCount, 3);
  assert.equal(projection.verdict, 'review_needed');
  assert.equal(projection.observed.filter((item) => /tool call/.test(item)).length, 2);
  assert.match(projection.attention.join(' '), /file-oriented/);
  assert.match(handback, /assistant-authored message/);
  assert.doesNotMatch(handback, /private-example|private result|private-command|Private completion/);
  assert.doesNotMatch(handback, /claude-code-stream\.jsonl/);
});

test('flags missing and failed Claude Code tool results', () => {
  const record = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'secret' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'b', name: 'Read', input: { file_path: 'secret.txt' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'secret failure', is_error: true }] } },
  ];
  const projection = projectRecord(record, 'names');
  assert.equal(projection.format, 'claude-code-stream-json');
  assert.equal(projection.eventCount, 2);
  assert.equal(projection.verdict, 'review_needed');
  assert.match(projection.observed.join(' '), /Bash/);
  assert.match(projection.attention.join(' '), /records an error/);
  assert.match(projection.attention.join(' '), /no matching result/);
});

test('treats Claude Code error result subtypes as review signals', () => {
  const projection = projectRecord({
    type: 'result',
    subtype: 'error_max_turns',
    is_error: false,
    result: 'private failure summary',
  });
  assert.equal(projection.format, 'claude-code-stream-json');
  assert.equal(projection.verdict, 'review_needed');
  assert.match(projection.attention.join(' '), /final result records an error/);
});

test('flags Claude Code schema drift without leaking unknown content in safe mode', () => {
  const record = [
    { type: 'system', subtype: 'private-system-value' },
    { type: 'assistant', message: { content: [
      { type: 'thinking', thinking: 'private reasoning' },
      { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'private command' } },
    ] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'private result' }] } },
  ];
  const safe = projectRecord(record, 'safe');
  const handback = renderHandback(safe, 'supplied record');
  assert.equal(safe.unreviewedRecords, 1);
  assert.equal(safe.unreviewedBlocks, 1);
  assert.equal(safe.verdict, 'review_needed');
  assert.match(handback, /Unreviewed Claude records or content blocks: 2/);
  assert.match(handback, /2 Claude Code records or content blocks were not interpreted/);
  assert.doesNotMatch(handback, /system|thinking|private-system|private reasoning/i);

  const names = projectRecord(record, 'names');
  assert.match(names.attention.join(' '), /Structural types: system, thinking/);
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
