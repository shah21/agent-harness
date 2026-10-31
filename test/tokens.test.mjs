import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTokenMap, tokenKind, resolveToken, makeProbe } from '../harness/lib/tokens.mjs';

test('parseTokenMap reads owner: [tokens] and trims', () => {
  assert.deepEqual(parseTokenMap('{"alice":[" github_pat_a ","ghp_b"],"org":["ghp_c"]}'), {
    alice: ['github_pat_a', 'ghp_b'],
    org: ['ghp_c'],
  });
});

test('parseTokenMap rejects bad shapes without echoing owners or tokens', () => {
  const bad = ['{"zz secret":["ghp_zzsecret"]}', '{"alice":[]}', '{"alice":[""]}', '{"alice":"ghp_zzsecret"}', 'ghp_zzsecret', '[]', '{}'];
  for (const input of bad) {
    assert.throws(() => parseTokenMap(input), (e) => !/zzsecret|zz secret|alice/.test(e.message), input);
  }
});

test('tokenKind tells the two kinds apart by prefix', () => {
  assert.equal(tokenKind('github_pat_abc'), 'fine-grained');
  assert.equal(tokenKind('ghp_abc'), 'classic');
  assert.equal(tokenKind('abc'), 'unknown');
});

const probeFrom = (table) => async (token) => table[token] ?? { ok: false, status: 404 };
const reads = { ok: true, status: 200, permissions: { pull: true, push: false } };
const writes = { ok: true, status: 200, permissions: { pull: true, push: true } };

test('resolveToken takes the first token that can do what is needed', async () => {
  const tokens = ['github_pat_a', 'ghp_b'];
  const probe = probeFrom({ github_pat_a: reads, ghp_b: writes });
  assert.deepEqual(await resolveToken({ repo: 'a/b', tokens, needsWrite: true, probe }), { index: 1, kind: 'classic' });
  assert.deepEqual(await resolveToken({ repo: 'a/b', tokens, needsWrite: false, probe }), { index: 0, kind: 'fine-grained' });
});

test('resolveToken skips tokens that cannot see the repository and returns null when none can', async () => {
  assert.deepEqual(
    await resolveToken({ repo: 'a/b', tokens: ['github_pat_a', 'ghp_b'], needsWrite: true, probe: probeFrom({ ghp_b: writes }) }),
    { index: 1, kind: 'classic' },
  );
  assert.equal(await resolveToken({ repo: 'a/b', tokens: ['x'], needsWrite: false, probe: probeFrom({}) }), null);
});

test('makeProbe sends a bearer token to the repository endpoint and reads the permissions', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, auth: init.headers.authorization });
    return { ok: true, status: 200, json: async () => ({ permissions: { pull: true, push: true } }) };
  };
  const r = await makeProbe(fetchImpl)('tok', 'a/b');
  assert.deepEqual(r, { ok: true, status: 200, permissions: { pull: true, push: true } });
  assert.deepEqual(seen, [{ url: 'https://api.github.com/repos/a/b', auth: 'Bearer tok' }]);
  const none = await makeProbe(async () => ({ ok: false, status: 404, json: async () => ({}) }))('tok', 'a/b');
  assert.deepEqual(none, { ok: false, status: 404 });
});
