import { parseReport } from './report.mjs';
import { matchesAny } from './glob.mjs';

const MANIFESTS = ['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'];

function blocked(kind, reasons, extra = {}) {
  return { outcome: 'BLOCKED', kind, reasons, warnings: [], ...extra };
}

const TRAILER = /^([A-Za-z][A-Za-z0-9-]*):\s/;

export function trailerViolations(commits, forbidden) {
  if (!forbidden.length) return [];
  const keys = new Set(forbidden.map((k) => k.toLowerCase()));
  const hits = commits.filter((c) => c.body.split('\n').some((line) => keys.has(TRAILER.exec(line.trim())?.[1].toLowerCase())));
  return hits.length ? [`commit messages carry forbidden trailers: ${hits.map((c) => c.sha.slice(0, 7)).join(', ')}`] : [];
}

// Rules any change must keep, whoever made it: protected paths, submodule pointers, existing tests.
export function diffViolations({ diff, config, pointerErrors = [], commitErrors = [] }) {
  const touched = diff.flatMap((d) => (d.oldPath ? [d.oldPath, d.path] : [d.path]));
  const protectedHits = [...new Set(touched.filter((p) => matchesAny(p, config.protectedPaths)))];
  if (protectedHits.length) return [`changes touch protected paths: ${protectedHits.join(', ')}`];
  if (pointerErrors.length) return pointerErrors;
  const removedTests = diff
    .filter((d) => (d.status === 'D' && matchesAny(d.path, config.testGlobs)) || (d.status === 'R' && matchesAny(d.oldPath, config.testGlobs)))
    .map((d) => (d.status === 'R' ? d.oldPath : d.path));
  if (removedTests.length) return [`existing tests deleted or renamed: ${removedTests.join(', ')}`];
  return commitErrors;
}

// Rows are evaluated in spec order (§7); the first match wins.
export function decide({ agent, reportText, commits, diff, checks, config, pointerErrors = [], commitErrors = [] }) {
  if (agent.timedOut) return blocked('agent', ['agent timed out before finishing']);
  if (agent.exitCode !== 0) {
    if (agent.authFailed) return blocked('agent', ['Claude authentication failed (401): check the CLAUDE_CODE_OAUTH_TOKEN secret']);
    return blocked('agent', [`agent exited with code ${agent.exitCode}`]);
  }

  if (reportText == null) return blocked('harness', ['agent wrote no report']);
  const parsed = parseReport(reportText);
  if (!parsed.ok) return blocked('harness', parsed.errors.map((e) => `report: ${e}`));
  const report = parsed.report;

  if (report.status === 'BLOCKED') return blocked('report', [report.blocker], { report });
  if (commits === 0) return blocked('gate', ['report says READY_FOR_QA but the branch has no commits'], { report });

  const violations = diffViolations({ diff, config, pointerErrors, commitErrors });
  if (violations.length) return blocked('gate', violations, { report });

  const failed = Object.entries(checks).filter(([, c]) => !c.ok).map(([name]) => name);
  if (failed.length) {
    return blocked(
      'gate',
      failed.map((n) => (report.checks[n] === 'PASS' ? `check "${n}" failed (report claimed PASS)` : `check "${n}" failed`)),
      { report },
    );
  }

  const warnings = [];
  for (const name of Object.keys(checks)) {
    if (report.checks[name] !== 'PASS') {
      warnings.push(`report listed check "${name}" as ${report.checks[name] ?? 'missing'}, but it passed when the harness ran it`);
    }
  }
  const actual = [...new Set(diff.map((d) => d.path))].sort();
  const claimed = [...new Set(report.changedFiles)].sort();
  if (actual.join('\n') !== claimed.join('\n')) warnings.push(`CHANGED_FILES does not match the diff (diff: ${actual.join(', ')})`);
  const deps = actual.filter((p) => MANIFESTS.includes(p.split('/').pop()));
  if (deps.length) warnings.push(`dependency files changed: ${deps.join(', ')}`);

  return { outcome: 'READY_FOR_QA', kind: null, reasons: [], warnings, report };
}
