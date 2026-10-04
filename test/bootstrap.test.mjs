import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  LABELS, deriveConfig, lintProject, renderFiles, verifyFreshClone, ensureLabels, setActionsPermissions, ensureSecret,
} from '../harness/lib/bootstrap.mjs';

const scripts = { test: 'vitest run', lint: 'eslint', typecheck: 'tsc --noEmit', build: 'next build' };

test('deriveConfig picks the install command from the lockfile and the checks from scripts', () => {
  const c = deriveConfig({ pkg: { scripts }, files: new Set(['pnpm-lock.yaml']) });
  assert.equal(c.install, 'pnpm install --frozen-lockfile');
  assert.deepEqual(c.checks, { test: 'pnpm test', lint: 'pnpm lint', typecheck: 'pnpm typecheck', build: 'pnpm build' });
  const n = deriveConfig({ pkg: { scripts }, files: new Set(['package-lock.json']) });
  assert.equal(n.install, 'npm ci');
  assert.deepEqual(n.checks, { test: 'npm test', lint: 'npm run lint', typecheck: 'npm run typecheck', build: 'npm run build' });
  assert.equal(deriveConfig({ pkg: { scripts }, files: new Set(['yarn.lock']) }).install, 'yarn install --frozen-lockfile');
});

test('deriveConfig only includes checks that exist and falls back to tsc, generating Next types first', () => {
  const noLint = deriveConfig({ pkg: { scripts: { test: 'x' } }, files: new Set(['pnpm-lock.yaml']) });
  assert.deepEqual(Object.keys(noLint.checks), ['test']);
  const ts = deriveConfig({ pkg: { scripts: { test: 'x' } }, files: new Set(['pnpm-lock.yaml', 'tsconfig.json']) });
  assert.equal(ts.checks.typecheck, 'pnpm exec tsc --noEmit');
  const next = deriveConfig({ pkg: { scripts: { test: 'x' }, dependencies: { next: '16' } }, files: new Set(['pnpm-lock.yaml', 'tsconfig.json']) });
  assert.equal(next.checks.typecheck, 'pnpm exec next typegen && pnpm exec tsc --noEmit');
});

test('deriveConfig refuses to guess when there is nothing to run', () => {
  assert.throws(() => deriveConfig({ pkg: null, files: new Set() }), /agent\.config\.json by hand/);
  assert.throws(() => deriveConfig({ pkg: { scripts: {} }, files: new Set(['pnpm-lock.yaml']) }), /agent\.config\.json by hand/);
});

test('lintProject flags the three gotchas and is quiet for a clean project', () => {
  const clean = lintProject({ pkg: { scripts: { typecheck: 'tsc --noEmit' } }, gitignore: 'node_modules\n.env*\n!.env.example\n', files: new Set(), vercelJson: null });
  assert.deepEqual(clean, []);

  const env = lintProject({ pkg: {}, gitignore: '.env*\n', files: new Set(), vercelJson: null });
  assert.match(env.join('\n'), /\.env\.example/);

  const next = lintProject({ pkg: { dependencies: { next: '16' }, scripts: { typecheck: 'tsc --noEmit' } }, gitignore: '', files: new Set(), vercelJson: null });
  assert.match(next.join('\n'), /next typegen/);
  const nextOk = lintProject({ pkg: { dependencies: { next: '16' }, scripts: { typecheck: 'next typegen && tsc --noEmit' } }, gitignore: '', files: new Set(), vercelJson: null });
  assert.deepEqual(nextOk, []);

  const vercel = lintProject({ pkg: {}, gitignore: '', files: new Set(['.vercel']), vercelJson: '{}' });
  assert.match(vercel.join('\n'), /preview deployments/i);
  const vercelOk = lintProject({ pkg: {}, gitignore: '', files: new Set(['.vercel']), vercelJson: '{"git":{"deploymentEnabled":{"agent/*":false}},"ignoreCommand":"x"}' });
  assert.deepEqual(vercelOk, []);
});

test('renderFiles fills in the owner, skips files that exist, and overwrites only with force', () => {
  const config = { install: 'pnpm install --frozen-lockfile', checks: { test: 'pnpm test' } };
  const files = renderFiles({ owner: 'shah21', existing: new Set(['agent.config.json']), config });
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(byPath).sort(), [
    '.github/ISSUE_TEMPLATE/agent-task.md',
    '.github/workflows/agent.yml',
    '.github/workflows/close-merged.yml',
    'agent.config.json',
  ]);
  assert.match(byPath['.github/workflows/agent.yml'].content, /shah21\/agent-harness\/\.github\/workflows\/run-task\.yml@v1/);
  assert.doesNotMatch(byPath['.github/workflows/close-merged.yml'].content, /OWNER/);
  assert.equal(byPath['agent.config.json'].skipped, true);
  assert.equal(byPath['.github/workflows/agent.yml'].skipped, false);
  assert.deepEqual(JSON.parse(renderFiles({ owner: 'o', existing: new Set(['agent.config.json']), config, force: true }).find((f) => f.path === 'agent.config.json').content), config);
});

const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];
function project(files, ignored = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bootstrap-'));
  const git = (...a) => execFileSync('git', [...ID, ...a], { cwd: dir });
  git('init', '-q', '-b', 'main');
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  git('add', '-A');
  git('commit', '-qm', 'init');
  for (const [name, content] of Object.entries(ignored)) writeFileSync(join(dir, name), content);
  return dir;
}

test('verifyFreshClone passes a project whose checks need nothing but committed files', async () => {
  const dir = project({ 'agent.config.json': JSON.stringify({ install: 'true', checks: { test: 'true' } }) });
  const r = await verifyFreshClone({ projectDir: dir });
  assert.equal(r.ok, true);
});

test('verifyFreshClone catches a check that only passes because of an uncommitted or ignored local file', async () => {
  const dir = project(
    {
      '.gitignore': 'generated.txt\n',
      'agent.config.json': JSON.stringify({ install: 'true', checks: { typecheck: "sh -c 'test -f generated.txt || { echo missing generated.txt; exit 1; }'" } }),
    },
    { 'generated.txt': 'x' },
  );
  const r = await verifyFreshClone({ projectDir: dir });
  assert.equal(r.ok, false);
  assert.equal(r.failed[0].name, 'typecheck');
  assert.match(r.failed[0].tail, /missing generated\.txt/);
});

test('verifyFreshClone uses the env block from the config and reports a failing install', async () => {
  const withEnv = project({ 'agent.config.json': JSON.stringify({ install: 'true', checks: { build: "sh -c 'test \"$NEEDED\" = yes'" }, env: { NEEDED: 'yes' } }) });
  assert.equal((await verifyFreshClone({ projectDir: withEnv })).ok, true);
  const badInstall = project({ 'agent.config.json': JSON.stringify({ install: 'sh -c "echo no lockfile; exit 3"', checks: { test: 'true' } }) });
  const r = await verifyFreshClone({ projectDir: badInstall });
  assert.equal(r.ok, false);
  assert.equal(r.failed[0].name, 'install');
  assert.match(r.failed[0].tail, /no lockfile/);
});

function fakeGh(replies = {}) {
  const calls = [];
  const run = async (args, opts = {}) => {
    calls.push({ args, ...opts });
    const key = args.join(' ');
    for (const [pattern, reply] of Object.entries(replies)) {
      if (key.includes(pattern)) {
        if (reply instanceof Error) throw reply;
        return reply;
      }
    }
    return '';
  };
  return { run, calls };
}

test('setActionsPermissions sends a JSON body that keeps the default permissions, and skips when already enabled', async () => {
  const gh = fakeGh({ 'actions/permissions/workflow': JSON.stringify({ default_workflow_permissions: 'read', can_approve_pull_request_reviews: false }) });
  const r = await setActionsPermissions({ repo: 'o/r', run: gh.run });
  assert.equal(r.changed, true);
  const put = gh.calls.find((c) => c.args.includes('PUT'));
  assert.ok(put.args.includes('--input') && put.args.includes('-'), 'body is sent as JSON on stdin, not as form fields');
  assert.deepEqual(JSON.parse(put.input), { default_workflow_permissions: 'read', can_approve_pull_request_reviews: true });

  const already = fakeGh({ 'actions/permissions/workflow': JSON.stringify({ default_workflow_permissions: 'write', can_approve_pull_request_reviews: true }) });
  const r2 = await setActionsPermissions({ repo: 'o/r', run: already.run });
  assert.equal(r2.changed, false);
  assert.equal(already.calls.some((c) => c.args.includes('PUT')), false);
});

test('ensureLabels creates every agent label and tolerates ones that already exist', async () => {
  const gh = fakeGh({ 'label create agent:ready': new Error('already exists') });
  const r = await ensureLabels({ repo: 'o/r', run: gh.run });
  assert.equal(gh.calls.length, LABELS.length);
  assert.deepEqual(r.existing, ['agent:ready']);
  assert.equal(r.created.length, LABELS.length - 1);
});

test('ensureSecret prompts for the token only when it is not set yet', async () => {
  const have = fakeGh({ 'secret list': 'CLAUDE_CODE_OAUTH_TOKEN\t2026-10-03\n' });
  assert.equal((await ensureSecret({ repo: 'o/r', run: have.run })).set, false);
  assert.equal(have.calls.some((c) => c.args.includes('set')), false);

  const none = fakeGh({ 'secret list': '' });
  const r = await ensureSecret({ repo: 'o/r', run: none.run });
  assert.equal(r.set, true);
  const set = none.calls.find((c) => c.args.includes('set'));
  assert.deepEqual(set.args, ['secret', 'set', 'CLAUDE_CODE_OAUTH_TOKEN', '--repo', 'o/r']);
  assert.equal(set.inherit, true, 'the token is typed into gh directly, never passed through this script');
});
