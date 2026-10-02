const KEYS = ['STATUS', 'TASK', 'SUMMARY', 'CHANGED_FILES', 'CHECKS', 'SELF_REVIEW', 'KNOWN_ISSUES', 'BLOCKER', 'EVIDENCE', 'REQUIRED_HUMAN_ACTION'];
const REQUIRED = {
  READY_FOR_QA: ['SUMMARY', 'CHANGED_FILES', 'CHECKS', 'SELF_REVIEW', 'KNOWN_ISSUES'],
  BLOCKED: ['BLOCKER', 'EVIDENCE', 'REQUIRED_HUMAN_ACTION'],
};
const KEY_RE = new RegExp(`^(${KEYS.join('|')}):[ \\t]*(.*)$`);

export function parseReport(text) {
  const lines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !/^\s*```/.test(l));

  const fields = {};
  let current = null;
  for (const line of lines) {
    const m = KEY_RE.exec(line);
    if (m && !(m[1] in fields)) {
      current = m[1];
      fields[current] = m[2] ? [m[2]] : [];
    } else if (current) {
      fields[current].push(line);
    }
  }

  const value = (k) => (fields[k] ?? []).join('\n').trim();
  const listItems = (k) =>
    (fields[k] ?? [])
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).trim().replace(/^`(.*)`$/, '$1'));

  const errors = [];
  const status = value('STATUS');
  if (!('STATUS' in fields)) errors.push('missing STATUS');
  else if (!(status in REQUIRED)) errors.push(`STATUS must be READY_FOR_QA or BLOCKED, got "${status}"`);
  if (!value('TASK')) errors.push('missing TASK');
  for (const k of REQUIRED[status] ?? []) if (!value(k)) errors.push(`missing ${k}`);
  if (errors.length) return { ok: false, errors };

  const checks = {};
  for (const item of listItems('CHECKS')) {
    const m = /^([a-z][a-z0-9_-]*):\s*(PASS|FAIL|NOT_RUN)\b/.exec(item);
    if (!m) return { ok: false, errors: [`unreadable CHECKS line: "- ${item}"`] };
    checks[m[1]] = m[2];
  }

  return {
    ok: true,
    report: {
      status,
      task: value('TASK'),
      summary: value('SUMMARY'),
      changedFiles: listItems('CHANGED_FILES'),
      checks,
      selfReview: value('SELF_REVIEW'),
      knownIssues: value('KNOWN_ISSUES'),
      blocker: value('BLOCKER'),
      evidence: value('EVIDENCE'),
      requiredHumanAction: value('REQUIRED_HUMAN_ACTION'),
    },
  };
}
