#!/usr/bin/env node
// Connect a repository to the harness.
//   node bootstrap.mjs --repo owner/name [--project <dir>] [--dry-run] [--force] [--no-secret]
// Writes the workflow, config and issue template, creates the labels, enables PR creation
// for Actions, asks for the Claude token (gh prompts; it never passes through here), then
// verifies the committed code in a fresh clone. It does not commit or push.
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import {
  deriveConfig, lintProject, renderFiles, verifyFreshClone, ensureLabels, setActionsPermissions, ensureSecret,
} from './lib/bootstrap.mjs';

const { values } = parseArgs({
  options: {
    repo: { type: 'string' }, project: { type: 'string', default: '.' },
    'dry-run': { type: 'boolean', default: false }, force: { type: 'boolean', default: false }, 'no-secret': { type: 'boolean', default: false },
  },
});
if (!values.repo || !/^[\w.-]+\/[\w.-]+$/.test(values.repo)) {
  console.error('usage: node bootstrap.mjs --repo owner/name [--project <dir>] [--dry-run] [--force] [--no-secret]');
  process.exit(2);
}
const repo = values.repo;
const owner = repo.split('/')[0];
const projectDir = resolve(values.project);
const dry = values['dry-run'];

function run(args, { input, inherit } = {}) {
  const r = spawnSync('gh', args, { input, encoding: 'utf8', stdio: inherit ? 'inherit' : ['pipe', 'pipe', 'pipe'] });
  if (r.status !== 0) throw new Error((r.stderr || `gh ${args.join(' ')} failed`).trim());
  return r.stdout ?? '';
}
const readIf = (p) => (existsSync(join(projectDir, p)) ? readFileSync(join(projectDir, p), 'utf8') : null);
const step = (ok, text) => console.log(`${ok ? '✓' : '✗'} ${text}`);

const files = new Set(readdirSync(projectDir));
const pkg = readIf('package.json') ? JSON.parse(readIf('package.json')) : null;

// 1. Mistakes that have blocked first tasks.
const advice = lintProject({ pkg, gitignore: readIf('.gitignore') ?? '', files, vercelJson: readIf('vercel.json') });
for (const a of advice) step(false, a);

// 2. Files.
let config;
if (files.has('agent.config.json')) {
  config = JSON.parse(readIf('agent.config.json'));
} else {
  try {
    config = deriveConfig({ pkg, files });
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}
const existing = new Set(['.github/workflows/agent.yml', '.github/workflows/close-merged.yml', '.github/ISSUE_TEMPLATE/agent-task.md', 'agent.config.json'].filter((p) => existsSync(join(projectDir, p))));
for (const f of renderFiles({ owner, existing, config, force: values.force })) {
  if (f.skipped) {
    step(true, `${f.path} already exists (use --force to overwrite)`);
    continue;
  }
  if (!dry) {
    mkdirSync(dirname(join(projectDir, f.path)), { recursive: true });
    writeFileSync(join(projectDir, f.path), f.content);
  }
  step(true, `${dry ? 'would write' : 'wrote'} ${f.path}`);
}

// 3. GitHub settings.
if (dry) {
  step(true, 'dry run: no labels, settings, secret or verification');
  process.exit(0);
}
const labels = await ensureLabels({ repo, run });
step(true, `labels: ${labels.created.length} created, ${labels.existing.length} already there`);
const perms = await setActionsPermissions({ repo, run });
step(true, perms.changed ? 'Actions may now create pull requests' : 'Actions can already create pull requests');
if (!values['no-secret']) {
  const secret = await ensureSecret({ repo, run });
  step(true, secret.set ? 'CLAUDE_CODE_OAUTH_TOKEN set' : 'CLAUDE_CODE_OAUTH_TOKEN already set');
}

// 4. The first task will be judged on a fresh clone, so judge it that way now.
console.log('\nVerifying the committed code in a fresh clone (install, then every check)...');
const result = await verifyFreshClone({ projectDir });
if (result.ok) {
  step(true, 'fresh clone is green');
} else {
  for (const f of result.failed) {
    step(false, `${f.name} failed${f.timedOut ? ' (timed out)' : ` (exit ${f.exitCode})`}: ${f.command}`);
    if (f.tail) console.log(f.tail.split('\n').map((l) => `    ${l}`).join('\n'));
  }
  console.log('\nFix this before queueing a task: it would block as "base is red".');
}
console.log('\nNext: commit and push the new files, then open an issue with `plan:` and `task:` lines and add the `agent` label.');
process.exit(result.ok && advice.length === 0 ? 0 : 1);
