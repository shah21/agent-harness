import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildReviewSelection, checkoutPlan, MAX_REVIEW_LINES } from '../harness/lib/pr-review.mjs';

const CLI = new URL('../harness/cli.mjs', import.meta.url).pathname;
const SHA = 'a'.repeat(40);
const issue = { number: 7, title: 'Review', body: 'pr: o/super#12\npr: o/sub#3', labels: ['review'] };
const selection = { issue, prs: [{ repo: 'o/super', number: 12 }, { repo: 'o/sub', number: 3 }], context: null, skip: null };
const data = (extra = {}) => ({ url: 'https://github.com/o/super/pull/12', title: 'T', body: 'B', headRefOid: SHA, baseRefName: 'main', additions: 10, deletions: 5, ...extra });

test('builds the selection from pull request data', () => {
  const s = buildReviewSelection({ selection, prData: [data(), data({ url: 'u2', headRefOid: 'b'.repeat(40), additions: 1, deletions: 0 })], candidates: [] });
  assert.equal(s.skip, null);
  assert.equal(s.task, null);
  assert.deepEqual(s.prs[0], { repo: 'o/super', number: 12, url: 'https://github.com/o/super/pull/12', title: 'T', body: 'B', headSha: SHA, baseRef: 'main', lines: 15 });
  assert.equal(s.prs[1].headSha, 'b'.repeat(40));
});

test('unreadable, unsafe or oversized pull requests are skipped', () => {
  assert.equal(buildReviewSelection({ selection, prData: [data(), null] }).skip, 'pull request not readable: o/sub#3');
  assert.equal(buildReviewSelection({ selection, prData: [data({ headRefOid: 'main' }), data()] }).skip,
    'pull request has an unexpected head or base: o/super#12');
  assert.equal(buildReviewSelection({ selection, prData: [data({ baseRefName: '--upload-pack=x' }), data()] }).skip,
    'pull request has an unexpected head or base: o/super#12');
  assert.equal(buildReviewSelection({ selection, prData: [data({ additions: MAX_REVIEW_LINES }), data()] }).skip,
    'pull requests are too large to review here: 50020 changed lines (limit 50000)');
});

test('unsafe head or base is skipped', () => {
  assert.match(buildReviewSelection({ selection, prData: [data({ baseRefName: 'a..b' }), data()] }).skip, /unexpected head or base/);
});

test('a skipped selection passes through', () => {
  const skipped = { ...selection, skip: 'bad issue: x' };
  assert.equal(buildReviewSelection({ selection: skipped, prData: [] }), skipped);
});

test('checkout plan maps pull requests onto the consumer, target and submodules, outermost first', () => {
  const s = { prs: [{ repo: 'o/sub', number: 3, headSha: SHA, baseRef: 'main' }, { repo: 'o/super', number: 12, headSha: SHA, baseRef: 'dev' }] };
  const target = { repo: 'o/super', path: 'target' };
  assert.deepEqual(checkoutPlan({ selection: s, consumerRepo: 'o/r', target, submodules: [{ path: 'packages/core', repo: 'o/sub' }] }), {
    plan: [
      { repo: 'o/super', number: 12, dir: 'target', prefix: 'target/', auth: 'target', headSha: SHA, baseRef: 'dev' },
      { repo: 'o/sub', number: 3, dir: 'target/packages/core', prefix: 'target/packages/core/', auth: 'target', headSha: SHA, baseRef: 'main' },
    ],
  });
  assert.deepEqual(checkoutPlan({ selection: { prs: [{ repo: 'o/r', number: 1, headSha: SHA, baseRef: 'main' }] }, consumerRepo: 'o/r', target: null }).plan[0],
    { repo: 'o/r', number: 1, dir: '.', prefix: '', auth: 'consumer', headSha: SHA, baseRef: 'main' });
  assert.deepEqual(checkoutPlan({ selection: { prs: [{ repo: 'x/y', number: 1 }] }, consumerRepo: 'o/r', target }),
    { error: 'pull request is not in this repository or its target: x/y#1' });
});

test('cli commands', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-cli-'));
  const f = (name, obj) => { writeFileSync(join(dir, name), JSON.stringify(obj)); return join(dir, name); };
  const cli = (...args) => execFileSync('node', [CLI, ...args], { encoding: 'utf8' });

  const picked = JSON.parse(cli('select-review', '--issues', f('issues.json', [{ ...issue, labels: [{ name: 'review' }] }])));
  assert.deepEqual(picked.prs, selection.prs);

  const built = JSON.parse(cli('review-selection', '--selection', f('sel.json', selection), '--prs', f('prs.json', [data(), data()]), '--candidates', f('c.json', [])));
  assert.equal(built.prs.length, 2);

  const project = join(dir, 'project');
  mkdirSync(join(project, 'target'), { recursive: true });
  writeFileSync(join(project, 'target', '.gitmodules'), '[submodule "packages/core"]\n\tpath = packages/core\n\turl = https://github.com/o/sub.git\n');
  const config = f('config.json', { install: 'true', checks: { t: 'true' }, target: { repo: 'o/super', path: 'target' } });
  const out = join(dir, 'out');
  mkdirSync(out);
  cli('review-checkouts', '--config', config, '--selection', f('sel2.json', built), '--repo', 'o/r', '--project', project, '--out', out);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'checkout-plan.json'), 'utf8')).map((p) => p.dir), ['target', 'target/packages/core']);

  const out2 = join(dir, 'out2');
  mkdirSync(out2);
  cli('review-checkouts', '--config', config, '--selection', f('sel3.json', { prs: [{ repo: 'x/y', number: 1 }] }), '--repo', 'o/r', '--project', project, '--out', out2);
  assert.equal(readFileSync(join(out2, 'pr-checkout.txt'), 'utf8'), 'pull request is not in this repository or its target: x/y#1\n');
  assert.equal(existsSync(join(out2, 'checkout-plan.json')), false);

  const skipped = JSON.parse(cli('review-skip-verdict', '--selection', f('sk.json', { ...selection, skip: 'bad issue: x' })));
  assert.deepEqual([skipped.mode, skipped.outcome, skipped.kind, skipped.reasons], ['review', 'BLOCKED', 'gate', ['bad issue: x']]);
  const fallback = JSON.parse(cli('review-fallback-verdict', '--selection', join(dir, 'sel.json')));
  assert.deepEqual([fallback.outcome, fallback.kind], ['BLOCKED', 'harness']);
});
