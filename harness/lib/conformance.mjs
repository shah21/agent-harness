// How closely a change follows its plan task: which planned files changed,
// which have code in the plan that the file matches exactly, and which files
// the plan does not mention. Advisory only: it produces warnings, never a block.
const MANIFESTS = new Set(['package.json', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']);
const FILE_LINE = /^[-*]\s+(Create|Modify|Delete|Test):\s*(.+)$/gm;
const CODE_BLOCK = /(?:Create|Replace)[^\n`]*`([^`\n]+)`[^\n]*:\n\n```[\w-]*\n([\s\S]*?)\n```/g;

export function parsePlanTask(planText, task) {
  const text = String(planText).replace(/\r\n/g, '\n');
  const start = new RegExp(`^#{2,3} Task ${task}:.*$`, 'm').exec(text);
  if (!start) return null;
  const rest = text.slice(start.index + start[0].length);
  const next = /^#{2,3} Task \d+:/m.exec(rest);
  const section = next ? rest.slice(0, next.index) : rest;

  const files = [];
  for (const m of section.matchAll(FILE_LINE)) {
    for (const p of m[2].matchAll(/`([^`]+)`/g)) {
      files.push({ action: m[1], path: p[1].replace(/:\d+(?:-\d+)?$/, '') });
    }
  }
  const blocks = new Map();
  for (const m of section.matchAll(CODE_BLOCK)) {
    if (!blocks.has(m[1])) blocks.set(m[1], m[2]);
  }
  return { files, blocks };
}

// diff: [{ status, path, oldPath? }] as produced by parseDiff; readFile(path) returns
// the file's content in the change, or null when it cannot be read.
export function comparePlan(planTask, diff, readFile) {
  if (!planTask || planTask.files.length === 0) return null;
  const planned = new Set(planTask.files.map((f) => f.path));
  const touched = new Set(diff.flatMap((d) => (d.oldPath ? [d.oldPath, d.path] : [d.path])));

  const unexpected = [...touched].filter((p) => !planned.has(p) && !MANIFESTS.has(p.split('/').pop())).sort();
  const missing = [...planned].filter((p) => !touched.has(p)).sort();

  const identical = [];
  const differs = [];
  for (const [path, code] of planTask.blocks) {
    if (!touched.has(path)) continue;
    const actual = readFile(path);
    if (actual === null || actual === undefined) continue;
    (actual.trim() === code.trim() ? identical : differs).push(path);
  }
  return {
    planned: planned.size,
    touchedPlanned: [...planned].filter((p) => touched.has(p)).length,
    checked: identical.length + differs.length,
    identical: identical.sort(),
    differs: differs.sort(),
    missing,
    unexpected,
  };
}

export function conformanceWarnings(c) {
  const warnings = [];
  if (c.differs.length) warnings.push(`files differ from the plan's code: ${c.differs.join(', ')}`);
  if (c.missing.length) warnings.push(`planned files not changed: ${c.missing.join(', ')}`);
  if (c.unexpected.length) warnings.push(`files changed but not listed in the plan: ${c.unexpected.join(', ')}`);
  return warnings;
}
