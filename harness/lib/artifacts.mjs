import { readdirSync, lstatSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { matchesAny } from './glob.mjs';

export const ARTIFACT_LIMITS = { maxBytes: 50 * 1024 * 1024, maxFiles: 2000 };
const SKIP_DIRS = new Set(['.git', 'node_modules']);

// Regular files only, in a stable order. Dirents come from lstat, so symlinks
// are neither files nor directories here and are never followed.
function* walk(root, dir = root) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(root, full);
    } else if (entry.isFile()) {
      yield relative(root, full).split(sep).join('/');
    }
  }
}

// Copies project files matching `globs` into destDir, keeping relative paths.
// destDir is emptied first: the agent can write under the run's output folder.
export function collectArtifacts({ projectDir, globs, destDir, limits = ARTIFACT_LIMITS }) {
  rmSync(destDir, { recursive: true, force: true });
  const result = { files: 0, bytes: 0, skipped: 0 };
  for (const rel of walk(projectDir)) {
    if (!matchesAny(rel, globs)) continue;
    const source = join(projectDir, rel);
    const size = lstatSync(source).size;
    if (result.files >= limits.maxFiles || result.bytes + size > limits.maxBytes) {
      result.skipped++;
      continue;
    }
    const target = join(destDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    result.files++;
    result.bytes += size;
  }
  if (result.skipped > 0) {
    mkdirSync(destDir, { recursive: true });
    writeFileSync(
      join(destDir, 'TRUNCATED.txt'),
      `${result.skipped} matching file(s) skipped: limits are ${limits.maxFiles} files and ${limits.maxBytes} bytes.\n`,
    );
  }
  return result;
}
