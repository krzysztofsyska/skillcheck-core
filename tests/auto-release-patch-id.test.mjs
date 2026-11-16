// SC-AUTO-RELEASE (#369): the patch ID that authorizes a release and a rollback must not ignore
// whitespace (Codex finding on #463, tools/release/auto/git.mjs). Real git, temporary repository.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGit } from '../tools/release/auto/git.mjs';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'patch-id-'));
  const g = createGit(dir);
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 't'); g('config', 'user.email', 't@t');
  const commit = (text, msg, file = 'f.js') => { writeFileSync(join(dir, file), text); g('add', '-A'); g('commit', '-qm', msg); return g('rev-parse', 'HEAD').trim(); };
  return { g, commit };
}

test('a whitespace-only edit inside a literal yields a different patch ID', () => {
  const { g, commit } = repo();
  const base = commit('say("Hello world");\n', 'base');
  const reviewed = commit('say("Hello world!");\n', 'reviewed');
  g('checkout', '-q', '-b', 'tampered', base);
  const tampered = commit('say("Helloworld!");\n', 'tampered');
  const a = g.patchId(g('diff', base, reviewed));
  const b = g.patchId(g('diff', base, tampered));
  assert.match(a, /^[0-9a-f]{40}$/);
  assert.match(b, /^[0-9a-f]{40}$/);
  assert.notEqual(a, b);
});

test('the same change at a different position keeps its patch ID', () => {
  const { g, commit } = repo();
  const body = Array.from({ length: 20 }, (_, i) => `line ${i};\n`).join('');
  const base = commit(body, 'base');
  const changed = commit(body.replace('line 10;', 'line 10 changed;'), 'change');
  const shiftedBase = commit('// header\n// more\n' + body, 'shift');
  const shiftedChange = commit('// header\n// more\n' + body.replace('line 10;', 'line 10 changed;'), 'change again');
  assert.equal(g.patchId(g('diff', base, changed)), g.patchId(g('diff', shiftedBase, shiftedChange)));
});

test('an empty diff has no patch ID', () => {
  const { g } = repo();
  assert.equal(g.patchId(''), null);
});
