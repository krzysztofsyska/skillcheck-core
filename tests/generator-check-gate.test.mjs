import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// What this gate guarantees (and what it does not).
//
// Generated SQL (migrations, rollbacks, isolated DB files) must never be edited by hand next to its
// generator. For every script under scripts/ or tools/ that writes files, unless it is on the named
// exemption list below, this test checks:
//   1. BEHAVIOUR: run in a throw-away copy of the repository, the script is run in write mode to learn which
//      files it writes; it must reproduce the committed bytes; `--check` must then pass on the untouched
//      copy and FAIL when any single one of its output files is tampered with (so a missing, empty or
//      partial `--check` is caught, including a generator with several outputs).
//   2. WIRING: some workflow step (a non-comment line) runs `node <script> --check`, and the workflow that
//      runs it triggers on both pull_request and push for a change to the script (an absent `paths` filter
//      counts as "always"; the `on.<trigger>.paths` lists are parsed, not text-matched).
//   3. Generators whose output lands in supabase/ must be run by sc19-migrations.yml (the Migrations job),
//      before the step that downloads PostgreSQL clients from the network.
//
// Limits, stated plainly: only scripts/ and tools/ are scanned; a writer is recognised by the Node file-write
// APIs listed in WRITE_API (a generator that writes through a child process or shell redirection is not
// seen); the tamper test appends to an output (or inserts inside the marked block of a PARTIAL generator), it does not prove every byte is compared; a generator that
// needs arguments to run is not supported and must be exempted with a reason.
const root = fileURLToPath(new URL('..', import.meta.url));
const WRITE_API = /\b(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|copyFileSync|copyFile|cpSync|renameSync)\s*\(/;
const SOURCE_EXT = /\.(mjs|cjs|js|ts|mts|cts)$/;
const MIGRATIONS_WORKFLOW = 'sc19-migrations.yml';
const NETWORK_STEP = 'Matching native dump and restore clients';

// Writers that are not committed-artifact generators. Each entry is a prefix of a repo-relative path.
const EXEMPT = [
  ['scripts/create-test-cv-fixtures.mjs', 'writes synthetic PDF/DOCX files into a caller-supplied directory; nothing committed'],
  ['scripts/create-bulk-cv-fixtures.mjs', 'writes a synthetic ZIP to a caller-supplied path; nothing committed'],
  ['scripts/preview-smoke.cjs', 'writes a throw-away PDF into a temp directory for a smoke run'],
  ['scripts/preview-freeze-guard.mjs', 'appends allow=... to the GitHub step output file'],
  ['tools/agent-pipeline/', 'CI runtime packets, journals and step outputs in working directories; nothing committed'],
  ['tools/release/promotion-manifest.mjs', 'records origin/main..origin/integration history to paths given on the command line; depends on remote refs, so it has no byte-for-byte --check (covered by tests/release-promotion-manifest.test.mjs)'],
  ['tools/db-migrate/inspect.mjs', 'writes a read-only inspection report (inspection.json) from a live database; nothing committed'],
];
// Generators whose output depends on the Node runtime itself. Behaviour is checked only when the runtime matches;
// wiring is always checked.
const RUNTIME_PINNED = { 'scripts/sc014-b2-unicode.mjs': { unicode: '17.0', why: 'output follows the Unicode tables of the Node runtime; CI runs its --check under the pinned Node in sc014-b2.yml' } };

// Generators that rewrite only a marked block of a hand-maintained file: tampering is applied inside the block,
// because by design edits outside it are not the generator's business.
const PARTIAL = { 'scripts/sc014-b2-unicode.mjs': { marker: '-- BEGIN GENERATED UNICODE', why: 'rewrites only the generated Unicode block of db/isolated/sc014-b2-validation.sql' } };

const read = path => readFileSync(join(root, path), 'utf8');
function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.next') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, visit); else visit(path);
  }
}
const writers = [];
for (const top of ['scripts', 'tools']) walk(join(root, top), path => {
  const rel = relative(root, path).split('\\').join('/');
  if (SOURCE_EXT.test(rel) && WRITE_API.test(readFileSync(path, 'utf8'))) writers.push(rel);
});
writers.sort();
const exemption = rel => EXEMPT.find(([prefix]) => rel === prefix || (prefix.endsWith('/') && rel.startsWith(prefix)));
const generators = writers.filter(rel => !exemption(rel));

// ---- workflow parsing (no YAML dependency in this repository) -----------------------------------------------
const unquote = value => value.trim().replace(/^(['"])(.*)\1$/, '$2');
export function parseTriggers(text) {
  const lines = text.split('\n');
  const start = lines.findIndex(line => /^on:\s*$/.test(line));
  const triggers = {};
  if (start < 0) return triggers;
  let current = null, inPaths = false;
  for (const raw of lines.slice(start + 1)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) break;
    if (indent === 2) {
      const match = /^([\w-]+):/.exec(trimmed);
      current = match ? match[1] : null;
      if (current) triggers[current] = { paths: null };
      inPaths = false;
    } else if (current && indent === 4) {
      const match = /^paths:\s*(.*)$/.exec(trimmed);
      inPaths = Boolean(match);
      if (match) {
        triggers[current].paths = [];
        const inline = match[1].replace(/\s#.*$/, '').trim();
        if (inline.startsWith('[')) {
          triggers[current].paths.push(...inline.slice(1, inline.lastIndexOf(']')).split(',').map(unquote).filter(Boolean));
          inPaths = false;
        }
      }
    } else if (current && inPaths && indent > 4 && trimmed.startsWith('-')) {
      triggers[current].paths.push(unquote(trimmed.slice(1).replace(/\s#.*$/, '')));
    }
  }
  return triggers;
}
const globToRegExp = glob => new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$');
export const triggerCovers = (triggers, trigger, file) => Boolean(triggers[trigger]) && (triggers[trigger].paths === null || triggers[trigger].paths.some(glob => globToRegExp(glob).test(file)));
export const checkLines = (text, script) => text.split('\n').map((line, index) => ({ line, index }))
  .filter(({ line }) => !line.trim().startsWith('#') && new RegExp(`node ${script.replace(/[.]/g, '\\.')}\\s+--check\\b`).test(line));

const workflowFiles = readdirSync(join(root, '.github/workflows')).filter(name => /\.ya?ml$/.test(name));
const workflows = Object.fromEntries(workflowFiles.map(name => [name, read(`.github/workflows/${name}`)]));
export const wiredIn = (script, files) => Object.entries(files).filter(([, text]) => checkLines(text, script).length > 0 && ['pull_request', 'push'].every(trigger => triggerCovers(parseTriggers(text), trigger, script))).map(([name]) => name);

// ---- behavioural check in a throw-away copy ------------------------------------------------------------------
const OLD = new Date('2000-01-01T00:00:00Z');
function touchAllOld(dir) { walk(dir, path => utimesSync(path, OLD, OLD)); }
function newerThanOld(dir) {
  const changed = [];
  walk(dir, path => { if (statSync(path).mtimeMs > OLD.getTime() + 60000) changed.push(relative(dir, path).split('\\').join('/')); });
  return changed.sort();
}
const run = (cwd, script, ...args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

const copyFilter = src => !/(^|[\\/])(node_modules|\.git|\.next)([\\/]|$)/.test(relative(root, src));
let lab;
// One throw-away copy of the repository, shared by the behavioural tests; each generator is run once in write
// mode and the files it touched are recorded as its outputs.
function getLab() {
  if (lab) return lab;
  const tmp = mkdtempSync(join(tmpdir(), 'generator-gate-'));
  lab = { tmp, outputs: {}, skipped: [] };
  cpSync(root, tmp, { recursive: true, filter: copyFilter });
  for (const script of generators) {
    const pinned = RUNTIME_PINNED[script];
    if (pinned && pinned.unicode !== process.versions.unicode) { lab.skipped.push(`${script}: Node Unicode ${process.versions.unicode}, needs ${pinned.unicode}`); continue; }
    touchAllOld(tmp);
    const result = run(tmp, script);
    lab.outputs[script] = { status: result.status, stderr: result.stderr, files: newerThanOld(tmp) };
  }
  return lab;
}
after(() => { if (lab) rmSync(lab.tmp, { recursive: true, force: true }); });

test('writers under scripts/ and tools/ are discovered, including promise-API writers', () => {
  assert.ok(generators.includes('scripts/sc014-b2-unicode.mjs'), 'node:fs/promises writeFile generator must be seen');
  for (const name of ['scripts/sc-wer-c1-compose.mjs', 'scripts/sc-c6-revision-compose.mjs', 'scripts/sc-c6-grant-guard-compose.mjs',
    'scripts/sc-c6-compose.mjs', 'scripts/sc-ac-compose.mjs', 'scripts/sc19-commerce-inventory-compose.mjs', 'scripts/sc014-b2-compose.mjs']) {
    assert.ok(generators.includes(name), `${name} must be a discovered generator`);
  }
  assert.ok(generators.length >= 8, generators.join(', '));
});

test('every exemption still matches a writer (no stale exemptions)', () => {
  for (const [prefix] of EXEMPT) assert.ok(writers.some(rel => rel === prefix || (prefix.endsWith('/') && rel.startsWith(prefix))), `stale exemption: ${prefix}`);
  for (const script of Object.keys(PARTIAL)) assert.ok(generators.includes(script), `stale partial entry: ${script}`);
  for (const [script, { why }] of Object.entries(RUNTIME_PINNED)) { assert.ok(generators.includes(script), `stale runtime pin: ${script}`); assert.ok(why); }
});

test('every generator is run with --check by a workflow that triggers on pull_request and push for it', () => {
  for (const script of generators) {
    assert.ok(wiredIn(script, workflows).length > 0,
      `no workflow step (outside comments) runs "node ${script} --check" in a workflow whose pull_request and push triggers cover ${script}`);
  }
});

test('generators writing supabase/ run in the Migrations workflow before the network step', () => {
  const lines = workflows[MIGRATIONS_WORKFLOW].split('\n');
  const networkLine = lines.findIndex(line => line.includes(`name: ${NETWORK_STEP}`));
  assert.ok(networkLine >= 0, `step "${NETWORK_STEP}" not found`);
  const { outputs } = getLab();
  const supabaseGenerators = Object.keys(outputs).filter(script => outputs[script].files.some(file => file.startsWith('supabase/')));
  assert.ok(supabaseGenerators.length >= 6, `expected the six supabase generators, got ${supabaseGenerators.join(', ')}`);
  for (const script of supabaseGenerators) {
    const hits = checkLines(workflows[MIGRATIONS_WORKFLOW], script);
    assert.ok(hits.length > 0, `${MIGRATIONS_WORKFLOW} does not run: node ${script} --check`);
    assert.equal(wiredIn(script, { [MIGRATIONS_WORKFLOW]: workflows[MIGRATIONS_WORKFLOW] }).length, 1,
      `${MIGRATIONS_WORKFLOW} pull_request and push path filters must both cover ${script}`);
    assert.ok(hits.every(({ index }) => index < networkLine), `${script} --check must run before "${NETWORK_STEP}" (offline checks must not depend on the network)`);
  }
});

test('--check reproduces the committed output and detects tampering with any single output file', t => {
  const { tmp, outputs, skipped } = getLab();
  for (const line of skipped) t.diagnostic(`skipped behaviour of ${line}`);
  for (const [script, { status, stderr, files }] of Object.entries(outputs)) {
    assert.equal(status, 0, `${script} failed in write mode: ${stderr}`);
    assert.ok(files.length > 0, `${script} wrote no file in write mode; if it needs arguments or writes elsewhere it must be exempted with a reason`);
    for (const file of files) assert.equal(readFileSync(join(tmp, file), 'utf8'), read(file), `${script} write mode does not reproduce committed ${file}`);
    const clean = run(tmp, script, '--check');
    assert.equal(clean.status, 0, `${script} --check fails on untouched output: ${clean.stderr}`);
    for (const file of files) {
      const original = readFileSync(join(tmp, file));
      const partial = PARTIAL[script];
      let tamperedText;
      if (partial) {
        const text = original.toString('utf8'), at = text.indexOf(partial.marker);
        assert.ok(at >= 0, `${script}: marker ${partial.marker} not found in ${file}`);
        const lineEnd = text.indexOf('\n', at) + 1;
        tamperedText = text.slice(0, lineEnd) + '-- tampered\n' + text.slice(lineEnd);
      } else tamperedText = original.toString('utf8') + '\n-- tampered\n';
      writeFileSync(join(tmp, file), tamperedText);
      const tampered = run(tmp, script, '--check');
      writeFileSync(join(tmp, file), original);
      assert.notEqual(tampered.status, 0, `${script} --check did not detect a tampered ${file}`);
    }
  }
});

test('the gate rules reject unwired, commented-out and one-sided workflows', () => {
  const wf = (onBlock, runLine) => `name: x\non:\n${onBlock}\njobs:\n  j:\n    steps:\n      ${runLine}\n`;
  const both = "  pull_request:\n    paths:\n      - 'scripts/a.mjs'\n  push:\n    paths:\n      - 'scripts/a.mjs'";
  const prOnly = "  pull_request:\n    paths:\n      - 'scripts/a.mjs'\n  push:\n    paths:\n      - 'scripts/other.mjs'";
  const dup = "  pull_request:\n    paths:\n      - 'scripts/a.mjs'\n      - 'scripts/a.mjs'\n  push:\n    branches: [integration]\n    paths:\n      - 'scripts/other.mjs'";
  const always = '  push:\n  pull_request:';
  const inline = "  pull_request:\n    paths: ['scripts/a-*.mjs']\n  push:\n    paths: ['scripts/a-*.mjs']";
  assert.deepEqual(wiredIn('scripts/a.mjs', { w: wf(both, '- run: node scripts/a.mjs --check') }), ['w']);
  assert.deepEqual(wiredIn('scripts/a.mjs', { w: wf(both, '# - run: node scripts/a.mjs --check') }), [], 'a YAML comment is not a step');
  assert.deepEqual(wiredIn('scripts/a.mjs', { w: wf(prOnly, '- run: node scripts/a.mjs --check') }), [], 'push filter must cover it too');
  assert.deepEqual(wiredIn('scripts/a.mjs', { w: wf(dup, '- run: node scripts/a.mjs --check') }), [], 'two entries under one trigger are not two triggers');
  assert.deepEqual(wiredIn('scripts/a.mjs', { w: wf(both, '- run: node scripts/b.mjs --check') }), [], 'a different generator does not count');
  assert.deepEqual(wiredIn('scripts/a.mjs', { w: wf(always, '- run: node scripts/a.mjs --check') }), ['w'], 'no paths filter means always');
  assert.deepEqual(wiredIn('scripts/a-b.mjs', { w: wf(inline, '- run: node scripts/a-b.mjs --check && echo ok') }), ['w'], 'inline lists and globs');
  assert.deepEqual(wiredIn('scripts/a.mjs', { w: wf('  workflow_dispatch:', '- run: node scripts/a.mjs --check') }), [], 'neither trigger present');
});
