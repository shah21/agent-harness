import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProjects } from '../harness/lib/projects.mjs';

const text = (o) => JSON.stringify(o);

test('reads projects; the token owner defaults to the repo owner and the cap to 3', () => {
  const r = parseProjects(text({ projects: [{ repo: 'alice/one' }, { repo: 'org/two', tokenOwner: 'alice', targetTokenOwner: 'org' }] }));
  assert.deepEqual(r, {
    projects: [
      { repo: 'alice/one', tokenOwner: 'alice' },
      { repo: 'org/two', tokenOwner: 'alice', targetTokenOwner: 'org' },
    ],
    maxParallel: 3,
  });
});

test('maxParallel must be an integer from 1 to 10', () => {
  assert.equal(parseProjects(text({ projects: [{ repo: 'a/b' }], maxParallel: 5 })).maxParallel, 5);
  for (const bad of [0, 11, 2.5, '3']) {
    assert.throws(() => parseProjects(text({ projects: [{ repo: 'a/b' }], maxParallel: bad })), /maxParallel/);
  }
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
    'zzsecret-not-json',
    '[]',
  ];
  for (const input of bad) {
    assert.throws(() => parseProjects(input), (e) => !/zzsecret|zz bad/.test(e.message));
  }
});
