#!/usr/bin/env node
// Pushes each target repository's thin bundle and opens or updates a draft PR in it.
// Runs in the publish job: no agent ever ran on this VM, and hooks are disabled.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BRANCH_RE, RELATED_TOKEN } from './lib/target.mjs';

const { values } = parseArgs({ options: { verdict: { type: 'string' }, 'bundle-dir': { type: 'string' }, out: { type: 'string' } } });
const verdict = JSON.parse(readFileSync(values.verdict, 'utf8'));
const token = process.env.TARGET_PUSH_TOKEN ?? '';
const remoteFor = (repo) =>
  (process.env.TARGET_PUSH_REMOTE_TEMPLATE ?? `https://x-access-token:${token}@github.com/{repo}.git`).replace('{repo}', repo);
const gh = (...args) => execFileSync('gh', args, { env: { ...process.env, GH_TOKEN: token }, encoding: 'utf8' }).trim();
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const opened = [];
const save = () => writeFileSync(values.out, JSON.stringify(opened.map(({ body, work, ...p }) => p), null, 2));
let stage = 'start';
let current = '';

try {
  for (const t of verdict.targets.filter((x) => x.commits > 0)) {
    current = t.repo;
    stage = 'push';
    if (!BRANCH_RE.test(t.branch) || (t.base !== null && !BRANCH_RE.test(t.base))) throw new Error(`refusing branch name "${t.branch}"`);
    const work = mkdtempSync(join(tmpdir(), 'target-publish-'));
    git(work, 'init', '-q');
    git(work, 'fetch', '-q', '--depth=1', remoteFor(t.repo), t.baseSha);
    git(work, 'fetch', '-q', resolve(values['bundle-dir'], t.bundle), `refs/heads/${t.branch}:refs/heads/${t.branch}`);
    git(work, 'push', '-q', '--force', remoteFor(t.repo), `refs/heads/${t.branch}:refs/heads/${t.branch}`);

    stage = 'pr';
    const base = t.base ?? gh('repo', 'view', t.repo, '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name');
    const bodyFile = join(work, 'body.md');
    writeFileSync(bodyFile, t.prBody.replaceAll(RELATED_TOKEN, ''));
    const existing = gh('pr', 'list', '--repo', t.repo, '--head', t.branch, '--state', 'open', '--json', 'number,url', '-q', '.[0] // empty');
    let pr;
    if (existing) {
      pr = JSON.parse(existing);
      gh('pr', 'edit', String(pr.number), '--repo', t.repo, '--base', base, '--title', t.prTitle, '--body-file', bodyFile);
    } else {
      const url = gh('pr', 'create', '--draft', '--repo', t.repo, '--base', base, '--head', t.branch, '--title', t.prTitle, '--body-file', bodyFile);
      pr = { number: Number(url.split('/').pop()), url };
    }
    opened.push({ repo: t.repo, role: t.role, number: pr.number, url: pr.url, branch: t.branch, base, body: t.prBody, work });
    save();
  }

  stage = 'related';
  if (opened.length > 1) {
    for (const p of opened) {
      current = p.repo;
      const related = opened.filter((o) => o !== p).map((o) => `- ${o.repo}#${o.number}`).join('\n');
      const bodyFile = join(p.work, 'body.md');
      writeFileSync(bodyFile, p.body.replaceAll(RELATED_TOKEN, `## Related\n${related}`));
      gh('pr', 'edit', String(p.number), '--repo', p.repo, '--body-file', bodyFile);
    }
  }
  save();
} catch (e) {
  const detail = String(e.stderr || e.message).split('\n').find(Boolean) ?? 'unknown error';
  console.error(`target publish failed at ${stage} for ${current}: ${detail}`);
  process.exit(1);
}
