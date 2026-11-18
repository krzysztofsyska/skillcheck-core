import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
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
// Limits, stated plainly:
//   - only scripts/ and tools/ are scanned; a writer is recognised by the Node file-write APIs listed in WRITE_API
//     (a generator that writes through a child process or shell redirection is not seen);
//   - the tamper tests append a line to an output (or insert inside the marked block of a PARTIAL generator) and
//     change one byte in the middle without changing the length; a `--check` that compares everything except
//     some other region is still not proven byte-exact;
//   - a generator that needs arguments to run is not supported and must be exempted with a reason;
//   - an output written only when absent is learned from a second run in a copy without the files under supabase/ and db/; a
//     generator that needs those directories as input fails that run and its conditional outputs stay unseen, and
//     a conditional output outside supabase/ and db/ is not recreated in that copy at all;
//   - wiring declared through `npm run ...` instead of a literal `node scripts/<name> --check` step is NOT
//     recognised: that is a false alarm (the safe direction, it only costs noise);
//   - an `on:` shape the small reader does not recognise (for example `on: [push, pull_request]`) yields a false
//     alarm "not covered", never a silent pass; `paths-ignore` and `!` negations are understood;
//   - behaviour of a runtime-pinned generator is skipped (reported as a skipped test) when this Node's Unicode
//     tables differ; the gate then relies on the workflow that pins an exact Node version, which is asserted.
const root = fileURLToPath(new URL('..', import.meta.url));
const WRITE_API = /\b(writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|copyFileSync|copyFile|cpSync|renameSync)\s*\(/;
const SOURCE_EXT = /\.(mjs|cjs|js|ts|mts|cts)$/;
const MIGRATIONS_WORKFLOW = 'sc19-migrations.yml';
const NETWORK_STEP = 'Matching native dump and restore clients';

// Writers that are not committed-artifact generators. Each entry is a repo-relative path (an entry ending in '/'
// would be a prefix, but none is used: see the note below).
const EXEMPT = [
  ['scripts/create-test-cv-fixtures.mjs', 'writes synthetic PDF/DOCX files into a caller-supplied directory; nothing committed'],
  ['scripts/create-bulk-cv-fixtures.mjs', 'writes a synthetic ZIP to a caller-supplied path; nothing committed'],
  ['scripts/preview-smoke.cjs', 'writes a throw-away PDF into a temp directory for a smoke run'],
  ['scripts/preview-freeze-guard.mjs', 'appends allow=... to the GitHub step output file'],
  // Listed file by file, not as a directory prefix: a new writer dropped into tools/agent-pipeline/ (or the two
  // tools/release/ directories below) must be reviewed and named here instead of being invisible to the gate.
  ['tools/release/promotion-manifest.mjs', 'records origin/main..origin/integration history to paths given on the command line; depends on remote refs, so it has no byte-for-byte --check (covered by tests/release-promotion-manifest.test.mjs)'],
  ['tools/release/auto/run.mjs', 'automatic publisher (#369): appends its decision to the GitHub step summary; nothing committed'],
  ['tools/release/auto/migrate.mjs', 'automatic migrate job (#491): appends its outcome to the GitHub step output and summary; nothing committed'],
  ['tools/release/backup-drill/drill.mjs', 'nightly restore drill (#369): writes a report next to a throw-away dump in the runner; nothing committed'],
  ['tools/db-migrate/inspect.mjs', 'writes a read-only inspection report (inspection.json) from a live database; nothing committed'],
];
// Generators whose output depends on the Node runtime itself. Behaviour is checked only when the runtime matches;
// wiring is always checked.
const RUNTIME_PINNED = { 'scripts/sc014-b2-unicode.mjs': { unicode: '17.0', why: 'output follows the Unicode tables of the Node runtime; CI runs its --check under the pinned Node in sc014-b2.yml' } };

// Generators that rewrite only a marked block of a hand-maintained file: tampering is applied inside the block,
// because by design edits outside it are not the generator's business.
// `endMarker` closes the generated block; without it the block runs to the end of the file.
const PARTIAL = {
  'scripts/sc014-b2-unicode.mjs': { marker: '-- BEGIN GENERATED UNICODE', endMarker: '-- END GENERATED UNICODE', why: 'rewrites only the generated Unicode block of db/isolated/sc014-b2-validation.sql' },
  'scripts/sc19-commerce-inventory-compose.mjs': { marker: '-- Generated R15 readers and immutable baseline.', why: 'keeps the hand-written domain part of the migration before the marker and regenerates only what follows it' },
};

// True when every `node-version:` in the workflow is an exact x.y.z (and there is at least one).
export const exactNodePin = text => {
  const versions = text.split('\n').filter(line => !line.trim().startsWith('#')).map(line => /\bnode-version:\s*(.+?)\s*(#.*)?$/.exec(line)).filter(Boolean).map(match => unquote(match[1]));
  return versions.length > 0 && versions.every(version => /^\d+\.\d+\.\d+$/.test(version));
};
const runtimeMismatch = script => {
  const pinned = RUNTIME_PINNED[script];
  return pinned && pinned.unicode !== process.versions.unicode ? `Node Unicode ${process.versions.unicode}, needs ${pinned.unicode}` : null;
};
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
  let current = null, listKey = null;
  for (const raw of lines.slice(start + 1)) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) break;
    if (indent === 2) {
      const match = /^([\w-]+):/.exec(trimmed);
      current = match ? match[1] : null;
      if (current) triggers[current] = { paths: null, ignore: null };
      listKey = null;
    } else if (current && indent === 4) {
      // `paths-ignore` is recognised on purpose: reading it as "no filter" would report a workflow that EXCLUDES a
      // generator as covering it (the unsafe direction).
      const match = /^(paths|paths-ignore):\s*(.*)$/.exec(trimmed);
      listKey = match ? (match[1] === 'paths' ? 'paths' : 'ignore') : null;
      if (match) {
        triggers[current][listKey] = [];
        const inline = match[2].replace(/\s#.*$/, '').trim();
        if (inline.startsWith('[')) {
          triggers[current][listKey].push(...inline.slice(1, inline.lastIndexOf(']')).split(',').map(unquote).filter(Boolean));
          listKey = null;
        }
      }
    } else if (current && listKey && indent > 4 && trimmed.startsWith('-')) {
      triggers[current][listKey].push(unquote(trimmed.slice(1).replace(/\s#.*$/, '')));
    }
  }
  return triggers;
}
const globToRegExp = glob => new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$');
const globMatches = (glob, file) => globToRegExp(glob.replace(/^!/, '')).test(file);
// A file is covered when the trigger exists, `paths` (if any) matches it with no later-style `!` negation, and
// `paths-ignore` (if any) does not match it.
export const triggerCovers = (triggers, trigger, file) => {
  const t = triggers[trigger];
  if (!t) return false;
  if (t.paths !== null && !(t.paths.some(glob => !glob.startsWith('!') && globMatches(glob, file)) && !t.paths.some(glob => glob.startsWith('!') && globMatches(glob, file)))) return false;
  return !(t.ignore && t.ignore.some(glob => globMatches(glob, file)));
};
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
const tmpBase = dir => dir.split(/[\\/]/).pop();
const run = (cwd, script, ...args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });

// .env* files (a local .env.local may hold real secrets) never enter the throw-away copy.
const copyFilter = src => !/(^|[\\/])(node_modules|\.git|\.next|\.env[^\\/]*)([\\/]|$)/.test(relative(root, src));
// The same copy without the FILES under supabase/ and db/ (the directories stay, so a generator can write there): used to learn outputs a generator writes only when the file is absent.
const bareFilter = src => copyFilter(src) && (!/^(supabase|db)[\\/]/.test(relative(root, src)) || statSync(src).isDirectory());
let lab;
// One throw-away copy of the repository, shared by the behavioural tests; each generator is run once in write
// mode and the files it touched are recorded as its outputs.
function getLab() {
  if (lab) return lab;
  const tmp = mkdtempSync(join(tmpdir(), 'generator-gate-'));
  lab = { tmp, outputs: {} };
  cpSync(root, tmp, { recursive: true, filter: copyFilter });
  const bare = join(tmp, '..', `${tmpBase(tmp)}-bare`);
  lab.bare = bare;
  cpSync(root, bare, { recursive: true, filter: bareFilter });
  for (const script of generators) {
    if (runtimeMismatch(script)) continue;
    touchAllOld(tmp);
    const result = run(tmp, script);
    const files = newerThanOld(tmp);
    // Second run in a copy WITHOUT the files under supabase/ and db/: a file the generator writes only when it is absent
    // (`if (!existsSync(out))`) is not rewritten in the full copy, so it would never be recognised as an output
    // and its drift would never be checked. Here it is written; a committed file of that name is added to the
    // set. A generator that needs those directories as input fails this run and contributes nothing (see Limits).
    touchAllOld(bare);
    const bareRun = run(bare, script);
    const conditional = bareRun.status === 0 ? newerThanOld(bare).filter(file => !files.includes(file) && existsSync(join(tmp, file))) : [];
    lab.outputs[script] = { status: result.status, stderr: result.stderr, files, conditional };
  }
  return lab;
}
after(() => { if (lab) { rmSync(lab.tmp, { recursive: true, force: true }); rmSync(lab.bare, { recursive: true, force: true }); } });

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

// Replaces one ASCII letter or digit in the middle of the region [from, to) with a different one: same length,
// same everything else, so a `--check` that only compares sizes (or only looks at the end) passes it.
function sameLengthMutation(buffer, from = 0, to = buffer.length) {
  const out = Buffer.from(buffer);
  const isAlnum = byte => (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122);
  let at = from + Math.floor((to - from) / 2);
  while (at < to && !isAlnum(out[at])) at += 1;
  assert.ok(at < to, 'no ASCII letter or digit to mutate in the middle of the output');
  out[at] = out[at] === 0x78 ? 0x79 : 0x78; // x <-> y
  assert.equal(out.length, buffer.length);
  assert.notDeepEqual(out, buffer);
  return out;
}

function verifyGenerator({ tmp, outputs }, script) {
  const { status, stderr, files, conditional } = outputs[script];
  assert.equal(status, 0, `${script} failed in write mode: ${stderr}`);
  assert.ok(files.length > 0, `${script} wrote no file in write mode; if it needs arguments or writes elsewhere it must be exempted with a reason`);
  for (const file of files) assert.equal(readFileSync(join(tmp, file), 'utf8'), read(file), `${script} write mode does not reproduce committed ${file}`);
  const clean = run(tmp, script, '--check');
  assert.equal(clean.status, 0, `${script} --check fails on untouched output: ${clean.stderr}`);
  for (const file of [...files, ...conditional]) {
    const original = readFileSync(join(tmp, file));
    const partial = PARTIAL[script];
    const text = original.toString('utf8');
    let region = [0, original.length], appended;
    if (partial) {
      const at = text.indexOf(partial.marker);
      assert.ok(at >= 0, `${script}: marker ${partial.marker} not found in ${file}`);
      const lineEnd = text.indexOf('\n', at) + 1;
      appended = text.slice(0, lineEnd) + '-- tampered\n' + text.slice(lineEnd);
      const end = partial.endMarker ? text.indexOf(partial.endMarker, lineEnd) : text.length;
      assert.ok(end > lineEnd, `${script}: end marker not found in ${file}`);
      region = [Buffer.byteLength(text.slice(0, lineEnd)), Buffer.byteLength(text.slice(0, end))];
    } else appended = text + '\n-- tampered\n';
    const mutations = {
      'an appended line': Buffer.from(appended),
      'a same-length change in the middle': sameLengthMutation(original, ...region),
    };
    for (const [what, tamperedBytes] of Object.entries(mutations)) {
      writeFileSync(join(tmp, file), tamperedBytes);
      const tampered = run(tmp, script, '--check');
      writeFileSync(join(tmp, file), original);
      assert.notEqual(tampered.status, 0, `${script} --check did not detect ${what} in ${file}`);
    }
  }
}

test('--check reproduces the committed output and detects tampering with any single output file', () => {
  const labState = getLab();
  for (const script of Object.keys(labState.outputs)) if (!(script in RUNTIME_PINNED)) verifyGenerator(labState, script);
});

// A real skip (the counter shows `# skipped 1`), not a diagnostic line on a passing test.
for (const script of Object.keys(RUNTIME_PINNED)) {
  test(`behaviour of runtime-pinned generator ${script}`, { skip: runtimeMismatch(script) ? `${runtimeMismatch(script)}; its --check runs under the exact Node pinned in a workflow (asserted separately)` : false }, () => {
    verifyGenerator(getLab(), script);
  });
}

// The skip above is only acceptable because a workflow runs the generator's --check under an EXACT Node version.
// checks.yml pins `node-version: 24` loosely, so it does not count.
test('every runtime-pinned generator runs --check in a workflow that pins an exact Node version', () => {
  for (const script of Object.keys(RUNTIME_PINNED)) {
    const exact = wiredIn(script, workflows).filter(name => exactNodePin(workflows[name]));
    assert.ok(exact.length > 0, `${script}: no workflow that runs its --check (and triggers on pull_request and push) pins an exact node-version such as '24.19.0'`);
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
  const ignoring = "  pull_request:\n    paths-ignore:\n      - 'scripts/a.mjs'\n  push:";
  const ignoringOther = "  pull_request:\n    paths-ignore: ['docs/**']\n  push:\n    paths-ignore:\n      - 'docs/**'";
  const negated = "  pull_request:\n    paths:\n      - 'scripts/**'\n      - '!scripts/a.mjs'\n  push:";
  assert.deepEqual(wiredIn('scripts/a.mjs', { w: wf(ignoring, '- run: node scripts/a.mjs --check') }), [], 'paths-ignore excluding the generator is not coverage');
  assert.deepEqual(wiredIn('scripts/a.mjs', { w: wf(ignoringOther, '- run: node scripts/a.mjs --check') }), ['w'], 'paths-ignore of other paths still covers it');
  assert.deepEqual(wiredIn('scripts/a.mjs', { w: wf(negated, '- run: node scripts/a.mjs --check') }), [], 'a ! negation in paths excludes it');
  assert.deepEqual(wiredIn('scripts/a.mjs', { w: wf('  [push, pull_request]', '- run: node scripts/a.mjs --check') }), [], 'an unrecognised on: shape is a false alarm, never a pass');
  assert.equal(exactNodePin("      - uses: actions/setup-node@v4\n        with:\n          node-version: '24.19.0'\n"), true);
  assert.equal(exactNodePin('        with:\n          node-version: 24\n'), false, 'a loose major is not exact');
  assert.equal(exactNodePin("          node-version: '24.19.0'\n          node-version: 24\n"), false, 'every pin in the workflow must be exact');
  assert.equal(exactNodePin('name: no node\n'), false);
});
