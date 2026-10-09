import { renderBranch, fill, TEMPLATE_VARS } from './target.mjs';

const ALWAYS_PROTECTED = ['.github/**', 'agent.config.json'];
const DEFAULTS = {
  model: 'sonnet',
  maxTurns: 150,
  timeouts: { install: '15m', claude: '45m', check: '10m', setup: '5m' },
  testGlobs: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', 'e2e/**'],
};

export function parseDuration(value) {
  const m = /^(\d+)(s|m|h)$/.exec(String(value));
  if (!m || Number(m[1]) === 0) throw new Error(`invalid duration "${value}" (use e.g. 30s, 10m, 1h)`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600 }[m[2]];
}

// Names the harness controls itself; a project config must not override them.
const RESERVED_ENV = /^(CLAUDE_CODE_OAUTH_TOKEN.*|GITHUB_.*|GH_.*|ACTIONS_.*|RUNNER_.*|PATH|HOME|REPORT_PATH|PROMPT_FILE|AGENT_.*)$/;

// Non-secret values the project needs to install, build and test (e.g. a
// placeholder DATABASE_URL). Committed in the repo, so never real secrets.
function envMap(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('"env" must be an object of NAME: "value"');
  for (const [name, v] of Object.entries(value)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`env name "${name}" must be UPPER_SNAKE_CASE`);
    if (RESERVED_ENV.test(name)) throw new Error(`env "${name}" is reserved by the harness`);
    if (typeof v !== 'string') throw new Error(`env "${name}" must be a string`);
  }
  return { ...value };
}

function stringArray(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) {
    throw new Error(`"${field}" must be an array of strings`);
  }
  return value;
}

// Globs are matched against project-relative paths, so they must stay inside the project.
function artifactGlobs(value) {
  const globs = stringArray(value, 'artifacts');
  for (const g of globs) {
    if (!g || g.startsWith('/') || g.split('/').includes('..')) {
      throw new Error(`artifact glob "${g}" must be a relative path inside the project`);
    }
  }
  return globs;
}

const relativeInside = (p) => typeof p === 'string' && p !== '' && !p.startsWith('/') && !p.split('/').some((s) => s === '' || s === '.' || s === '..');

function targetConfig(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('"target" must be an object');
  const { repo, path, branch = 'agent/issue-{issue}', pr = {}, author = null } = value;
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('"target.repo" must be "owner/name"');
  if (!relativeInside(path)) throw new Error('"target.path" must be a relative path inside the project');
  if (typeof branch !== 'string') throw new Error('"target.branch" must be a string');
  try {
    renderBranch(branch, { issue: 1, task: 1, taskTitle: 'feat: check' });
  } catch (e) {
    throw new Error(`"target.branch": ${e.message}`);
  }
  if (!pr || typeof pr !== 'object' || Array.isArray(pr)) throw new Error('"target.pr" must be an object');
  const title = pr.title ?? 'Task {task}: {taskTitle}';
  if (typeof title !== 'string' || !title.trim()) throw new Error('"target.pr.title" must be a non-empty string');
  try {
    fill(title, Object.fromEntries(TEMPLATE_VARS.map((v) => [v, ''])));
  } catch (e) {
    throw new Error(`"target.pr.title": ${e.message}`);
  }
  const body = pr.body ?? null;
  if (body !== null && !relativeInside(body)) throw new Error('"target.pr.body" must be a relative path inside the project');
  if (author !== null && (typeof author?.name !== 'string' || typeof author?.email !== 'string')) {
    throw new Error('"target.author" must have string "name" and "email"');
  }
  return { repo, path, branch, pr: { title, body }, author: author && { name: author.name, email: author.email } };
}

function contextGlobs(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) {
    throw new Error('"debug.contextPaths" must be an array of strings');
  }
  for (const g of value) {
    if (!g || g.startsWith('/') || g.split('/').includes('..')) {
      throw new Error(`debug context path "${g}" must be a relative path inside the repository`);
    }
  }
  return value;
}

function debugConfig(value) {
  if (value === undefined) value = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('"debug" must be an object');
  const maxTurns = value.maxTurns ?? 60;
  if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error('"debug.maxTurns" must be a positive integer');
  return { contextPaths: contextGlobs(value.contextPaths), timeout: parseDuration(value.timeout ?? '30m'), maxTurns };
}

export function loadConfig(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`not valid JSON: ${e.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('must be a JSON object');
  if (typeof raw.install !== 'string' || !raw.install.trim()) throw new Error('"install" must be a non-empty string');

  const checks = raw.checks;
  if (!checks || typeof checks !== 'object' || Array.isArray(checks) || Object.keys(checks).length === 0) {
    throw new Error('"checks" must be an object with at least one check');
  }
  for (const [name, cmd] of Object.entries(checks)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new Error(`check name "${name}" must be lowercase letters, digits, - or _`);
    if (typeof cmd !== 'string' || !cmd.trim()) throw new Error(`check "${name}" must be a non-empty command string`);
  }

  const model = raw.model ?? DEFAULTS.model;
  if (typeof model !== 'string' || !model) throw new Error('"model" must be a non-empty string');
  const maxTurns = raw.maxTurns ?? DEFAULTS.maxTurns;
  if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error('"maxTurns" must be a positive integer');

  if (raw.setup !== undefined && (typeof raw.setup !== 'string' || !raw.setup.trim())) {
    throw new Error('"setup" must be a non-empty command string');
  }

  const t = { ...DEFAULTS.timeouts, ...(raw.timeouts ?? {}) };
  const timeouts = {
    install: parseDuration(t.install),
    claude: parseDuration(t.claude),
    check: parseDuration(t.check),
    setup: parseDuration(t.setup),
  };

  return {
    install: raw.install,
    setup: raw.setup ?? null,
    checks: { ...checks },
    model,
    maxTurns,
    timeouts,
    protectedPaths: [...new Set([...ALWAYS_PROTECTED, ...stringArray(raw.protectedPaths, 'protectedPaths')])],
    testGlobs: raw.testGlobs === undefined ? DEFAULTS.testGlobs : stringArray(raw.testGlobs, 'testGlobs'),
    env: envMap(raw.env),
    artifacts: artifactGlobs(raw.artifacts),
    debug: debugConfig(raw.debug),
    target: targetConfig(raw.target),
  };
}
