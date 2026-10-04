import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tailLog } from '../harness/lib/tail.mjs';

test('keeps only the last lines and drops trailing blank lines', () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n\n\n';
  const out = tailLog(text, { lines: 3 });
  assert.equal(out, 'line 48\nline 49\nline 50');
});

test('returns everything when the log is short', () => {
  assert.equal(tailLog('a\nb\n'), 'a\nb');
});

test('strips ANSI colour codes and normalises CRLF', () => {
  assert.equal(tailLog('\u001b[31mFAIL\u001b[0m x\r\nnext\r\n'), 'FAIL x\nnext');
});

test('caps the size, cutting at a line boundary and marking the cut', () => {
  const text = Array.from({ length: 20 }, (_, i) => `${'x'.repeat(40)} ${i}`).join('\n');
  const out = tailLog(text, { lines: 100, maxChars: 130 });
  assert.ok(out.length <= 135, `too long: ${out.length}`);
  assert.match(out, /^… \(truncated\)\n/);
  assert.match(out, /x{40} 19$/);
  assert.doesNotMatch(out.split('\n').slice(1)[0], /^x{0,39} \d+$/, 'must not start with a partial line');
});

test('returns an empty string for an empty or whitespace-only log', () => {
  assert.equal(tailLog(''), '');
  assert.equal(tailLog('\n \n\n'), '');
});

test('default window keeps 60 lines so a failing test name stays visible', () => {
  const text = Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join('\n');
  const out = tailLog(text);
  assert.equal(out.split('\n').length, 60);
  assert.ok(out.startsWith('line 21\n'));
});
