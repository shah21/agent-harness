// One trimmed record per run, kept in a private store. An allow-list: a verdict carries
// the agent's report, the account used and check logs, none of which belong here.
export function buildRecord({ verdict, entry, runId, now = new Date() }) {
  return {
    v: 1,
    ts: now.toISOString(),
    repo: entry.repo,
    issue: verdict.issue ?? null,
    plan: verdict.plan ?? null,
    task: verdict.task ?? null,
    outcome: verdict.outcome ?? null,
    kind: verdict.kind ?? null,
    reasons: (verdict.reasons ?? []).slice(0, 5).map((r) => String(r).slice(0, 300)),
    model: verdict.model ?? null,
    commits: verdict.commits ?? 0,
    tokenKind: entry.tokenKind ?? null,
    runner: { run: String(runId), index: entry.index },
  };
}

export function recordPath(record) {
  return `runs/${record.ts.slice(0, 7)}/${record.runner.run}-${record.runner.index}.json`;
}
