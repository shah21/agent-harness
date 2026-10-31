// A runner workflow must not let project text into anything a stranger can read: run names,
// job and step names, artifact names and concurrency groups. Only indices and run counters
// may be interpolated there.
const KEYED = /^\s*(?:-\s+)?(name|run-name|group):\s*(.*)$/;
const EXPR = /\$\{\{([^}]*)\}\}/g;
const ALLOWED = /^(?:strategy\.job-index|matrix\.index|github\.run_number|github\.run_id)$/;

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
