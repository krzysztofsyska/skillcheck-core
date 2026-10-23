import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { parse } from 'pg-connection-string';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { parseExerciseDefinition } from '../lib/exercise-definition.ts';
import { parseCompetencyTestSubmission, evaluateCompetencyTest } from '../lib/competency-test.ts';
import { unicodeVersion, propertyRanges, renderUnicodeClassifier, flagsFor } from '../scripts/sc014-b2-unicode.mjs';

// CI proves JS/SQL parity on real PostgreSQL 16. PGlite is an explicit local
// semantic fallback only; concurrency uses the separate real PostgreSQL suite.
let db;
let cleanupDatabase;
const sqlPath = new URL('../db/isolated/sc014-b2-validation.sql', import.meta.url);
const definition = (count = 5) => ({ kind: 'competency_test', title: ' Analiza sprzedaży ', instructions: 'Zaproponuj usprawnienia.', expectedOutput: 'Plan i uzasadnienia.', durationMinutes: 20,
  criteria: Array.from({length: count}, (_, i) => ({competency: 'Kryterium ' + i, below: 'Nie wskazuje przyczyn.', meets: 'Wskazuje przyczyny.', above: 'Dodatkowo sprawdza hipotezy.'})) });
const review = (count = 5) => Array.from({length: count}, (_, criterionIndex) => ({criterionIndex, rating: 'insufficient_data', evidence: ''}));
const subdivisionFlag = region => String.fromCodePoint(0x1f3f4, ...Array.from(region, letter => 0xe0000 + letter.charCodeAt(0)), 0xe007f);
const queryValue = async (sql, values) => (await db.query(sql, values)).rows[0].value;
const sqlDefinition = input => queryValue('select private.competency_validate_definition($1::jsonb) value', [JSON.stringify(input)]);
const sqlAnswer = input => queryValue('select private.competency_answer($1::jsonb) value', [JSON.stringify(input)]);
const sqlScore = (rubric, workSample, observations) => queryValue('select private.competency_score($1::jsonb,$2,$3::jsonb) value', [JSON.stringify(rubric), workSample, JSON.stringify(observations)]);

before(async () => {
  if (process.env.COMPETENCY_TEST_ENGINE === 'pglite') {
    db = new PGlite({extensions: {pgcrypto}});
    cleanupDatabase = () => db.close();
  } else {
    const url = process.env.SCREENING_TEST_DATABASE_URL;
    assert.ok(url, 'SCREENING_TEST_DATABASE_URL required; explicit COMPETENCY_TEST_ENGINE=pglite is the local-only fallback');
    const parsed = parse(url);
    assert.ok(['127.0.0.1', 'localhost', '::1'].includes(parsed.host) || parsed.host?.startsWith('/tmp/'), 'Validation fixtures refuse external PostgreSQL hosts');
    const databaseName = 'sc014_validation_' + randomUUID().replaceAll('-', '');
    const config = database => ({...parsed, database, connectionTimeoutMillis: 5000});
    const admin = new Client(config('postgres'));
    await admin.connect();
    try { await admin.query('create database ' + databaseName); } finally { await admin.end(); }
    db = new Client(config(databaseName));
    cleanupDatabase = async () => {
      await db.end().catch(() => {});
      const cleanup = new Client(config('postgres')); await cleanup.connect();
      try { await cleanup.query('drop database if exists ' + databaseName); } finally { await cleanup.end(); }
    };
    await db.connect(); db.exec = sql => db.query(sql);
    const version = Number((await db.query('show server_version_num')).rows[0].server_version_num);
    assert.ok(version >= 160000 && version < 170000, 'The real parity gate targets PostgreSQL 16');
    await db.exec("set statement_timeout='30s'; set lock_timeout='2s';");
  }
  await db.exec(`create schema private; create extension pgcrypto;
    do $$begin
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
      if not exists(select 1 from pg_roles where rolname='competency_validation_hostile') then create role competency_validation_hostile; end if;
    end;$$;`);
  // Reuse the accepted schema functions without creating unrelated product tables.
  const behavior = await readFile(new URL('../supabase/migrations/20261002000100_behavior_assessments.sql', import.meta.url), 'utf8');
  const exercise = await readFile(new URL('../supabase/migrations/20261002000300_exercise_definitions.sql', import.meta.url), 'utf8');
  await db.exec(behavior.slice(behavior.indexOf('create function private.behavior_trim'), behavior.indexOf('create table')));
  await db.exec(exercise.slice(exercise.indexOf('create function private.exercise_key'), exercise.indexOf('create table')));
  await db.exec('alter default privileges in schema private grant execute on functions to anon,authenticated,competency_validation_hostile;');
  await db.exec(await readFile(sqlPath, 'utf8'));
});
after(async () => { if (cleanupDatabase) await cleanupDatabase(); });

// PostgreSQL rejects NUL/unpaired surrogates at JSON/UTF8 transport (22xxx),
// before the SQL helper can return its own PT422 validation error.
async function assertAnswerParity(input, label = JSON.stringify(input)?.slice(0, 80)) {
  let expected;
  try { expected = parseCompetencyTestSubmission(definition(), input).workSample; }
  catch {
    await assert.rejects(sqlAnswer(input), error => ['PT422', '22P05', '22021', '22P02'].includes(error.code), 'SQL must reject the same payload: ' + label);
    return;
  }
  assert.equal(await sqlAnswer(input), expected, label);
}
async function assertScoreParity(rubric, workSample, observations, label = '') {
  let expected;
  try { expected = evaluateCompetencyTest(rubric, {workSample}, observations); }
  catch {
    await assert.rejects(sqlScore(rubric, workSample, observations), error => ['PT422', '22023', '22P05', '22021', '22P02'].includes(error.code), 'SQL must reject the same score payload: ' + label);
    return;
  }
  assert.deepEqual(await sqlScore(rubric, workSample, observations), expected, label);
}

test('Unicode snapshot matches the complete current JS property space and SQL boundary classifier', async () => {
  assert.equal(process.versions.unicode, unicodeVersion, 'Node/Unicode upgrade requires reviewed SQL regeneration');
  const ranges = propertyRanges();
  assert.ok((await readFile(sqlPath, 'utf8')).includes(renderUnicodeClassifier(ranges)));
  const samples = [...new Set(ranges.flatMap(([start, end]) => [Math.max(start - 1, 0), start, end, Math.min(end + 1, 0x10ffff)]))];
  const rows = (await db.query('select p, private.competency_unicode_flags(p) flags from unnest($1::int[]) p', [samples])).rows;
  for (const {p, flags} of rows) assert.equal(flags, flagsFor(p), 'U+' + p.toString(16));
});

test('answer payload shape and untrusted metadata match SC-014-A', async () => {
  for (const input of [null, {}, [], false, 'text', {workSample: null}, {workSample: []}, {workSample: 5}, {workSample: ''}, {workSample: 'abc', score: 100, company_id: 'other', actor_id: 'other', now: '2099-01-01'}]) await assertAnswerParity(input);
});

test('accepted Unicode fixtures and contextual joiners match JS exactly', async () => {
  const fixtures = ['x', 'Założenia:\nPlan A.\r\n', 'a\tb', 'C++', 'Q&A', '5–7', 'A/B', 'e\u0301',
    'Opis 👩🏽‍💻 działania', 'Plan ❤️‍🔥 analizy', 'Ko\u00admunikacja', 'می‌روم به خانه', 'رفتار می‌رود', 'क्‍ष परीक्षण',
    String.fromCodePoint(0x0d26,0x0d43,0x0d15,0x0d4d,0x200c,0x0d38,0x0d3e,0x0d15,0x0d4d,0x0d37,0x0d3f),
    String.fromCodePoint(0x0915,0x093c,0x094d,0x200c,0x0937) + ' उदाहरण',
    String.fromCodePoint(0x0dc1,0x0dca,0x200d,0x0dbb,0x0dd3,0x0020,0x0dbd,0x0d82,0x0d9a,0x0dcf),
    String.fromCodePoint(0x0915,0x094d,0x200d) + ' रूप', String.fromCodePoint(0x8fbb,0xe0100) + 'は地名です',
    ...['1\uFE0F\u20E3','2\uFE0F\u20E3','3\u20E3','#\uFE0F\u20E3','*\uFE0F\u20E3'].map(x => 'Priorytet ' + x),
    ...['gbeng', 'gbsct', 'gbwls'].map(region => 'Plan dla regionu ' + subdivisionFlag(region)),
  ];
  for (const workSample of fixtures) {
    assert.doesNotThrow(() => parseCompetencyTestSubmission(definition(), {workSample}));
    await assertAnswerParity({workSample});
    const observations = review(); observations[0] = {criterionIndex: 0, rating: 'meets', evidence: workSample};
    await assertScoreParity(definition(), workSample, observations, workSample);
  }
});

test('invisible/control/symbol-only payloads and invalid Unicode contexts stay rejected', async () => {
  const flag = subdivisionFlag('gbeng');
  const fixtures = ['\u0000', 'abc\u0000', '\u200b', '\u202eabc', 'abc\u200d', 'a\uD800', '\uDC00abc', '\t\r\n', '\u2800', '---', '+++', '!!!', '$%&',
    'Plan\u00ad', '\u00adPlan', 'abc‌def', 'abc‍def', 'می‌ hello', 'سلام‌ABC', 'क‍ष',
    String.fromCodePoint(0x0d15,0x200c,0x0d38), String.fromCodePoint(0x0d15,0x0d4d,0x200c,0x0937),
    String.fromCodePoint(0x0d15,0x0d4d,0x200c), String.fromCodePoint(0x0dc1,0x0dca,0x200d,0x0dd3),
    String.fromCodePoint(0x0915,0x094d,0x200d,0x093e), '地名\uFE00', 'abc' + String.fromCodePoint(0xe0100),
    'Plan 1\uFE0F bez keycap', 'Kryterium #\uFE0F bez keycap',
    ...[0x3164, 0xffa0, 0x115f, 0x1160, 0x034f].map(point => 'Plan ' + String.fromCodePoint(point)),
    ...[String.fromCodePoint(0xe0067), String.fromCodePoint(0xe007f), flag.slice(2), flag.slice(0,-2), '😀' + flag.slice(2),
      subdivisionFlag(''), subdivisionFlag('GBENG'), subdivisionFlag('notaregion'), flag + String.fromCodePoint(0xe0067),
      flag + String.fromCodePoint(0xe007f), flag.slice(0,4) + '\u202e' + flag.slice(4)].map(x => 'Plan ' + x),
  ];
  for (const workSample of fixtures) {
    assert.throws(() => parseCompetencyTestSubmission(definition(), {workSample}), undefined, workSample);
    await assertAnswerParity({workSample});
  }
});

test('deterministic mixed Unicode context corpus agrees with JS', async () => {
  const alphabet = ['a', 'ب', 'क', 'ष', 'क्', 'മ', 'മ്', 'श', 'ś', 'e\u0301', '😀', '👩', '🏽', '\u200d', '\u200c', '\uFE0F', '\uFE0E', '\u034f', '\u00ad', '\u2800', '!', ' ', '\t', '\u093e', '\u093c', '辻', String.fromCodePoint(0xe0100), subdivisionFlag('gbeng')];
  let state = 1402;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  for (let i = 0; i < 180; i += 1) {
    let workSample = '';
    for (let j = 0, count = 1 + next() % 12; j < count; j += 1) workSample += alphabet[next() % alphabet.length];
    await assertAnswerParity({workSample}, 'corpus ' + i);
  }
});

test('raw answer length uses 20000 codepoints before trim, never UTF16 length or NFC', async () => {
  for (const symbol of ['x', '😀', String.fromCodePoint(0x20000)]) {
    for (const count of [10001, 20000, 20001]) await assertAnswerParity({workSample: symbol.repeat(count)}, symbol + ' x ' + count);
  }
  for (const workSample of [' ' + '😀'.repeat(19999), ' ' + '😀'.repeat(20000), 'a😀'.repeat(10000), 'a😀'.repeat(10000) + 'a', 'e\u0301'.repeat(10000), 'e\u0301'.repeat(10000) + 'e', ' '.repeat(40001)]) await assertAnswerParity({workSample}, 'raw boundary');
});

test('trim matches ECMAScript exactly, with raw forbidden controls still rejected before trim', async () => {
  const whitespace = [9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279];
  for (const point of whitespace) {
    const value = String.fromCodePoint(point) + 'abc' + String.fromCodePoint(point);
    assert.equal(await queryValue('select private.competency_trim($1) value', [value]), value.trim(), 'trim U+' + point.toString(16));
    await assertAnswerParity({workSample: value});
  }
  assert.equal(await sqlAnswer({workSample: '  e\u0301  '}), 'e\u0301', 'no NFC normalization');
});

test('human score, coverage, ordering and unknown evidence match for every rubric size', async () => {
  for (let count = 1; count <= 12; count += 1) {
    for (let known = 0; known <= count; known += 1) {
      const observations = review(count);
      for (let i = 0; i < known; i += 1) observations[i] = {criterionIndex: i, rating: ['below','meets','above'][i % 3], evidence: 'Plan A.'};
      await assertScoreParity(definition(count), 'Plan A. Odpowiedź.', observations, `count=${count} known=${known}`);
    }
  }
});

test('literal quote visibility, flags, supplementary evidence and UTF16 length match', async () => {
  const flag = subdivisionFlag('gbeng');
  const cases = [ ['abc\u2800\u2800 opis', 'abc\u2800\u2800'], ['a\u2800\u2800 produkt', 'a\u2800\u2800'],
    ['a\u2000\u2000 produkt', 'a\u2000\u2000'], [flag.repeat(3), flag], [flag.repeat(3), flag.repeat(2)], [flag.repeat(3), flag.repeat(3)],
    [String.fromCodePoint(0x8fbb,0xe0100) + '本店です', String.fromCodePoint(0x8fbb,0xe0100) + '本店'],
    ['C++ Q&A 5–7 A/B', 'C++'], ['abc', 'ABC'], ['e\u0301xx', 'éxx'], ['😀'.repeat(5001), '😀'.repeat(5000)],
    ['😀'.repeat(5001), '😀'.repeat(5001)], ['x'.repeat(10001), 'x'.repeat(10000)], ['x'.repeat(10001), 'x'.repeat(10001)],
    ['x'.repeat(10000), ' ' + 'x'.repeat(10000)], ['Plan A.', '  Plan A.  '],
  ];
  for (const [answer, evidence] of cases) {
    const rows = review(); rows[0] = {criterionIndex: 0, rating: 'above', evidence};
    await assertScoreParity(definition(), answer, rows, 'quote length=' + evidence.length);
  }
});

test('invalid ratings, sparse JSON nulls, forged values and insufficient_data evidence reject', async () => {
  const invalid = [null, [], 'meets', {}, {criterionIndex: '0', rating: 'meets', evidence: 'abc'}, {criterionIndex: 1, rating: 'meets', evidence: 'abc'},
    {criterionIndex: 0, rating: 'hired', evidence: 'abc'}, {criterionIndex: 0, rating: 'meets', evidence: null},
    {criterionIndex: 0, rating: 'insufficient_data', evidence: 'abc'}, {criterionIndex: 0, rating: 'meets', evidence: 'unknown'},
    {criterionIndex: 0, rating: 'meets', evidence: 'ab'}];
  for (const value of invalid) { const rows = review(); rows[0] = value; await assertScoreParity(definition(), 'abc', rows); }
  for (const rows of [null, {}, [], Array(5), review().slice(1), [...review(), review()[0]]]) await assertScoreParity(definition(), 'abc', rows);
  const rows = review(); rows[0].evidence = '\uFEFF\t ';
  await assertScoreParity(definition(), 'abc', rows, 'unknown evidence trims before check');
});

async function assertDefinitionParity(rubric, label) {
  let expected;
  try {
    // A's validatedTest requires competency_test in addition to the shared parser.
    parseCompetencyTestSubmission(rubric, {workSample: 'abc'});
    expected = parseExerciseDefinition(rubric);
  } catch {
    await assert.rejects(sqlDefinition(rubric), error => ['PT422','22023','22P05','22P02'].includes(error.code), label);
    return;
  }
  assert.deepEqual(await sqlDefinition(rubric), expected, label);
}

test('definition admission validates every raw UTF16 bound before issue/start/review', async () => {
  const limits = {title: 200, instructions: 10000, expectedOutput: 4000, competency: 200, below: 2000, meets: 2000, above: 2000};
  for (const [field, maximum] of Object.entries(limits)) {
    for (const suffix of ['', 'x', ' ']) {
      const rubric = definition(1);
      const target = ['title','instructions','expectedOutput'].includes(field) ? rubric : rubric.criteria[0];
      target[field] = '😀'.repeat(maximum / 2) + suffix;
      await assertDefinitionParity(rubric, field + ' raw UTF16=' + target[field].length);
      await assertScoreParity(rubric, 'abc', review(1), field + ' review must agree with admission');
    }
  }
});

test('definition admission preserves A shape, kind, duration, rubric and canonicalization rules', async () => {
  const valid = definition(2);
  const variants = [null, [], false, 'rubric', {}, {...valid, kind: 'assessment_center'}, {...valid, kind: null},
    ...[null, '20', 0, 181, 1.5].map(durationMinutes => ({...valid, durationMinutes})),
    ...[null, {}, [], Array(13).fill(valid.criteria[0]), [null], ['criterion']].map(criteria => ({...valid, criteria})),
  ];
  for (const field of ['title','instructions','expectedOutput']) {
    for (const value of [null, 1, [], '', ' \t\uFEFF ']) variants.push({...valid, [field]: value});
  }
  for (const field of ['competency','below','meets','above']) {
    for (const value of [null, 1, [], '', ' \t\uFEFF ']) {
      const rubric = definition(1); rubric.criteria[0][field] = value; variants.push(rubric);
    }
  }
  for (const [first, second] of [['Diagnoza', ' DIAGNOZA '], ['ŁÓDŹ', 'łódź'], ['ＡＢＣ', 'abc'], ['Plan\u00A0 A', 'plan  a']]) {
    const duplicate = definition(2); duplicate.criteria[0].competency = first; duplicate.criteria[1].competency = second; variants.push(duplicate);
    const anchors = definition(1); anchors.criteria[0].below = first; anchors.criteria[0].above = second; variants.push(anchors);
  }
  for (const rubric of variants) await assertDefinitionParity(rubric, 'invalid rubric: ' + JSON.stringify(rubric)?.slice(0,120));
  for (const count of [1,12]) {
    const rubric = definition(count); rubric.title = ' \uFEFF Plan \t '; rubric.criteria[0].competency = '  Diagnoza  ';
    rubric.extra = 'ignored'; rubric.criteria[0].score = 100;
    await assertDefinitionParity(rubric, 'canonical valid rubric ' + count);
  }
});

test('score reuses immutable rubric validation and UTF16 text bounds', async () => {
  const variants = [ {...definition(), kind: 'assessment_center'}, {...definition(), criteria: []}, {...definition(), title: '😀'.repeat(101)},
    {...definition(), durationMinutes: 0}, {...definition(), durationMinutes: 1.5}, {...definition(), title: ''},
    {...definition(), criteria: [{...definition().criteria[0], competency: '😀'.repeat(101)}]},
  ];
  for (const rubric of variants) await assertScoreParity(rubric, 'abc', review(rubric.criteria.length));
});

test('helpers are immutable with an empty search path and strip PUBLIC and hostile default execute', async () => {
  const rows = (await db.query(`select p.proname, p.provolatile, p.proconfig,
    exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee <> p.proowner and a.privilege_type = 'EXECUTE') public_execute
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname like 'competency_%'`)).rows;
  assert.equal(rows.length, 7);
  for (const row of rows) { assert.equal(row.provolatile, 'i'); assert.ok(row.proconfig.includes('search_path=""')); assert.equal(row.public_execute, false, row.proname); }
});
