// Finds project names where they must not be. The blocklist is private and is only ever read
// at scan time. Hits carry a path and a line, never the term.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SKIP = new Set(['.git', 'node_modules']);

export function parseBlocklist(text) {
  const terms = String(text).split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#') && l.length >= 3);
  return [...new Set(terms)];
}

export function scanText(path, text, terms) {
  const hits = [];
  String(text).split(/\r?\n/).forEach((line, i) => {
    const low = line.toLowerCase();
    if (terms.some((t) => low.includes(t))) hits.push({ path, line: i + 1 });
  });
  return hits;
}

export function scanDir(root, terms, { maxBytes = 1_000_000 } = {}) {
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const full = join(dir, name);
      const rel = relative(root, full);
      const st = statSync(full);
      if (terms.some((t) => name.toLowerCase().includes(t))) hits.push({ path: rel, line: 0 });
      if (st.isDirectory()) walk(full);
      else if (st.size <= maxBytes) {
        const buf = readFileSync(full);
        if (!buf.includes(0)) hits.push(...scanText(rel, buf.toString('utf8'), terms));
      }
    }
  };
  walk(root);
  return hits;
}
