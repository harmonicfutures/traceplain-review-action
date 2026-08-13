'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_EVENTS = 200;
const MAX_NAME_LENGTH = 96;

function readRecord(filePath, maxBytes = DEFAULT_MAX_BYTES) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new Error('The input path is not a file.');
  if (stat.size > maxBytes) {
    throw new Error(`The input is ${stat.size} bytes; the configured limit is ${maxBytes} bytes.`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

function parseDocument(text) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('The input record is empty.');

  try {
    return { value: JSON.parse(trimmed), container: 'json' };
  } catch {
    const lines = trimmed.split(/\r?\n/).filter((line) => line.trim());
    const values = [];
    for (let index = 0; index < lines.length; index += 1) {
      try {
        values.push(JSON.parse(lines[index]));
      } catch {
        throw new Error(`Line ${index + 1} is not valid JSON.`);
      }
    }
    return { value: values, container: 'ndjson' };
  }
}

function boundedName(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.slice(0, MAX_NAME_LENGTH);
}

function markdown(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/([`*_{}\[\]()#+.!|<>])/g, '\\$1')
    .replace(/[\r\n]+/g, ' ');
}

function lower(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function isFailureStatus(value) {
  const status = lower(value);
  return ['error', 'failed', 'failure', 'denied', 'declined', 'cancelled', 'canceled'].includes(status);
}

function codexItemSummary(item, detail) {
  const type = lower(item?.type);
  if (type === 'command_execution') return 'Command execution';
  if (type === 'file_change') {
    const paths = Array.isArray(item?.changes) ? item.changes.length : Array.isArray(item?.files) ? item.files.length : 0;
    return paths ? `File change record (${paths} path${paths === 1 ? '' : 's'})` : 'File change record';
  }
  if (type === 'mcp_tool_call') {
    const name = detail === 'names' ? boundedName(item?.tool || item?.name || item?.tool_name) : null;
    return name ? `MCP tool call: ${name}` : 'MCP tool call';
  }
  if (type === 'web_search') return 'Web search';
  if (type === 'agent_message') return 'Agent message';
  return type ? `Terminal item: ${type}` : 'Terminal item';
}

function projectCodex(value, detail) {
  const envelopes = Array.isArray(value) ? value : [value];
  const observed = [];
  const claims = [];
  const attention = [];
  let terminalCount = 0;

  for (const envelope of envelopes) {
    const eventType = lower(envelope?.type);
    if (eventType === 'item.completed') {
      const item = envelope?.item || {};
      terminalCount += 1;
      if (lower(item.type) === 'agent_message') {
        claims.push('The record contains an agent-authored completion message; its contents are not treated as proof.');
        continue;
      }

      const status = boundedName(item.status) || 'not supplied';
      const summary = codexItemSummary(item, detail);
      observed.push(`${summary} reached a terminal event (status: ${status}).`);

      const denied = ['deny', 'denied', 'declined'].includes(lower(item.decision));
      const commandFailed = lower(item.type) === 'command_execution' && Number.isFinite(item.exit_code) && item.exit_code !== 0;
      const resultFailed = item?.result?.success === false;
      const changed = lower(item.type) === 'file_change';
      if (denied) attention.push('A recorded action was denied or declined.');
      if (commandFailed || resultFailed || isFailureStatus(item.status)) attention.push('A terminal event records failure or an unsuccessful result.');
      if (changed) attention.push('The record contains a file-change event that requires human verification against the repository.');
    } else if (['turn.failed', 'error'].includes(eventType)) {
      terminalCount += 1;
      observed.push('The execution record contains a terminal error event.');
      attention.push('The run records a terminal error or failed turn.');
    }
  }

  if (terminalCount === 0) throw new Error('No terminal Codex exec events were found.');
  return {
    format: 'codex-exec-jsonl',
    eventCount: terminalCount,
    observed,
    claims,
    attention,
  };
}

function claudeBlocks(envelope) {
  const content = envelope?.message?.content;
  if (Array.isArray(content)) return content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return [];
}

function isClaudeRecord(value) {
  const envelopes = Array.isArray(value) ? value : [value];
  return envelopes.some((envelope) => {
    const type = lower(envelope?.type);
    if (type === 'result' && ('result' in (envelope || {}) || 'is_error' in (envelope || {}))) return true;
    if (!['assistant', 'user'].includes(type)) return false;
    return claudeBlocks(envelope).some((block) => ['tool_use', 'tool_result', 'text'].includes(lower(block?.type)));
  });
}

function projectClaude(value, detail) {
  const envelopes = Array.isArray(value) ? value : [value];
  const observed = [];
  const claims = [];
  const attention = [];
  const calls = new Map();
  const pending = [];
  const unreviewedTypes = new Set();
  let unreviewedRecords = 0;
  let unreviewedBlocks = 0;
  let eventCount = 0;

  for (const envelope of envelopes) {
    const envelopeType = lower(envelope?.type);
    if (!['assistant', 'user', 'result'].includes(envelopeType)) {
      unreviewedRecords += 1;
      unreviewedTypes.add(boundedName(envelope?.type) || '(missing record type)');
      continue;
    }
    if (envelopeType === 'assistant') {
      for (const block of claudeBlocks(envelope)) {
        const blockType = lower(block?.type);
        if (blockType === 'tool_use') {
          eventCount += 1;
          const tool = boundedName(block?.name);
          const summary = detail === 'names' && tool ? `Claude Code tool call: ${tool}` : 'Claude Code tool call';
          const item = { id: block?.id, tool, summary, result: null };
          pending.push(item);
          if (item.id) calls.set(item.id, item);
          if (['write', 'edit', 'multiedit', 'notebookedit'].includes(lower(tool))) {
            attention.push('A file-oriented Claude Code tool call requires human verification against the repository.');
          }
        } else if (blockType === 'text' && typeof block?.text === 'string' && block.text.trim()) {
          eventCount += 1;
          claims.push('The record contains an assistant-authored message; its contents are not treated as proof.');
        } else if (!['tool_use', 'text'].includes(blockType)) {
          unreviewedBlocks += 1;
          unreviewedTypes.add(boundedName(block?.type) || '(missing content type)');
        }
      }
    } else if (envelopeType === 'user') {
      for (const block of claudeBlocks(envelope)) {
        const blockType = lower(block?.type);
        if (blockType === 'text') continue;
        if (blockType !== 'tool_result') {
          unreviewedBlocks += 1;
          unreviewedTypes.add(boundedName(block?.type) || '(missing content type)');
          continue;
        }
        const call = block?.tool_use_id ? calls.get(block.tool_use_id) : null;
        const failed = block?.is_error === true;
        if (call) {
          call.result = failed ? 'ERROR' : 'RECORDED';
          if (failed) attention.push('A Claude Code tool result records an error.');
        } else {
          eventCount += 1;
          observed.push(`Claude Code tool result has no matching tool call in the supplied record (status: ${failed ? 'ERROR' : 'RECORDED'}).`);
          attention.push('A tool result could not be paired with a tool call in the supplied record.');
        }
      }
    } else if (envelopeType === 'result') {
      eventCount += 1;
      const failed = envelope?.is_error === true || lower(envelope?.subtype).startsWith('error') || isFailureStatus(envelope?.subtype);
      observed.push(`Claude Code final result reached a terminal event (status: ${failed ? 'ERROR' : 'RECORDED'}).`);
      if (envelope?.result !== undefined) claims.push('The record contains a final Claude Code result summary; its contents are not treated as proof.');
      if (failed) attention.push('The Claude Code final result records an error.');
    }
  }

  for (const call of pending) {
    const status = call.result || 'MISSING';
    observed.push(`${call.summary} has ${status === 'MISSING' ? 'no matching result' : `a ${status} result`} in the supplied record.`);
    if (status === 'MISSING') attention.push('A Claude Code tool call has no matching result in the supplied record.');
  }

  const unreviewedCount = unreviewedRecords + unreviewedBlocks;
  if (unreviewedCount) {
    const typeSummary = detail === 'names' && unreviewedTypes.size
      ? ` Structural types: ${[...unreviewedTypes].slice(0, 8).join(', ')}.`
      : '';
    attention.push(`${unreviewedCount} Claude Code ${unreviewedCount === 1 ? 'record or content block was' : 'records or content blocks were'} not interpreted and must be checked in the raw transcript.${typeSummary}`);
  }

  if (eventCount === 0) throw new Error('No projectable Claude Code stream events were found.');
  return { format: 'claude-code-stream-json', eventCount, observed, claims, attention, unreviewedRecords, unreviewedBlocks, unreviewedTypes: [...unreviewedTypes].slice(0, 8) };
}

function anyValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if ('stringValue' in value) return value.stringValue;
  if ('boolValue' in value) return value.boolValue;
  if ('intValue' in value) return Number(value.intValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('bytesValue' in value) return '[bytes]';
  if (value.arrayValue?.values) return value.arrayValue.values.map(anyValue);
  if (value.kvlistValue?.values) return Object.fromEntries(value.kvlistValue.values.map((entry) => [entry.key, anyValue(entry.value)]));
  return value;
}

function attributes(entries) {
  const result = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry?.key) result[entry.key] = anyValue(entry.value);
  }
  return result;
}

function otelStatus(status) {
  const raw = status?.code;
  if (raw === 2 || raw === '2' || lower(raw) === 'status_code_error' || lower(raw) === 'error') return 'ERROR';
  if (raw === 1 || raw === '1' || lower(raw) === 'status_code_ok' || lower(raw) === 'ok') return 'OK';
  return 'UNSET';
}

function projectOtel(value, detail) {
  const roots = Array.isArray(value?.resourceSpans) ? value.resourceSpans : [];
  if (!roots.length) throw new Error('No OTLP resourceSpans were found.');

  const observed = [];
  const claims = [];
  const attention = [];
  let spanCount = 0;

  for (const resourceSpan of roots) {
    const resourceAttributes = attributes(resourceSpan?.resource?.attributes);
    const service = boundedName(resourceAttributes['service.name']);
    for (const scopeSpan of Array.isArray(resourceSpan?.scopeSpans) ? resourceSpan.scopeSpans : []) {
      for (const span of Array.isArray(scopeSpan?.spans) ? scopeSpan.spans : []) {
        spanCount += 1;
        const spanAttributes = attributes(span?.attributes);
        const status = otelStatus(span?.status);
        const operation = boundedName(spanAttributes['gen_ai.operation.name'] || span?.name) || 'span';
        const model = boundedName(spanAttributes['gen_ai.request.model'] || spanAttributes['gen_ai.response.model']);
        const tool = boundedName(spanAttributes['gen_ai.tool.name']);
        const names = [];
        if (detail === 'names' && service) names.push(`service ${service}`);
        if (detail === 'names' && model) names.push(`model ${model}`);
        if (detail === 'names' && tool) names.push(`tool ${tool}`);
        observed.push(`${detail === 'names' ? operation : 'OTLP span'} completed with status ${status}${names.length ? ` (${names.join(', ')})` : ''}.`);
        if (status === 'ERROR') attention.push('An OTLP span has explicit ERROR status.');
        if (status === 'UNSET') attention.push('An OTLP span has UNSET status; absence of an error status is not proof of success.');
      }
    }
  }

  if (!spanCount) throw new Error('No OTLP spans were found.');
  return { format: 'opentelemetry-otlp-json', eventCount: spanCount, observed, claims, attention };
}

function projectRecord(value, detail = 'safe') {
  if (!['safe', 'names'].includes(detail)) throw new Error('detail must be safe or names.');
  const first = Array.isArray(value) ? value[0] : value;
  if (first?.resourceSpans || value?.resourceSpans) return finalize(projectOtel(value, detail));
  if (isClaudeRecord(value)) return finalize(projectClaude(value, detail));
  if (first?.type || first?.item) return finalize(projectCodex(value, detail));
  throw new Error('Unsupported record. Expected Codex exec JSONL/NDJSON, Claude Code stream JSON, or OTLP JSON resourceSpans.');
}

function finalize(projection) {
  projection.observed = projection.observed.slice(0, MAX_EVENTS);
  projection.claims = [...new Set(projection.claims)].slice(0, MAX_EVENTS);
  projection.attention = [...new Set(projection.attention)].slice(0, MAX_EVENTS);
  projection.truncated = projection.eventCount > MAX_EVENTS;
  projection.verdict = projection.attention.length ? 'review_needed' : 'no_explicit_failure';
  return projection;
}

function renderHandback(projection, sourceLabel) {
  const verdict = projection.verdict === 'review_needed'
    ? 'REVIEW NEEDED'
    : 'NO EXPLICIT FAILURE IN THE SUPPLIED RECORD — HUMAN VERIFICATION STILL REQUIRED';
  const lines = [
    '# Traceplain agent review',
    '',
    '> Generated locally inside the runner from the supplied record. This handback does not prove the record is complete or that the underlying work is correct.',
    '',
    '## Verdict',
    '',
    `**${verdict}**`,
    '',
    '## Record boundary',
    '',
    `- Source: \`${markdown(sourceLabel)}\``,
    `- Detected format: \`${projection.format}\``,
    `- Terminal events or spans: ${projection.eventCount}`,
    ...(projection.format === 'claude-code-stream-json' ? [`- Unreviewed Claude records or content blocks: ${(projection.unreviewedRecords || 0) + (projection.unreviewedBlocks || 0)}`] : []),
    `- Projection limit: first ${MAX_EVENTS} items${projection.truncated ? ' (output truncated)' : ''}`,
    '',
    '## Observed activity',
    '',
  ];

  for (const item of projection.observed) lines.push(`- **Observed:** ${markdown(item)}`);
  if (!projection.observed.length) lines.push('- **Observed:** No projectable terminal activity was found.');

  lines.push('', '## Agent-reported claims', '');
  if (projection.claims.length) {
    for (const claim of projection.claims) lines.push(`- **Agent-reported:** ${markdown(claim)}`);
  } else {
    lines.push('- **Unknown:** No agent-authored completion claim was projected.');
  }

  lines.push('', '## Human review', '');
  if (projection.attention.length) {
    for (const item of projection.attention) lines.push(`- **Attention:** ${markdown(item)}`);
  } else {
    lines.push('- **Verify:** Confirm the claimed outcome against repository state, tests, deployment state, or another authoritative source.');
  }
  lines.push(
    '- **Unknown:** Events omitted from the supplied record, external side effects, and unrecorded state cannot be inferred.',
    '- **Decision:** A human still owns acceptance, approval, rollback, and any consequential next action.',
    '',
    '## Evidence boundary',
    '',
    'Traceplain labels what the supplied record shows, separates agent-authored claims, and preserves explicit unknowns. It does not certify correctness, completeness, compliance, or safety.',
    '',
    'Generated by [Traceplain](https://traceplain.zakgov.com/?utm_source=github&utm_medium=action&utm_campaign=traceplain-review-action).',
    '',
  );
  return lines.join('\n');
}

function reviewFile(filePath, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const detail = options.detail ?? 'safe';
  const text = readRecord(filePath, maxBytes);
  const parsed = parseDocument(text);
  const projection = projectRecord(parsed.value, detail);
  const handback = renderHandback(projection, detail === 'safe' ? 'supplied record' : path.basename(filePath));
  return { projection, handback };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  MAX_EVENTS,
  parseDocument,
  projectRecord,
  renderHandback,
  reviewFile,
};
