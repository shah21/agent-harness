import { readFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadConfig } from './config.mjs';
import { runWithTimeout } from './run-cmd.mjs';
import { tailLog } from './tail.mjs';

// Connecting a repo to the harness: the mechanical steps, plus checks for the mistakes
// that have actually blocked first tasks.
export const LABELS = ['agent', 'agent:opus', 'agent:running', 'agent:ready', 'agent:blocked', 'agent:waiting'];
const SECRET = 'CLAUDE_CODE_OAUTH_TOKEN';

export function deriveConfig({ pkg, files }) {
  const scripts = pkg?.scripts ?? {};
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const pm = files.has('pnpm-lock.yaml') ? 'pnpm' : files.has('yarn.lock') ? 'yarn' : 'npm';
  const install = { pnpm: 'pnpm install --frozen-lockfile', yarn: 'yarn install --frozen-lockfile', npm: 'npm ci' }[pm];
  const script = (name) => (pm === 'npm' ? (name === 'test' ? 'npm test' : `npm run ${name}`) : `${pm} ${name}`);
  const exec = (cmd) => (pm === 'npm' ? `npx ${cmd}` : `${pm} exec ${cmd}`);

  const checks = {};
  if (scripts.test) checks.test = script('test');
  if (scripts.lint) checks.lint = script('lint');
  if (scripts.typecheck) checks.typecheck = script('typecheck');
  else if (files.has('tsconfig.json')) {
    checks.typecheck = deps.next ? `${exec('next typegen')} && ${exec('tsc --noEmit')}` : exec('tsc --noEmit');
  }
  if (scripts.build) checks.build = script('build');
  if (Object.keys(checks).length === 0) {
    throw new Error('no test, lint, typecheck or build scripts found; write agent.config.json by hand');
  }
  return { install, checks };
}

export function lintProject({ pkg, gitignore, files, vercelJson }) {
  const advice = [];
  const ignored = String(gitignore ?? '').split(/\r?\n/).map((l) => l.trim());
  if (ignored.some((l) => l === '.env*' || l === '.env.*') && !ignored.includes('!.env.example')) {
    advice.push('.gitignore ignores `.env*`, which also swallows a new `.env.example`; add `!.env.example` on the next line.');
  }
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const typecheck = pkg?.scripts?.typecheck;
  if (deps.next && typecheck && !/next typegen/.test(typecheck)) {
    advice.push('Next.js generates route types that a fresh checkout does not have; make the typecheck script run `next typegen` before `tsc`, or every task is blocked as "base is red".');
  }
  const usesVercel = files.has('.vercel') || vercelJson !== null;
  if (usesVercel && !/deploymentEnabled|ignoreCommand/.test(vercelJson ?? '')) {
    advice.push('Vercel builds preview deployments for every branch, including every agent branch; turn them off for `agent/*` in vercel.json (`git.deploymentEnabled`) or add an `ignoreCommand`.');
  }
  return advice;
}

const template = (name) => readFileSync(new URL(`../../templates/${name}`, import.meta.url), 'utf8');

export function renderFiles({ owner, existing = new Set(), config, force = false }) {
  const defs = [
    ['.github/workflows/agent.yml', template('agent.yml').replaceAll('OWNER', owner)],
    ['.github/workflows/close-merged.yml', template('close-merged.yml').replaceAll('OWNER', owner)],
    ['.github/ISSUE_TEMPLATE/agent-task.md', template('agent-task.md')],
    ['agent.config.json', `${JSON.stringify(config, null, 2)}\n`],
  ];
  return defs.map(([path, content]) => ({ path, content, skipped: !force && existing.has(path) }));
}

// Runs install and every check in a fresh clone of the committed code, the way the harness
// will, so a check that only passes because of a generated or ignored local file fails here
// and not as "base is red" on the first task. The config is read from the working tree so
// it can be verified before it is committed.
export async function verifyFreshClone({ projectDir }) {
  const work = mkdtempSync(join(tmpdir(), 'bootstrap-verify-'));
  const clone = join(work, 'clone');
  const logs = join(work, 'logs');
  try {
    execFileSync('git', ['clone', '-q', '--no-hardlinks', projectDir, clone], { stdio: 'pipe' });
    mkdirSync(logs);
    const config = loadConfig(readFileSync(join(projectDir, 'agent.config.json'), 'utf8'));
    const env = { ...process.env, ...config.env };
    for (const name of ['CLAUDE_CODE_OAUTH_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) delete env[name];

    const failed = [];
    const step = async (name, command, timeoutSec) => {
      const logFile = join(logs, `${name}.log`);
      const r = await runWithTimeout(command, { cwd: clone, timeoutSec, logFile, env });
      if (r.exitCode !== 0 || r.timedOut) {
        let tail = '';
        try {
          tail = tailLog(readFileSync(logFile, 'utf8'));
        } catch {
          // no log written
        }
        failed.push({ name, command, exitCode: r.exitCode, timedOut: r.timedOut, tail });
      }
    };
    await step('install', config.install, config.timeouts.install);
    if (failed.length === 0) {
      for (const [name, command] of Object.entries(config.checks)) await step(name, command, config.timeouts.check);
    }
    return { ok: failed.length === 0, failed };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function ensureLabels({ repo, run }) {
  const created = [];
  const existing = [];
  for (const label of LABELS) {
    try {
      await run(['label', 'create', label, '--repo', repo, '--color', '5319e7']);
      created.push(label);
    } catch (e) {
      if (!/already exists/i.test(e?.message ?? '')) throw e;
      existing.push(label);
    }
  }
  return { created, existing };
}

// The API ignores form-encoded booleans, so the body is sent as JSON.
export async function setActionsPermissions({ repo, run }) {
  const path = `repos/${repo}/actions/permissions/workflow`;
  const current = JSON.parse(await run(['api', path]));
  if (current.can_approve_pull_request_reviews === true) return { changed: false };
  await run(['api', '-X', 'PUT', path, '--input', '-'], {
    input: JSON.stringify({
      default_workflow_permissions: current.default_workflow_permissions,
      can_approve_pull_request_reviews: true,
    }),
  });
  return { changed: true };
}

// gh prompts for the value itself, so the token never passes through this script.
export async function ensureSecret({ repo, run }) {
  const list = await run(['secret', 'list', '--repo', repo]);
  if (list.split('\n').some((line) => line.split('\t')[0].trim() === SECRET)) return { set: false };
  await run(['secret', 'set', SECRET, '--repo', repo], { inherit: true });
  return { set: true };
}
