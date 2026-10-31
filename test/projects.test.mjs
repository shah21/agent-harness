import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProjects } from '../harness/lib/projects.mjs';

const text = (o) => JSON.stringify(o);

test('reads projects; the token owner defaults to the repo owner and the cap to 3', () => {
  const r = parseProjects(text({ projects: [{ repo: 'alice/one' }, { repo: 'org/two', tokenOwner: 'alice' }] }));
  assert.deepEqual(r, {
    projects: [
      { repo: 'alice/one', tokenOwner: 'alice' },
      { repo: 'org/two', tokenOwner: 'alice' },
    ],
    maxParallel: 3,
  });
});

test('maxParallel is an integer from 1 to 3, the number of slots', () => {
  assert.equal(parseProjects(text({ projects: [{ repo: 'a/b' }], maxParallel: 2 })).maxParallel, 2);
  for (const bad of [0, 4, 11, 2.5, '3']) {
    assert.throws(() => parseProjects(text({ projects: [{ repo: 'a/b' }], maxParallel: bad })), /maxParallel/);
  }
});

test('a target lists its repository, token owner, allowed submodule repositories and branch prefixes', () => {
  const r = parseProjects(text({ projects: [{
    repo: 'alice/one',
    target: { repo: 'org/code', allow: ['org/sub-a', 'org/sub-b'], branchPrefixes: ['tj/'] },
  }] }));
  assert.deepEqual(r.projects[0].target, { repo: 'org/code', tokenOwner: 'org', allow: ['org/sub-a', 'org/sub-b'], branchPrefixes: ['tj/'] });
  const plain = parseProjects(text({ projects: [{ repo: 'alice/one', target: { repo: 'org/code', tokenOwner: 'alice' } }] }));
  assert.deepEqual(plain.projects[0].target, { repo: 'org/code', tokenOwner: 'alice', allow: [], branchPrefixes: [] });
});

test('bad targets, unknown fields and the old targetTokenOwner are refused: a typo must not widen access', () => {
  const bad = [
    { repo: 'a/b', target: { repo: 'no-slash' } },
    { repo: 'a/b', target: { repo: 'o/c', allow: ['x'] } },
    { repo: 'a/b', target: { repo: 'o/c', allow: 'o/s' } },
    { repo: 'a/b', target: { repo: 'o/c', branchPrefixes: ['main'] } },
    { repo: 'a/b', target: { repo: 'o/c', surprise: true } },
    { repo: 'a/b', target: [] },
    { repo: 'a/b', targetTokenOwner: 'org' },
    { repo: 'a/b', extra: 1 },
  ];
  for (const p of bad) assert.throws(() => parseProjects(text({ projects: [p] })), /projects\[0\]/, JSON.stringify(p));
});

test('rejects an empty list, bad repo names, duplicates and bad owners', () => {
  assert.throws(() => parseProjects(text({ projects: [] })), /non-empty/);
  assert.throws(() => parseProjects(text({ projects: [{ repo: 'no-slash' }] })), /projects\[0\]/);
  assert.throws(() => parseProjects(text({ projects: [{ repo: 'a/b' }, { repo: 'A/B' }] })), /projects\[1\].*duplicate/);
  assert.throws(() => parseProjects(text({ projects: [{ repo: 'a/b', tokenOwner: 'bad owner' }] })), /tokenOwner/);
});

test('error messages never contain a repository name or any input text (the log is public)', () => {
  const bad = [
    '{"projects":[{"repo":"zzsecret/name!"}]}',
    '{"projects":[{"repo":"zzsecret/dup"},{"repo":"zzsecret/dup"}]}',
    '{"projects":[{"repo":"zzsecret/x","tokenOwner":"zz bad"}]}',
    '{"projects":[{"repo":"a/b","target":{"repo":"zzsecret/code","allow":["zzsecret"]}}]}',
    '{"projects":[{"repo":"a/b","zzsecretfield":1}]}',
    'zzsecret-not-json',
    '[]',
  ];
  for (const input of bad) {
    assert.throws(() => parseProjects(input), (e) => !/zzsecret|zz bad/.test(e.message));
  }
});
