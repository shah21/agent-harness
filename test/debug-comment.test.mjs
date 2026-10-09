import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDebugComment, DEBUG_MARKER } from '../harness/lib/debug-comment.mjs';

const report = {
  status: 'FINDINGS', problem: 'Export returns 500.', reproduction: 'NOT_REPRODUCED - needs a database',
  evidence: 'src/export.js:42 divides by zero',
  hypotheses: [{ text: 'empty list divides by zero - CONFIRMED - read it', tag: 'CONFIRMED' }],
  rootCause: 'no guard on empty input', owningModule: 'src/export.js', nextAction: 'Guard the empty case.',
  unknowns: 'None', humanInput: 'None',
};
const verdict = (over = {}) => ({
  mode: 'debug', outcome: 'FINDINGS', kind: null, reasons: [], warnings: [],
  investigated: [{ path: '.', sha: 'a'.repeat(40) }], report, ...over,
});
const URL = 'https://example.test/run/1';

test('findings render every section and end with the marker', () => {
  const c = renderDebugComment(verdict(), { runUrl: URL });
  assert.match(c, /^🔎 \*\*FINDINGS\*\*/);
  for (const s of ['Problem', 'Reproduction', 'Investigated', 'Evidence', 'Hypotheses', 'Root cause', 'Owning module', 'Next action', 'Unknowns', 'Human input needed']) {
    assert.match(c, new RegExp(`\\*\\*${s}\\*\\*`), s);
  }
  assert.match(c, /`\.` @ `a{40}`/);
  assert.match(c, /1\. empty list divides by zero - CONFIRMED - read it/);
  assert.match(c, /\[Run log and artifacts\]\(https:\/\/example\.test\/run\/1\)/);
  assert.ok(c.trimEnd().endsWith(DEBUG_MARKER));
});

test('warnings are listed', () => {
  const c = renderDebugComment(verdict({ outcome: 'INCONCLUSIVE', warnings: ['agent modified the checkout; changes were discarded'] }), { runUrl: URL });
  assert.match(c, /^🔎 \*\*INCONCLUSIVE\*\*/);
  assert.match(c, /\*\*Warnings\*\*\n- agent modified the checkout/);
});

test('blocked without a report shows the reasons and how to retry', () => {
  const c = renderDebugComment(verdict({ outcome: 'BLOCKED', kind: 'gate', reasons: ['bad issue: ref is not allowed: x'], report: null, investigated: [] }), { runUrl: URL });
  assert.match(c, /^⛔ \*\*BLOCKED\*\* \(gate\)/);
  assert.match(c, /- bad issue: ref is not allowed: x/);
  assert.match(c, /remove `agent:blocked` and add `debug`/);
  assert.doesNotMatch(c, /\*\*Evidence\*\*/);
  assert.ok(c.trimEnd().endsWith(DEBUG_MARKER));
});

test('waiting says the issue stays queued', () => {
  const c = renderDebugComment(verdict({ outcome: 'WAITING', kind: 'usage-limit', reasons: ['usage limit reached on all 1 Claude accounts'], report: null }), { runUrl: URL });
  assert.match(c, /^⏸️ \*\*WAITING\*\* \(usage-limit\)/);
  assert.match(c, /stays queued/);
});

test('evidence containing tildes cannot close the fence early', () => {
  const c = renderDebugComment(verdict({ report: { ...report, evidence: 'a\n~~~\nb' } }), { runUrl: URL });
  assert.match(c, /~~~~\na\n~~~\nb\n~~~~/);
});

test('truncates evidence to stay under the limit', () => {
  const c = renderDebugComment(verdict({ report: { ...report, evidence: 'x'.repeat(100000) } }), { runUrl: URL });
  assert.ok(c.length <= 60000, String(c.length));
  assert.match(c, /truncated; the full report is in the run artifact/);
  assert.ok(c.trimEnd().endsWith(DEBUG_MARKER));
});
