// Pure helpers for debug runs: the issue a person writes and the report the agent writes.
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const META_LINE = /^(context|ref):[ \t]*\S*[ \t]*$/;

export function parseDebugIssue(body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  const context = /^context:[ \t]*(\S+)[ \t]*$/m.exec(text)?.[1] ?? null;
  const ref = /^ref:[ \t]*(\S+)[ \t]*$/m.exec(text)?.[1] ?? null;
  if (context && (context.startsWith('/') || context.split('/').includes('..'))) {
    return { error: `context path must be relative inside the repository: ${context}` };
  }
  if (ref && (!REF_RE.test(ref) || ref.includes('..') || ref.endsWith('/') || ref.endsWith('.lock'))) {
    return { error: `ref is not allowed: ${ref}` };
  }
  const symptom = text.split('\n').filter((l) => !META_LINE.test(l)).join('\n').trim();
  if (!symptom) return { error: 'issue body has no symptom text' };
  return { context, ref, symptom };
}

const KEYS = ['STATUS', 'PROBLEM', 'REPRODUCTION', 'EVIDENCE', 'HYPOTHESES', 'ROOT_CAUSE', 'OWNING_MODULE', 'NEXT_ACTION', 'UNKNOWNS', 'HUMAN_INPUT_NEEDED'];
const REQUIRED = {
  FINDINGS: KEYS.slice(1),
  INCONCLUSIVE: KEYS.slice(1),
  BLOCKED: ['PROBLEM', 'EVIDENCE', 'HUMAN_INPUT_NEEDED'],
};
const KEY_RE = new RegExp(`^(${KEYS.join('|')}):[ \\t]*(.*)$`);
const TAG_RE = /\b(CONFIRMED|INFERENCE|UNKNOWN)\b/;

export function parseDebugReport(text) {
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
  const status = value('STATUS');
  if (!('STATUS' in fields)) return { ok: false, errors: ['missing STATUS'] };
  if (!(status in REQUIRED)) return { ok: false, errors: [`STATUS must be FINDINGS, INCONCLUSIVE or BLOCKED, got "${status}"`] };
  const errors = REQUIRED[status].filter((k) => !value(k)).map((k) => `missing ${k}`);
  if (errors.length) return { ok: false, errors };

  const hypotheses = (fields.HYPOTHESES ?? [])
    .map((l) => l.trim())
    .filter((l) => /^\d+\.\s/.test(l))
    .map((l) => ({ text: l.replace(/^\d+\.\s*/, ''), tag: TAG_RE.exec(l)?.[1] ?? 'UNKNOWN' }));

  const rootCause = value('ROOT_CAUSE');
  const warnings = [];
  let finalStatus = status;
  if (status === 'FINDINGS' && (/^none\.?$/i.test(rootCause) || !hypotheses.some((h) => h.tag === 'CONFIRMED'))) {
    finalStatus = 'INCONCLUSIVE';
    warnings.push('FINDINGS downgraded to INCONCLUSIVE: a root cause needs at least one CONFIRMED hypothesis');
  }

  return {
    ok: true,
    warnings,
    report: {
      status: finalStatus,
      problem: value('PROBLEM'),
      reproduction: value('REPRODUCTION'),
      evidence: value('EVIDENCE'),
      hypotheses,
      rootCause,
      owningModule: value('OWNING_MODULE'),
      nextAction: value('NEXT_ACTION'),
      unknowns: value('UNKNOWNS'),
      humanInput: value('HUMAN_INPUT_NEEDED'),
    },
  };
}
