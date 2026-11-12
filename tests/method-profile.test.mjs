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
import * as binding from '../lib/method-binding.ts';

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
  // Te same białe znaki co method.trim_ws() w bazie: tabulator, nowa linia, CR, FF, VT, twarda spacja.
  assert.equal(method.trimWs('\t\n\r\f\v  SQL i raporty  \v\f\r\n\t'), 'SQL i raporty');
  assert.deepEqual(positionCompetencies({ required_competencies: ['SQL\t', '\nsql\r\n', 'Excel '] }), ['SQL', 'Excel']);
  const tabbed = proposeMethodProfile({ ...position, required_competencies: ['Analiza danych\t', 'Excel\n'] }, 'specialist').content;
  assert.deepEqual(tabbed.matrix.map(item => item.competency), ['Analiza danych', 'Excel']);
  assert.deepEqual(methodProfileProblems(tabbed, ['Analiza danych\t', 'Excel\n']), [], 'trailing whitespace in the position profile does not block approval');
  assert.equal(parseMethodProfileContent({ goal: 'Cel\f\v' }).goal, 'Cel');
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
  assert.equal(parseMethodProfileState({ can_edit: true, revision: 1, draft: { id: 'x', revision: 1, content: { matrix: 'x' } }, history: [] }), null);
  assert.equal(parseMethodProfileState({ can_edit: true, draft: null, approved: null, history: [] }), null, 'the change counter is required');
  const state = parseMethodProfileState({ can_edit: true, revision: 2, draft: null, history: [{ id: 'v', version_no: 1, approved_at: 't', content_hash: 'h', responsibility_level: 'manager' }],
    approved: { id: 'v', version_no: 1, content: byLevel.manager.content, content_hash: 'h', approved_at: 't', position_snapshot: { title: 'T' } } });
  assert.equal(state.approved.version_no, 1);
  assert.equal(state.revision, 2);
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

test('panel wiring: guarded page and link from the position profile', () => {
  const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const page = read('app/dashboard/[companyId]/positions/[positionId]/metoda/page.tsx');
  assert.match(page, /companyAccess\(companyId\)/);
  assert.match(page, /method_profile_state/);
  assert.match(page, /system nie podejmuje decyzji o kandydacie/);
  assert.match(read('app/dashboard/[companyId]/positions/[positionId]/page.tsx'), /positions\/\$\{position\.id\}\/metoda/);
});

// --- każda akcja, która tworzy lub zatwierdza definicję zadania, wiąże ją z wersją metody ---
// Prawdziwy lib/method-binding.ts, sztuczny klient bazy. Dla każdej ścieżki: powiązanie idzie po udanym
// zapisie i tylko wtedy; błąd powiązania nie zmienia wyniku zapisu i trafia do logu jako sam kod.

const recruitmentId = '33333333-3333-4333-8333-333333333333', definitionId = '44444444-4444-4444-8444-444444444444';
const exerciseId = '55555555-5555-4555-8555-555555555555', stamp = '2026-11-12T10:00:00Z';
const recruitmentBase = 'app/dashboard/[companyId]/recruitments/[recruitmentId]/';
function loadModule(file, mocks) {
  const path = fileURLToPath(new URL(`../${file}`, import.meta.url));
  const mod = new Module(path); mod.filename = path;
  const require = createRequire(path);
  mod.require = id => Object.hasOwn(mocks, id) ? mocks[id] : require(id);
  mod._compile(ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, path);
  return mod.exports;
}
const aiContext = { recruitmentId, exerciseId, definitionId, positionUpdatedAt: stamp };
const lib = '../../../../../lib/';
const aiMocks = client => ({
  'next/cache': { revalidatePath: () => {} },
  [`${lib}exercise-context`]: { exerciseContext: async () => ({ client, canEdit: true, editable: true, base: '/exercises' }) },
  [`${lib}exercise-ai-review`]: { validExerciseAiApprovalContext: () => true, exerciseAiApprovalError: code => `ai:${code}` },
  [`${lib}exercise-definition`]: { parseExerciseFormData: () => ({ kind: 'competency_test' }) },
  [`${lib}method-binding`]: binding,
});
async function withEnv(values, run) {
  const old = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  Object.assign(process.env, values);
  try { return await run(); }
  finally { for (const [name, value] of Object.entries(old)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } }
}
const confirmedForm = () => { const form = new FormData(); form.set('confirm', 'yes'); return form; };
const definitionPaths = {
  'manual save (save_exercise_definition)': {
    writeRpc: 'save_exercise_definition', okData: definitionId, okResult: { entryId: definitionId },
    run: client => loadModule(`${recruitmentBase}exercise-actions.ts`, {
      'next/cache': { revalidatePath: () => {} },
      [`${lib}company-access`]: { companyAccess: async () => ({ client, canEdit: true }) },
      [`${lib}exercise-definition`]: { parseExerciseFormData: () => ({ kind: 'competency_test' }) },
      [`${lib}exercise-editor`]: { validExerciseEditorContext: () => true, exerciseSaveError: code => `save:${code}` },
      [`${lib}method-binding`]: binding,
    }).saveExerciseDefinition(companyId, { recruitmentId, exerciseId, expectedVersion: 0, positionId, positionUpdatedAt: stamp }, {}, new FormData()),
  },
  'AI proposal correction (edit_exercise_ai_proposal)': {
    writeRpc: 'edit_exercise_ai_proposal', okData: definitionId, okResult: { entryId: definitionId },
    run: client => withEnv({ EXERCISE_AI_ENABLED: 'true' }, () => loadModule(`${recruitmentBase}exercise-ai-actions.ts`, aiMocks(client))
      .editExerciseAiProposal(companyId, aiContext, stamp, {}, new FormData())),
  },
  'AI proposal approval (approve_exercise_ai_proposal)': {
    writeRpc: 'approve_exercise_ai_proposal', okData: true, okResult: { approved: true },
    run: client => withEnv({ EXERCISE_AI_ENABLED: 'true' }, () => loadModule(`${recruitmentBase}exercise-ai-actions.ts`, aiMocks(client))
      .approveExerciseAiProposal(companyId, aiContext, {}, confirmedForm())),
  },
  'AI generation (finish_exercise_ai_generation)': {
    writeRpc: 'finish_exercise_ai_generation', okData: { status: 'completed', exercise_id: exerciseId }, okResult: { exerciseId },
    run: client => withEnv({ EXERCISE_AI_ENABLED: 'true', OPENAI_API_KEY: 'synthetic-only', AI_GATEWAY_ENABLED: 'false' },
      () => loadModule(`${recruitmentBase}exercise-generation-action.ts`, {
        'next/cache': { revalidatePath: () => {} },
        [`${lib}exercise-context`]: { exerciseUuid: /^[a-f0-9-]{36}$/i, exerciseContext: async () => ({ client, canEdit: true, editable: true,
          position: { id: positionId, updated_at: stamp }, base: '/exercises' }) },
        [`${lib}exercise-ai`]: { ExerciseAiError: class extends Error {} },
        // The real orchestration is covered by tests/exercise-ai-generation-ui.test.mjs; here the draft step
        // only has to reach the same finish RPC the real one calls and report its outcome the same way.
        [`${lib}exercise-ai-generation`]: { generateExerciseDraft: async (_input, _position, deps) => {
          try { const item = await deps.finish('f'.repeat(64), {}, {}, null); return item.exercise_id ? { exerciseId: item.exercise_id } : { error: 'failed' }; }
          catch { return { error: 'failed' }; } } },
        [`${lib}exercise-ai-provider`]: { requestExerciseDraft: async () => ({}) },
        [`${lib}ai-gateway/contract`]: { isAiGatewayEnabled: () => false },
        [`${lib}ai-ledger-writer`]: { exerciseBudgetFromEnv: () => null, exerciseLedgerWriterFromEnv: () => null },
        [`${lib}exercise-ai-budget`]: { withExerciseBudget: async () => assert.fail('gateway is off') },
        [`${lib}method-binding`]: binding,
      }).generateExerciseProposal(companyId, recruitmentId, definitionId, stamp, null, {}, confirmedForm())),
  },
};
// bind: 'ok' | 'error' | 'throw'; writeOk: whether the definition-writing RPC succeeds.
async function walk(path, { bind = 'ok', writeOk = true } = {}) {
  const calls = [], logged = [];
  const client = {
    from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: { id: recruitmentId, updated_at: null }, error: null }) }),
    rpc: async (name, args) => {
      calls.push([name, args]);
      if (name === 'method_bind_recruitment_definitions') {
        if (bind === 'throw') throw new Error('socket closed with secret detail');
        return bind === 'error' ? { data: null, error: { code: '42883', message: 'function secret detail does not exist' } } : { data: 1, error: null };
      }
      if (name === 'read_exercise_ai_proposal') return { error: null, data: { definitionEntry: { company_id: companyId, recruitment_id: recruitmentId,
        exercise_id: exerciseId, id: definitionId, position_updated_at: stamp } } };
      if (name === path.writeRpc) return writeOk ? { data: path.okData, error: null } : { data: null, error: { code: 'PT409', message: 'changed' } };
      return { data: null, error: { code: 'XX000', message: `unexpected ${name}` } };
    },
  };
  const original = console.error; console.error = (...args) => logged.push(args.join(' '));
  try { return { result: await path.run(client), calls, logged, names: calls.map(call => call[0]) }; }
  finally { console.error = original; }
}

for (const [label, path] of Object.entries(definitionPaths)) {
  test(`definition path binds the method version: ${label}`, async () => {
    const ok = await walk(path);
    assert.deepEqual(ok.result, path.okResult);
    assert.equal(ok.names.at(-1), 'method_bind_recruitment_definitions', 'binding is the last database call');
    assert.equal(ok.names.indexOf(path.writeRpc), ok.names.length - 2, 'binding follows the write that created or approved the definition');
    assert.deepEqual(ok.calls.at(-1)[1], { target_company: companyId, target_recruitment: recruitmentId });
    assert.equal(ok.names.filter(name => name === 'method_bind_recruitment_definitions').length, 1);
    assert.deepEqual(ok.logged, []);

    // Błąd powiązania: wynik zapisu bez zmian, w logu sam kod błędu.
    const failed = await walk(path, { bind: 'error' });
    assert.deepEqual(failed.result, path.okResult, 'a binding error leaves the save result unchanged');
    assert.deepEqual(failed.logged, ['method_bind_failed code=42883']);
    const thrown = await walk(path, { bind: 'throw' });
    assert.deepEqual(thrown.result, path.okResult, 'a thrown binding call leaves the save result unchanged');
    assert.deepEqual(thrown.logged, ['method_bind_failed code=exception']);
    for (const line of [...failed.logged, ...thrown.logged]) assert.doesNotMatch(line, /secret|detail|function/);

    // Nieudany zapis: nie ma czego wiązać.
    const refused = await walk(path, { writeOk: false });
    assert.ok(refused.result.error, 'the write failure is reported');
    assert.equal(refused.names.includes('method_bind_recruitment_definitions'), false, 'nothing is bound after a failed write');
  });
}

test('binding helper logs only a safe error code', async () => {
  const lines = [];
  const client = code => ({ rpc: async () => ({ data: null, error: { code, message: 'secret' } }) });
  for (const code of ['PT409', '42501', 'PGRST202']) await binding.bindMethodToDefinitions(client(code), companyId, recruitmentId, line => lines.push(line));
  for (const code of [undefined, null, 'x'.repeat(40), 'drop table; --', 7]) await binding.bindMethodToDefinitions(client(code), companyId, recruitmentId, line => lines.push(line));
  assert.deepEqual(lines, ['method_bind_failed code=PT409', 'method_bind_failed code=42501', 'method_bind_failed code=PGRST202',
    ...Array(5).fill('method_bind_failed code=unknown')]);
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
