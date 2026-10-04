// Last lines of a command log, safe to paste into an issue comment: ANSI codes
// removed, line endings normalised, size capped at a line boundary.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function tailLog(text, { lines = 60, maxChars = 6000 } = {}) {
  const all = String(text).replace(ANSI, '').replace(/\r\n?/g, '\n').split('\n');
  while (all.length && all[all.length - 1].trim() === '') all.pop();
  let out = all.slice(-lines).join('\n');
  if (out.trim() === '') return '';
  if (out.length > maxChars) {
    out = out.slice(-maxChars);
    const firstBreak = out.indexOf('\n');
    out = `… (truncated)\n${firstBreak === -1 ? out : out.slice(firstBreak + 1)}`;
  }
  return out;
}
