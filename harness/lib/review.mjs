// Pure decisions of the review loop: what the reviewer and the fixer said, and what happens next.
export const SEVERITIES = ['high', 'medium', 'low'];
const ID = /^R\d+$/;
const RULE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FENCE = /```json[ \t]*\r?\n([\s\S]*?)\r?\n```/;
const REPLY = /^(R\d+):\s*(FIXED|WONTFIX)(?::\s*(.*))?$/;

const fail = (error) => ({ ok: false, error });

export const actionable = (findings) => findings.filter((f) => f.severity !== 'low');
export const fingerprint = (f) => `${f.file}#${f.rule}`;

function checkFinding(f, at, seen, inDiff) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return `${at} must be an object`;
  if (typeof f.id !== 'string' || !ID.test(f.id)) return `${at}: "id" must look like R1`;
  if (seen.has(f.id)) return `${at}: duplicate id ${f.id}`;
  if (!SEVERITIES.includes(f.severity)) return `${f.id}: "severity" must be high, medium or low`;
  if (typeof f.file !== 'string' || !f.file) return `${f.id}: "file" must be a non-empty string`;
  if (f.line !== undefined && f.line !== null && !(Number.isInteger(f.line) && f.line > 0)) return `${f.id}: "line" must be a positive integer`;
  if (typeof f.rule !== 'string' || !RULE.test(f.rule)) return `${f.id}: "rule" must be a kebab-case slug`;
  if (typeof f.problem !== 'string' || !f.problem.trim()) return `${f.id}: "problem" must be a non-empty string`;
  if (f.fix !== undefined && typeof f.fix !== 'string') return `${f.id}: "fix" must be a string`;
  if (f.severity !== 'low' && !inDiff.has(f.file)) return `${f.id}: "${f.file}" is not in the diff`;
  return null;
}

export function parseReviewOutput(text, diffPaths) {
  const m = FENCE.exec(String(text ?? ''));
  if (!m) return fail('no ```json block in the review');
  let raw;
  try {
    raw = JSON.parse(m[1]);
  } catch (e) {
    return fail(`review JSON is invalid: ${e.message}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('review JSON must be an object');
  if (raw.status !== 'CLEAN' && raw.status !== 'FINDINGS') return fail('"status" must be CLEAN or FINDINGS');
  const list = raw.findings ?? [];
  if (!Array.isArray(list)) return fail('"findings" must be an array');
  const inDiff = new Set(diffPaths);
  const seen = new Set();
  const findings = [];
  for (const [i, f] of list.entries()) {
    const error = checkFinding(f, `finding ${i + 1}`, seen, inDiff);
    if (error) return fail(error);
    seen.add(f.id);
    findings.push({ id: f.id, severity: f.severity, file: f.file, line: f.line ?? null, rule: f.rule, problem: f.problem.trim(), fix: (f.fix ?? '').trim() });
  }
  if (raw.status === 'CLEAN' && actionable(findings).length) return fail('status is CLEAN but high or medium findings are listed');
  return { ok: true, status: raw.status, findings };
}

// First reply per id wins; ids the fixer did not answer are unaddressed.
export function parseFixReplies(text, ids) {
  const replies = new Map();
  for (const line of String(text ?? '').split('\n')) {
    const m = REPLY.exec(line.trim());
    if (!m || !ids.includes(m[1]) || replies.has(m[1])) continue;
    replies.set(m[1], m[2] === 'FIXED' ? { id: m[1], result: 'FIXED' } : { id: m[1], result: 'WONTFIX', reason: m[3]?.trim() || 'no reason given' });
  }
  return ids.map((id) => replies.get(id) ?? { id, result: 'UNADDRESSED' });
}

export const withoutCommit = (replies) => replies.map((r) => (r.result === 'FIXED' ? { id: r.id, result: 'UNADDRESSED' } : r));

// Rounds count reviews. A fix only runs when another review will check it.
export function nextStep({ round, maxRounds, findings, previous = null }) {
  const now = actionable(findings);
  if (now.length === 0) return 'clean';
  if (previous) {
    const before = new Set(actionable(previous).map(fingerprint));
    if (now.every((f) => before.has(fingerprint(f)))) return 'no-progress';
  }
  if (round >= maxRounds) return 'max-rounds';
  return 'fix';
}

// High and medium findings of the last completed review. A fix that ran after it was never confirmed.
export function openFindings(rounds) {
  const last = rounds.at(-1);
  if (!last) return [];
  return actionable(last.findings).map((f) => {
    const reply = last.reverted ? { result: 'REVERTED' } : last.fixes?.find((x) => x.id === f.id);
    if (!reply) return f;
    return { ...f, result: reply.result, ...(reply.reason ? { reason: reply.reason } : {}) };
  });
}

// The next step must fit in what is left of the budget; the longest step so far is the estimate.
export function fitsBudget({ elapsedSec, budgetSec, longestStepSec }) {
  return budgetSec - elapsedSec > longestStepSec;
}
