'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { reviewFile, DEFAULT_MAX_BYTES } = require('../src/review.cjs');

function input(name, fallback = '') {
  const canonical = `INPUT_${name.toUpperCase()}`;
  const underscored = canonical.replace(/-/g, '_');
  return process.env[canonical] || process.env[underscored] || fallback;
}

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) return;
  fs.appendFileSync(outputFile, `${name}=${String(value).replace(/[\r\n]/g, ' ')}\n`, 'utf8');
}

function fail(message) {
  process.stderr.write(`::error::${String(message).replace(/[\r\n]/g, ' ')}\n`);
  process.exitCode = 1;
}

try {
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  const sourceInput = input('PATH');
  if (!sourceInput) throw new Error('The path input is required.');
  const sourcePath = path.resolve(workspace, sourceInput);
  const outputPath = path.resolve(workspace, input('OUTPUT', 'traceplain-handback.md'));
  const detail = input('DETAIL', 'safe').toLowerCase();
  const maxBytes = Number(input('MAX-BYTES', String(DEFAULT_MAX_BYTES)));
  const failOnReview = input('FAIL-ON-REVIEW', 'false').toLowerCase() === 'true';
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('max-bytes must be a positive integer.');

  const { projection, handback } = reviewFile(sourcePath, { detail, maxBytes });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, handback, 'utf8');

  setOutput('handback-path', outputPath);
  setOutput('verdict', projection.verdict);
  setOutput('format', projection.format);
  setOutput('event-count', projection.eventCount);
  process.stdout.write(`Traceplain wrote ${projection.eventCount} projected events to ${outputPath}.\n`);

  if (projection.verdict === 'review_needed') {
    process.stdout.write('::warning::The supplied record contains evidence that requires human review.\n');
    if (failOnReview) process.exitCode = 1;
  }
} catch (error) {
  fail(error instanceof Error ? error.message : 'Traceplain review failed.');
}
