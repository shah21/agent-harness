// What the reviewer and the fixer are shown. Rules and context files are read at each
// repository's base commit, so the change under review cannot rewrite what it is judged by.
import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { matchesAny } from './glob.mjs';
import { renderPrompt, servicesRule } from './agent.mjs';

export const LIMITS = { file: 20000, rules: 100000, diff: 200000 };
const CONTEXT_NAMES = ['AGENTS.md', 'CLAUDE.md'];

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const cap = (text, max) => (text.length > max ? `${text.slice(0, max)}\n[truncated]` : text);

export function reviewRepos({ projectDir, baseSha, branch, target }) {
  return [
    { prefix: '', dir: projectDir, base: baseSha, branch },
    ...(target ? target.repos.map((r) => ({ prefix: `${r.path}/`, dir: r.dir, base: r.baseSha, branch: target.branch })) : []),
  ];
}

// Regular files at the base commit; symlinks and submodule entries are skipped.
function blobsAt(repo) {
  const files = new Set();
  for (const entry of git(repo.dir, 'ls-tree', '-r', '-z', repo.base).split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    const [mode, type] = entry.slice(0, tab).split(' ');
    if (type === 'blob' && mode !== '120000') files.add(entry.slice(tab + 1));
  }
  return files;
}

const show = (repo, path) => git(repo.dir, 'show', `${repo.base}:${path}`);
const owner = (repos, path) =>
  repos.filter((r) => path.startsWith(r.prefix)).sort((a, b) => b.prefix.length - a.prefix.length)[0] ?? null;

export function readRules(repos, globs) {
  if (!globs.length) return [];
  const out = [];
  let total = 0;
  for (const repo of repos) {
    for (const path of [...blobsAt(repo)].sort()) {
      if (!matchesAny(repo.prefix + path, globs)) continue;
      const text = cap(show(repo, path), LIMITS.file);
      if (total + text.length > LIMITS.rules) return out;
      total += text.length;
      out.push({ path: repo.prefix + path, text });
    }
  }
  return out;
}

export function nearestContext(repos, changed) {
  const blobs = new Map(repos.map((r) => [r, blobsAt(r)]));
  const picked = new Map();
  for (const full of changed) {
    const repo = owner(repos, full);
    if (!repo) continue;
    let dir = posix.dirname(full.slice(repo.prefix.length));
    for (;;) {
      const found = CONTEXT_NAMES.map((n) => (dir === '.' ? n : `${dir}/${n}`)).filter((p) => blobs.get(repo).has(p));
      if (found.length) {
        for (const p of found) picked.set(repo.prefix + p, { repo, path: p });
        break;
      }
      if (dir === '.') break;
      dir = posix.dirname(dir);
    }
  }
  return [...picked.keys()].sort().map((full) => {
    const { repo, path } = picked.get(full);
    return { path: full, text: cap(show(repo, path), LIMITS.file) };
  });
}

export function changedPaths(repos) {
  const paths = repos.flatMap((r) =>
    git(r.dir, 'diff', '--name-only', '-M', r.base, 'HEAD').split('\n').filter(Boolean).map((p) => r.prefix + p));
  return [...new Set(paths)].sort();
}

export function diffText(repos) {
  const parts = repos
    .map((r) => git(r.dir, 'diff', '-M', `--src-prefix=a/${r.prefix}`, `--dst-prefix=b/${r.prefix}`, r.base, 'HEAD'))
    .filter(Boolean);
  return cap(parts.join('\n'), LIMITS.diff);
}

export function planTaskSection(planText, task) {
  const text = String(planText).replace(/\r\n/g, '\n');
  const start = new RegExp(`^#{2,3} Task ${task}:.*$`, 'm').exec(text);
  if (!start) return '';
  const rest = text.slice(start.index);
  const next = /\n#{2,3} Task \d+:/.exec(rest.slice(start[0].length));
  return (next ? rest.slice(0, start[0].length + next.index) : rest).trim();
}

const where = (f) => (f.line ? `${f.file}:${f.line}` : f.file);

export function historyText(rounds) {
  if (!rounds.length) return '(first review)';
  return rounds
    .map((r) => [
      `Round ${r.n}:`,
      ...r.findings.map((f) => {
        const reply = r.fixes?.find((x) => x.id === f.id);
        const answer = reply ? ` → ${reply.result}${reply.reason ? `: ${reply.reason}` : ''}` : '';
        return `- ${f.id} ${f.severity} ${where(f)} ${f.rule}: ${f.problem}${answer}`;
      }),
    ].join('\n'))
    .join('\n\n');
}

export function findingsText(findings) {
  return findings.map((f) => `- ${f.id} (${f.severity}) ${where(f)} ${f.rule}: ${f.problem}${f.fix ? ` Suggested fix: ${f.fix}` : ''}`).join('\n');
}

const block = (name, text) => `<untrusted-data name="${name}">\n${text}\n</untrusted-data>`;
const files = (list) => (list.length ? list.map((f) => block(f.path, f.text)).join('\n\n') : '(none)');

export function renderReviewPrompt(template, { round, planTask, diff, rules, contexts, history, outputPath }) {
  return renderPrompt(template, {
    ROUND: round,
    OUTPUT_PATH: outputPath,
    PLAN_TASK: block('plan-task', planTask),
    DIFF: block('diff', diff),
    RULES: files(rules),
    CONTEXT: files(contexts),
    HISTORY: block('earlier-rounds', history),
  });
}

export function renderFixPrompt(template, { round, branch, planTask, diff, findings, outputPath, checks, protectedPaths, hasSetup }) {
  return renderPrompt(template, {
    ROUND: round,
    BRANCH: branch,
    OUTPUT_PATH: outputPath,
    PLAN_TASK: block('plan-task', planTask),
    FINDINGS: block('findings', findingsText(findings)),
    DIFF: block('diff', diff),
    CHECKS: Object.entries(checks).map(([name, cmd]) => `   - ${name}: \`${cmd}\``).join('\n'),
    PROTECTED: protectedPaths.map((p) => `\`${p}\``).join(', '),
    SERVICES_RULE: servicesRule(hasSetup),
  });
}
