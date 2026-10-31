// A runner workflow must not let project text into anything a stranger can read: run names,
// job and step names, artifact names and concurrency groups. Only indices and run counters
// may be interpolated there.
const KEYED = /^\s*(?:-\s+)?(name|run-name|group):\s*(.*)$/;
const EXPR = /\$\{\{([^}]*)\}\}/g;
// `steps.names.outputs.*` are slot-keyed tags (an HMAC of the run id): they name nothing.
const ALLOWED = /^(?:strategy\.job-index|matrix\.index|github\.run_number|github\.run_id|steps\.names\.outputs\.(?:pub|bundle|out))$/;

export function lintNeutralNames(text) {
  const bad = [];
  String(text).split(/\r?\n/).forEach((line, i) => {
    const m = KEYED.exec(line);
    if (!m) return;
    for (const e of m[2].matchAll(EXPR)) {
      const expression = e[1].trim();
      if (!ALLOWED.test(expression)) bad.push({ line: i + 1, expression });
    }
  });
  return bad;
}

// GitHub prints every step's `env:` values after expanding them. A secret is masked there; a
// step output, a needs output or a matrix value other than the index is not.
const ENV_LINE = /^\s+[A-Z][A-Z0-9_]*:\s*(.*)$/;
const ENV_ALLOWED = /^(?:matrix\.index|strategy\.job-index|secrets\.[A-Z0-9_]+|inputs\.[a-z_]+|github\.(?:token|server_url|repository|run_id|run_number|event_name|event\.repository\.default_branch)|runner\.temp)$/;

export function lintEnvExpressions(text) {
  const bad = [];
  String(text).split(/\r?\n/).forEach((line, i) => {
    const m = ENV_LINE.exec(line);
    if (!m) return;
    for (const e of m[1].matchAll(EXPR)) {
      const expression = e[1].trim();
      if (!ENV_ALLOWED.test(expression)) bad.push({ line: i + 1, expression });
    }
  });
  return bad;
}
