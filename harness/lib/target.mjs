// Pure helpers for tasks whose code lives in a separate target repository.
export const BRANCH_RE = /^[a-z0-9][a-z0-9._/-]{0,99}$/;
export const RELATED_TOKEN = '<!-- agent-related -->';
export const TEMPLATE_VARS = ['issue', 'task', 'taskTitle', 'summary', 'changedFiles', 'checks', 'related'];

const TYPES = ['feat', 'fix', 'chore', 'refactor', 'test', 'docs', 'perf'];
const TYPE_RE = new RegExp(`^(${TYPES.join('|')}):\\s*(.+)$`);

export function splitTaskType(title) {
  const text = String(title).trim();
  const m = TYPE_RE.exec(text);
  return m ? { type: m[1], title: m[2] } : { type: 'fix', title: text };
}

export function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');
}

export function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, name) => {
    if (!(name in vars)) throw new Error(`template uses unknown variable {${name}}`);
    return vars[name];
  });
}

export function renderBranch(template, { issue, task, taskTitle }) {
  const { type, title } = splitTaskType(taskTitle);
  const vars = { slug: slugify(title), type, issue: String(issue), task: String(task) };
  const branch = String(template).replace(/\{(\w+)\}/g, (_, name) => {
    if (!(name in vars)) throw new Error(`branch template uses unknown variable {${name}}`);
    return vars[name];
  });
  if (!BRANCH_RE.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.endsWith('.lock')) {
    throw new Error(`branch name "${branch}" is not allowed`);
  }
  return branch;
}

const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

export function parseGitmodules(text) {
  const entries = [];
  let current = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (/^\[submodule\s+"[^"]*"\]$/.test(line)) {
      current = {};
      entries.push(current);
      continue;
    }
    const m = /^(\w+)\s*=\s*(.+)$/.exec(line);
    if (m && current) current[m[1]] = m[2].trim();
  }
  return entries.map((e) => {
    if (!e.path || !e.url) throw new Error('.gitmodules entry without path or url');
    const u = GITHUB_URL.exec(e.url);
    if (!u) throw new Error(`unsupported submodule URL "${e.url}" (only https://github.com/<owner>/<name>)`);
    if (e.path.startsWith('/') || e.path.split('/').includes('..')) throw new Error(`submodule path "${e.path}" must be relative`);
    return { path: e.path, repo: u[1] };
  });
}

const MARKER_RE = /<!-- agent-targets (\{.*?\}) -->/s;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function targetsMarker(prs) {
  return `<!-- agent-targets ${JSON.stringify({ prs })} -->`;
}

// The marker reaches shell steps (as a checkout ref and PR base), so every field is checked.
export function parseTargetsMarker(text) {
  const m = MARKER_RE.exec(String(text ?? ''));
  if (!m) return null;
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!Array.isArray(data?.prs)) return null;
  const valid = data.prs.every((p) =>
    typeof p?.repo === 'string' && REPO_RE.test(p.repo)
    && Number.isInteger(p.number)
    && typeof p.branch === 'string' && BRANCH_RE.test(p.branch)
    && typeof p.base === 'string' && BRANCH_RE.test(p.base)
    && (p.role === 'sub' || p.role === 'super'));
  return valid ? data.prs : null;
}

export function latestTargets(comments) {
  const ready = (comments ?? []).filter((c) => String(c?.body ?? '').startsWith('✅ **READY_FOR_QA**'));
  return ready.length ? parseTargetsMarker(ready.at(-1).body) : null;
}

export function targetPromptSection({ path, repo, branch }) {
  return [
    '',
    '## Target repository',
    '',
    `- The code to change is in \`${path}\`, a clone of \`${repo}\` with its submodules. Every repository there already has branch \`${branch}\` checked out; stay on it.`,
    '- Commit inside a submodule first, then commit in the superproject so its submodule pointer includes that commit.',
    '- Commit in this repository (the root) only what the task asks for here.',
    `- In CHANGED_FILES, list target files by their path from the root, for example \`${path}/src/x.ts\`.`,
    '- Do not push and do not change remotes.',
    '',
  ].join('\n');
}
