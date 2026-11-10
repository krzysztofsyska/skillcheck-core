import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Generated SQL (migrations, rollbacks) must never be edited by hand next to its generator:
// every script in scripts/ that writes files has a byte-for-byte `--check` mode, CI runs it,
// and the Migrations workflow reruns when the generator changes. Adding a generator without
// wiring it fails here, instead of letting a hand edit of the output ship to production.
const root = fileURLToPath(new URL('..', import.meta.url));
const read = path => readFileSync(`${root}${path}`, 'utf8');
const workflows = readdirSync(`${root}.github/workflows`).filter(f => /\.ya?ml$/.test(f));
const workflowText = Object.fromEntries(workflows.map(f => [f, read(`.github/workflows/${f}`)]));
const generators = readdirSync(`${root}scripts`).filter(f => f.endsWith('.mjs') && /\bwriteFileSync\s*\(/.test(read(`scripts/${f}`))).sort();

// Pure rules, so they can be exercised against a synthetic seventh generator below.
const hasCheckMode = source => /process\.argv\.includes\(\s*['"]--check['"]\s*\)/.test(source);
const runsCheck = (name, workflowFiles) => Object.values(workflowFiles).some(text => text.includes(`node scripts/${name} --check`));
const triggersOnChange = (name, text) => text.split(`'scripts/${name}'`).length - 1 >= 2; // pull_request and push lists

test('generators are discovered', () => {
  assert.ok(generators.length >= 7, `expected the known generators, found ${generators.join(', ')}`);
});

test('every generator has a --check mode', () => {
  for (const name of generators) assert.ok(hasCheckMode(read(`scripts/${name}`)), `scripts/${name} writes files but has no --check mode`);
});

test('every generator is run with --check by a workflow', () => {
  for (const name of generators) assert.ok(runsCheck(name, workflowText), `no workflow runs: node scripts/${name} --check`);
});

test('generators that write supabase/ run in Migrations and re-trigger it when changed', () => {
  const migrations = workflowText['sc19-migrations.yml'];
  const supabaseGenerators = generators.filter(name => read(`scripts/${name}`).includes('supabase/'));
  assert.ok(supabaseGenerators.length >= 6, `expected the six supabase generators, found ${supabaseGenerators.join(', ')}`);
  for (const name of supabaseGenerators) {
    assert.ok(runsCheck(name, { 'sc19-migrations.yml': migrations }), `sc19-migrations.yml does not run: node scripts/${name} --check`);
    assert.ok(triggersOnChange(name, migrations), `sc19-migrations.yml pull_request and push path filters must both list scripts/${name}`);
  }
});

test('every generator reproduces its committed output right now', () => {
  // Never execute a script without --check mode: it would overwrite its output instead of comparing.
  for (const name of generators.filter(name => hasCheckMode(read(`scripts/${name}`)))) {
    assert.doesNotThrow(() => execFileSync(process.execPath, [`scripts/${name}`, '--check'], { cwd: root, stdio: 'pipe' }), `scripts/${name} --check`);
  }
});

test('the gate itself rejects an unwired seventh generator', () => {
  assert.equal(hasCheckMode("writeFileSync(path, sql);"), false);
  assert.equal(hasCheckMode("if(process.argv.includes('--check')){}"), true);
  assert.equal(runsCheck('sc-new-compose.mjs', workflowText), false);
  assert.equal(runsCheck('sc-c6-revision-compose.mjs', workflowText), true);
  assert.equal(triggersOnChange('sc-new-compose.mjs', workflowText['sc19-migrations.yml']), false);
});
