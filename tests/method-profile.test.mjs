// SC-METHOD / #275 — profil metody: deterministyczna propozycja dla trzech
// poziomów odpowiedzialności, walidacja, komunikaty oraz akcja serwera panelu
// (od formularza do wywołań bazy). Bez bazy i bez sieci; baza jest sprawdzana
// w tests/method-profile-database.test.mjs. Dane są fikcyjne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire, Module } from 'node:module';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as method from '../lib/method-profile.ts';

const {
  METHOD_LIMITS, alignMatrix, assessmentMethods, methodProfileError, methodProfileProblems, parseMethodProfileContent,
  parseMethodProfileForm, parseMethodProfileState, positionCompetencies, proposeMethodProfile, responsibilityLevels,
} = method;

const position = {
  title: 'Analityk sprzedaży', description: 'Dostarcza zarządowi wiarygodne dane o sprzedaży.',
  tasks: ['Przygotowanie raportów', 'Analiza odchyleń'], kpis: ['Raport do 5. dnia miesiąca', 'Zero błędów w danych'],
  autonomy_level: 3, required_competencies: ['Analiza danych w SQL', 'Komunikacja z zespołem sprzedaży', 'Prawo jazdy kategorii B'],
};
const byLevel = Object.fromEntries(responsibilityLevels.map(level => [level, proposeMethodProfile(position, level)]));
const row = (level, competency) => byLevel[level].content.matrix.find(item => item.competency === competency);

test('the proposal is deterministic, complete and makes no AI call', () => {
  for (const level of responsibilityLevels) {
    assert.deepEqual(proposeMethodProfile(position, level), byLevel[level], `${level}: same input, same output`);
    const { content, missing } = byLevel[level];
    assert.deepEqual(missing, []);
    assert.equal(content.responsibilityLevel, level);
    assert.deepEqual(content.matrix.map(item => item.competency), position.required_competencies, 'one row per competency, in profile order');
    assert.deepEqual(methodProfileProblems(content, position.required_competencies), [], `${level}: ready to approve after review`);
    assert.deepEqual(parseMethodProfileContent(content), content, `${level}: already canonical and within limits`);
    for (const item of content.matrix) {
      assert.ok(assessmentMethods.includes(item.method));
      assert.ok(item.criteria.length >= 3);
      assert.match(item.limits, /nie automatyczna decyzja o zatrudnieniu/, 'every conclusion carries its limit');
    }
  }
  const source = readFileSync(new URL('../lib/method-profile.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^import /m, 'pure module: no imports');
  assert.doesNotMatch(source, /openai|fetch\(|Math\.random|Date\.now|new Date/i, 'no AI, network, randomness or clock');
});

test('specialist, manager and director get different, level-appropriate criteria', () => {
  const competency = 'Analiza danych w SQL';
  const criteria = Object.fromEntries(responsibilityLevels.map(level => [level, row(level, competency).criteria]));
  for (const [a, b] of [['specialist', 'manager'], ['specialist', 'director'], ['manager', 'director']]) {
    assert.equal(criteria[a].some(item => criteria[b].includes(item)), false, `${a} and ${b} share no criterion`);
    assert.notEqual(row(a, competency).evidence, row(b, competency).evidence);
    assert.notEqual(row(a, competency).justification, row(b, competency).justification);
    assert.notEqual(byLevel[a].content.constraints, byLevel[b].content.constraints);
  }
  const text = level => criteria[level].join(' ');
  // Specjalista: jakość i terminowość własnej pracy, bez odpowiedzialności za innych.
  assert.match(text('specialist'), /własne zadania/);
  assert.match(text('specialist'), /własnej pracy.*standard jakości/);
  assert.doesNotMatch(text('specialist'), /zespoł|budżet|strategi/i);
  // Menedżer: wynik zespołu, delegowanie, informacja zwrotna.
  assert.match(text('manager'), /wynik zespołu/);
  assert.match(text('manager'), /Deleguje/);
  assert.match(text('manager'), /informacji zwrotnej/);
  assert.doesNotMatch(text('manager'), /P&L|strategi/i);
  // Dyrektor: strategia, budżet / P&L, wpływ na inne działy.
  assert.match(text('director'), /strategią/);
  assert.match(text('director'), /budżetu.*P&L/);
  assert.match(text('director'), /inne działy/);

  // Metoda też zależy od poziomu i rodzaju kompetencji.
  assert.equal(row('specialist', competency).method, 'competency_test');
  assert.equal(row('manager', competency).method, 'case_study');
  assert.equal(row('director', competency).method, 'case_study');
  assert.equal(row('specialist', 'Komunikacja z zespołem sprzedaży').method, 'simulation');
  assert.equal(row('manager', 'Komunikacja z zespołem sprzedaży').method, 'simulation');
  assert.equal(row('director', 'Komunikacja z zespołem sprzedaży').method, 'interview');
  // Formalne uprawnienie potwierdza dokument, na każdym poziomie.
  for (const level of responsibilityLevels) assert.equal(row(level, 'Prawo jazdy kategorii B').method, 'cv_evidence');
  assert.match(byLevel.specialist.content.constraints, /Nie odpowiada za budżet/);
  assert.match(byLevel.manager.content.constraints, /wynik zespołu/);
  assert.match(byLevel.director.content.constraints, /budżet i wynik całego obszaru/);
  assert.match(byLevel.manager.content.constraints, /samodzielność 3\/5/);
});

test('missing data: the proposal and the checks say exactly what is missing', () => {
  const bare = proposeMethodProfile({ ...position, description: null, kpis: [], autonomy_level: null, required_competencies: ['', '  '] }, 'manager');
  assert.deepEqual(bare.missing, ['competencies']);
  assert.deepEqual(bare.content.matrix, []);
  assert.match(bare.content.goal, /Analityk sprzedaży.*Przygotowanie raportów; Analiza odchyleń/, 'goal falls back to the tasks');
  assert.equal(bare.content.expectedOutcome, '');
  assert.doesNotMatch(bare.content.constraints, /samodzielność/);
  assert.deepEqual(methodProfileProblems(bare.content, []), ['Uzupełnij oczekiwany wynik.',
    'Profil stanowiska nie ma żadnej kompetencji. Najpierw dopisz kompetencje w profilu stanowiska.']);

  const empty = parseMethodProfileContent({});
  assert.deepEqual(empty, { goal: '', expectedOutcome: '', constraints: '', responsibilityLevel: '', matrix: [] });
  const problems = methodProfileProblems(empty, position.required_competencies);
  assert.equal(problems.length, 4 + 3, 'four profile fields and three uncovered competencies');
  assert.match(problems.at(-1), /Brakuje wiersza macierzy dla kompetencji „Prawo jazdy kategorii B”/);

  const partial = structuredClone(byLevel.manager.content);
  partial.matrix[0].criteria = []; partial.matrix[0].limits = '';
  partial.matrix.push({ ...partial.matrix[1], competency: 'Kompetencja spoza profilu' });
  assert.deepEqual(methodProfileProblems(partial, position.required_competencies), [
    'Kompetencja „Analiza danych w SQL”: uzupełnij co najmniej jedno kryterium, granice wniosku.',
    'Kompetencji „Kompetencja spoza profilu” nie ma już w profilu stanowiska. Usuń ten wiersz albo dopisz kompetencję w profilu.']);
});

test('parsing enforces shape and limits; the form maps to canonical content', () => {
  const good = byLevel.director.content;
  for (const [label, bad] of [
    ['not an object', []], ['unknown level', { ...good, responsibilityLevel: 'prezes' }],
    ['goal too long', { ...good, goal: 'x'.repeat(METHOD_LIMITS.profileText + 1) }],
    ['unknown method', { ...good, matrix: [{ ...good.matrix[0], method: 'wrozenie' }] }],
    ['duplicate competency', { ...good, matrix: [good.matrix[0], { ...good.matrix[0], competency: ' ANALIZA danych w sql ' }] }],
    ['nameless row', { ...good, matrix: [{ ...good.matrix[0], competency: ' ' }] }],
    ['too many criteria', { ...good, matrix: [{ ...good.matrix[0], criteria: Array(METHOD_LIMITS.criteriaPerRow + 1).fill('k') }] }],
    ['too many rows', { ...good, matrix: Array.from({ length: METHOD_LIMITS.rows + 1 }, (_, i) => ({ ...good.matrix[0], competency: `K${i}` })) }],
    ['control character', { ...good, constraints: 'a\u0007b' }], ['wrong type', { ...good, goal: 5 }],
  ]) assert.throws(() => parseMethodProfileContent(bad), Error, label);

  const form = new FormData();
  form.set('goal', '  Cel  '); form.set('expectedOutcome', 'Wynik'); form.set('constraints', 'Budżet'); form.set('responsibilityLevel', 'manager');
  form.set('rows', '1'); form.set('matrix.0.competency', 'Planowanie'); form.set('matrix.0.evidence', 'Przykład planu');
  form.set('matrix.0.method', 'case_study'); form.set('matrix.0.justification', 'Bo tak pracuje zespół');
  form.set('matrix.0.criteria', ' Ustala terminy \r\n\r\nSprawdza wynik\n'); form.set('matrix.0.limits', 'Jedna sytuacja');
  assert.deepEqual(parseMethodProfileForm(form), { goal: 'Cel', expectedOutcome: 'Wynik', constraints: 'Budżet', responsibilityLevel: 'manager',
    matrix: [{ competency: 'Planowanie', evidence: 'Przykład planu', method: 'case_study', justification: 'Bo tak pracuje zespół',
      criteria: ['Ustala terminy', 'Sprawdza wynik'], limits: 'Jedna sytuacja' }] });
  form.set('rows', '31');
  assert.throws(() => parseMethodProfileForm(form), /Odśwież stronę/);

  assert.deepEqual(positionCompetencies({ required_competencies: [' SQL ', 'sql', '', 'Excel'] }), ['SQL', 'Excel']);
  const aligned = alignMatrix(byLevel.specialist.content, ['Prawo jazdy kategorii B', 'Nowa kompetencja']);
  assert.deepEqual(aligned.matrix.map(item => item.competency),
    ['Prawo jazdy kategorii B', 'Nowa kompetencja', 'Analiza danych w SQL', 'Komunikacja z zespołem sprzedaży']);
  assert.deepEqual(aligned.matrix[0], row('specialist', 'Prawo jazdy kategorii B'), 'typed rows are kept');
  assert.deepEqual(aligned.matrix[1], { competency: 'Nowa kompetencja', evidence: '', method: '', justification: '', criteria: [], limits: '' });
});

test('database errors become plain Polish messages; unexpected state is refused', () => {
  assert.equal(methodProfileError({ code: '22023', message: 'method_profile_incomplete:matrix.criteria' }),
    'Nie można zatwierdzić: Dla każdej kompetencji podaj co najmniej jedno kryterium.');
  assert.match(methodProfileError({ code: '22023', message: 'method_profile_incomplete:position.competencies' }), /dopisz kompetencje/);
  assert.match(methodProfileError({ code: 'PT409', message: 'method_draft_changed' }), /zmienił się w innym oknie/);
  assert.equal(methodProfileError({ code: '42501', message: 'method_forbidden' }), 'Masz dostęp tylko do odczytu.');
  assert.match(methodProfileError({ code: '55000', message: 'method_position_archived' }), /zarchiwizowane/);
  assert.match(methodProfileError({ code: '22023', message: 'method_profile_invalid' }), /Sprawdź pola/);
  assert.match(methodProfileError(null), /Nie udało się zapisać/);
  assert.doesNotMatch(methodProfileError({ code: 'XX000', message: 'relation method.profile_versions secret detail' }), /relation|secret/);

  assert.equal(parseMethodProfileState(null), null);
  assert.equal(parseMethodProfileState({ can_edit: true, draft: { id: 'x', revision: 1, content: { matrix: 'x' } }, history: [] }), null);
  const state = parseMethodProfileState({ can_edit: true, draft: null, history: [{ id: 'v', version_no: 1, approved_at: 't', content_hash: 'h', responsibility_level: 'manager' }],
    approved: { id: 'v', version_no: 1, content: byLevel.manager.content, content_hash: 'h', approved_at: 't', position_snapshot: { title: 'T' } } });
  assert.equal(state.approved.version_no, 1);
  assert.deepEqual(state.approved.content, byLevel.manager.content);
});

// --- akcja serwera: od formularza panelu do wywołań bazy ---------------------

function loadAction(context) {
  const file = 'app/dashboard/[companyId]/positions/[positionId]/metoda/actions.ts';
  const path = fileURLToPath(new URL(`../${file}`, import.meta.url));
  const mod = new Module(path); mod.filename = path;
  const mocks = {
    'next/cache': { revalidatePath: target => context.revalidated.push(target) },
    'next/navigation': { redirect: target => { throw Object.assign(new Error('NEXT_REDIRECT'), { target }); } },
    '../../../../../../lib/company-access': { companyAccess: async companyId => { context.accessChecked.push(companyId); return context.access; } },
    '../../../../../../lib/method-profile': method,
  };
  const require = createRequire(path);
  mod.require = id => id in mocks ? mocks[id] : require(id);
  mod._compile(ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, path);
  return mod.exports.saveMethodProfile;
}

function scenario({ canEdit = true, competencies = position.required_competencies, rpc = {} } = {}) {
  const calls = [];
  const client = {
    from: table => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => {
      calls.push(['from', table]); return { data: { required_competencies: competencies }, error: null };
    } }) }) }) }),
    rpc: async (name, args) => { calls.push([name, args]); return rpc[name] ?? { data: null, error: { code: 'XX000', message: 'unexpected' } }; },
  };
  const context = { revalidated: [], accessChecked: [], access: { client, canEdit } };
  return { calls, context, action: loadAction(context) };
}
const companyId = '11111111-1111-4111-8111-111111111111', positionId = '22222222-2222-4222-8222-222222222222';
function formFor(content, intent, revision = 0) {
  const form = new FormData();
  for (const name of ['goal', 'expectedOutcome', 'constraints', 'responsibilityLevel']) form.set(name, content[name]);
  form.set('rows', String(content.matrix.length)); form.set('expectedRevision', String(revision)); form.set('intent', intent);
  content.matrix.forEach((item, index) => {
    for (const name of ['competency', 'evidence', 'method', 'justification', 'limits']) form.set(`matrix.${index}.${name}`, item[name]);
    form.set(`matrix.${index}.criteria`, item.criteria.join('\n'));
  });
  return form;
}

test('server action: saving a draft sends the canonical content and the revision the recruiter saw', async () => {
  const s = scenario({ rpc: { method_profile_save_draft: { data: 4, error: null } } });
  const result = await s.action(companyId, positionId, {}, formFor(byLevel.manager.content, 'save', 3));
  assert.deepEqual(result, { saved: true, revision: 4 });
  assert.deepEqual(s.context.accessChecked, [companyId], 'the access guard runs first');
  assert.deepEqual(s.calls, [['method_profile_save_draft', { target_company: companyId, target_position: positionId,
    draft_content: byLevel.manager.content, expected_revision: 3 }]]);
  assert.deepEqual(s.context.revalidated, [`/dashboard/${companyId}/positions/${positionId}/metoda`]);
});

test('server action: approval saves, then approves exactly the saved revision', async () => {
  const s = scenario({ rpc: { method_profile_save_draft: { data: 2, error: null }, method_profile_approve: { data: 'version-id', error: null } } });
  await assert.rejects(s.action(companyId, positionId, {}, formFor(byLevel.director.content, 'approve', 1)),
    error => error.target === `/dashboard/${companyId}/positions/${positionId}/metoda?zapisano=zatwierdzono`);
  assert.deepEqual(s.calls.map(call => call[0]), ['from', 'method_profile_save_draft', 'method_profile_approve']);
  assert.deepEqual(s.calls[2][1], { target_company: companyId, target_position: positionId, expected_revision: 2 });
});

test('server action: an incomplete profile is not approved and nothing is written', async () => {
  const incomplete = structuredClone(byLevel.specialist.content);
  incomplete.matrix[1].criteria = []; incomplete.goal = '';
  const s = scenario();
  const result = await s.action(companyId, positionId, {}, formFor(incomplete, 'approve'));
  assert.match(result.error, /^Nie można jeszcze zatwierdzić\. Uzupełnij cel stanowiska\. Kompetencja „Komunikacja z zespołem sprzedaży”: uzupełnij co najmniej jedno kryterium\./);
  assert.deepEqual(s.calls.map(call => call[0]), ['from'], 'no draft write, no approval');
  // Ten sam niekompletny profil wolno zapisać jako szkic.
  const draft = scenario({ rpc: { method_profile_save_draft: { data: 1, error: null } } });
  assert.deepEqual(await draft.action(companyId, positionId, {}, formFor(incomplete, 'save')), { saved: true, revision: 1 });

  // Baza odrzuca zatwierdzenie (np. profil stanowiska zmienił się w międzyczasie): szkic zostaje, formularz zna jego numer.
  const refused = scenario({ rpc: { method_profile_save_draft: { data: 5, error: null },
    method_profile_approve: { data: null, error: { code: '22023', message: 'method_profile_incomplete:matrix.coverage' } } } });
  assert.deepEqual(await refused.action(companyId, positionId, {}, formFor(byLevel.manager.content, 'approve', 4)),
    { error: 'Nie można zatwierdzić: Macierz dowodów nie obejmuje wszystkich kompetencji z profilu stanowiska.', revision: 5 });
});

test('server action: read-only members, bad input and database refusals never write', async () => {
  const viewer = scenario({ canEdit: false });
  assert.deepEqual(await viewer.action(companyId, positionId, {}, formFor(byLevel.manager.content, 'approve')), { error: 'Masz dostęp tylko do odczytu.' });
  assert.deepEqual(viewer.calls, []);

  const s = scenario();
  assert.match((await s.action(companyId, 'not-a-uuid', {}, formFor(byLevel.manager.content, 'save'))).error, /Nie rozpoznano stanowiska/);
  assert.match((await s.action(companyId, positionId, {}, formFor(byLevel.manager.content, 'save', -1))).error, /Odśwież stronę/);
  const long = structuredClone(byLevel.manager.content); long.goal = 'x'.repeat(1001);
  assert.match((await s.action(companyId, positionId, {}, formFor(long, 'save'))).error, /Skróć pole „Cel stanowiska”/);
  assert.deepEqual(s.calls, []);

  const denied = scenario({ rpc: { method_profile_save_draft: { data: null, error: { code: '42501', message: 'method_forbidden' } } } });
  assert.deepEqual(await denied.action(companyId, positionId, {}, formFor(byLevel.manager.content, 'save')), { error: 'Masz dostęp tylko do odczytu.' });
  const conflict = scenario({ rpc: { method_profile_save_draft: { data: null, error: { code: 'PT409', message: 'method_draft_changed' } } } });
  assert.match((await conflict.action(companyId, positionId, {}, formFor(byLevel.manager.content, 'approve'))).error, /zmienił się w innym oknie/);
  assert.deepEqual(conflict.calls.map(call => call[0]), ['from', 'method_profile_save_draft'], 'no approval after a refused save');
});

test('panel wiring: guarded page, link from the position profile, binding after an exercise is saved', () => {
  const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const page = read('app/dashboard/[companyId]/positions/[positionId]/metoda/page.tsx');
  assert.match(page, /companyAccess\(companyId\)/);
  assert.match(page, /method_profile_state/);
  assert.match(page, /system nie podejmuje decyzji o kandydacie/);
  assert.match(read('app/dashboard/[companyId]/positions/[positionId]/page.tsx'), /positions\/\$\{position\.id\}\/metoda/);
  const exercise = read('app/dashboard/[companyId]/recruitments/[recruitmentId]/exercise-actions.ts');
  assert.ok(exercise.indexOf("rpc('method_bind_definition'") > exercise.indexOf("rpc('save_exercise_definition'"), 'binding follows a successful save');
  assert.match(exercise, /target_company: companyId, target_definition: result\.data/);
});

test('panel form renders every field of the proposal, with the revision and a removable stale row', () => {
  const file = 'app/dashboard/[companyId]/positions/[positionId]/metoda/method-form.tsx';
  const path = fileURLToPath(new URL(`../${file}`, import.meta.url));
  const mod = new Module(path); mod.filename = path;
  const mocks = { './actions': { saveMethodProfile: async () => ({}) }, '../../../../../../lib/method-profile': method };
  const require = createRequire(path);
  mod.require = id => id in mocks ? mocks[id] : require(id);
  mod._compile(ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, path);
  const initial = alignMatrix(byLevel.manager.content, [...position.required_competencies.slice(0, 2), 'Nowa kompetencja']);
  const html = renderToStaticMarkup(createElement(mod.exports.MethodForm, {
    companyId, positionId, initial, revision: 7, staleCompetencies: ['Prawo jazdy kategorii B'] }));
  assert.match(html, /name="expectedRevision" value="7"/);
  assert.match(html, /name="rows" value="4"/);
  for (const name of ['goal', 'expectedOutcome', 'constraints', 'responsibilityLevel']) assert.ok(html.includes(`name="${name}"`), name);
  for (let index = 0; index < 4; index++) {
    for (const name of ['competency', 'evidence', 'method', 'justification', 'criteria', 'limits']) {
      assert.ok(html.includes(`name="matrix.${index}.${name}"`), `matrix.${index}.${name}`);
    }
  }
  assert.match(html, /<option value="manager" selected="">Menedżer/);
  assert.match(html, /Deleguje zadania/);
  assert.match(html, /Tej kompetencji nie ma już w profilu stanowiska/);
  assert.equal(html.match(/Usuń ten wiersz/g).length, 1, 'only the stale competency can be removed');
  assert.match(html, /<button type="submit" value="save" name="intent">Zapisz szkic</);
  assert.match(html, /<button type="submit" value="approve" name="intent">Zapisz i zatwierdź</);
});
