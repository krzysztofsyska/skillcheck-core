import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadExercisesReportSection, exercisesSectionMessages, reportActorLabel,
  EXERCISES_REPORT_LIMIT, EXERCISES_SCAN_LIMIT,
} from '../lib/candidate-report-exercises.ts';
import { loadStagesReportSection, stagesSectionMessages, STAGES_HISTORY_LIMIT } from '../lib/candidate-report-stages.ts';

// R2-B: dane sekcji „Ćwiczenia" i „Etapy" raportu kandydata. Dane fikcyjne.
// Klient udaje Data API tak, jak robi to baza pod RLS: filtruje po eq,
// a w testach podmieniamy wiersze na niezgodne, żeby sprawdzić kontrolę w kodzie.
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const route = { companyId: id(1), recruitmentId: id(2), applicationId: id(3) };
const ownerId = id(90);
const recruiterId = id(91);
const recruiter = { userId: recruiterId, ownerId, canEdit: true };
const tenant = { company_id: route.companyId, recruitment_id: route.recruitmentId };

function fakeClient(tables, { errors = {} } = {}) {
  const calls = [];
  const from = table => {
    const state = { table, select: null, eqs: [], order: null, limit: null };
    const result = () => {
      calls.push(state);
      if (errors[table]) return { data: null, error: errors[table] };
      // Ścieżka JSON jak w PostgREST: 'definition->>kind' czyta pole obiektu.
      const field = (row, k) => {
        const [column, key] = k.split('->>');
        return key === undefined ? [column in row, row[column]] : [column in row, row[column]?.[key]];
      };
      let rows = (tables[table] ?? []).filter(row => state.eqs.every(([k, v]) => {
        const [present, value] = field(row, k);
        return !present || (typeof v === 'function' ? v(value) : value === v) || row.__forged;
      }));
      if (state.order) {
        const dir = state.order[1]?.ascending === false ? -1 : 1;
        rows = [...rows].sort((a, b) => String(a[state.order[0]]).localeCompare(String(b[state.order[0]])) * dir);
      }
      if (state.limit != null) rows = rows.slice(0, state.limit);
      return { data: rows.map(({ __forged, ...row }) => row), error: null };
    };
    const q = {
      select(columns) { state.select = columns; return q; },
      eq(k, v) { state.eqs.push([k, v]); return q; },
      order(column, options) { state.order = [column, options]; return q; },
      limit(n) { state.limit = n; return q; },
      in(k, values) { state.eqs.push([k, v => values.includes(v)]); return q; },
      async maybeSingle() { const r = result(); return { data: r.data?.[0] ?? null, error: r.error }; },
      then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
    };
    return q;
  };
  return { client: { from }, calls };
}

// --- Ćwiczenia / Assessment Center ---
const acDefinition = (title = 'Rozmowa z klientem') => ({
  kind: 'assessment_center', title, instructions: 'Instrukcja', expectedOutput: 'Odpowiedź', durationMinutes: 20,
  criteria: [{ competency: 'Komunikacja', below: 'Przerywa', meets: 'Słucha', above: 'Podsumowuje' },
    { competency: 'Analiza', below: 'Pomija problem', meets: 'Bada problem', above: 'Sprawdza przyczyny' }],
});
const competencyDefinition = { ...acDefinition('Test pisemny'), kind: 'competency_test' };
const defRow = (n, exercise, version, created, definition = acDefinition()) =>
  ({ id: id(n), exercise_id: id(exercise), ...tenant, version, definition, created_at: created });
const obsRow = (definitionN, overrides = {}) => ({
  id: id(500 + definitionN), ...tenant, application_id: route.applicationId, definition_entry_id: id(definitionN),
  version: 2, author_id: recruiterId, created_at: '2026-11-16T09:30:00Z',
  observations: [{ criterionIndex: 0, rating: 'meets', evidence: ' Zadał otwarte pytanie. ' },
    { criterionIndex: 1, rating: 'insufficient_data', evidence: '' }],
  ...overrides,
});

test('R2-B ćwiczenia: czytelnik bez roli rekrutera nie wywołuje zapytań', async () => {
  const { client, calls } = fakeClient({});
  assert.deepEqual(await loadExercisesReportSection(client, route, { ...recruiter, canEdit: false }),
    { kind: 'no_access', message: exercisesSectionMessages.noAccess });
  assert.equal(calls.length, 0);
});

test('R2-B ćwiczenia: ocena obserwatora z notatką, wersje, rola; bez tekstu pracy i identyfikatora autora', async () => {
  const { client, calls } = fakeClient({
    exercise_definition_entries: [
      defRow(10, 100, 2, '2026-11-15T10:00:00Z'),
      defRow(11, 100, 1, '2026-11-14T10:00:00Z'),
      defRow(12, 101, 1, '2026-11-13T10:00:00Z'),
      defRow(13, 102, 1, '2026-11-12T10:00:00Z', competencyDefinition),
    ],
    latest_exercise_observations: [obsRow(11)],
  });
  const section = await loadExercisesReportSection(client, route, recruiter);
  assert.equal(section.kind, 'list');
  assert.equal(section.truncated, false);
  // Ćwiczenie 100: oceniona wersja 1 zostaje, nieoceniona wersja 2 nie dubluje go.
  // Ćwiczenie 101: bez obserwacji, pokazane raz jako „nieocenione". Test kompetencji pominięty.
  assert.deepEqual(section.exercises.map(e => [e.definitionEntryId, e.status]),
    [[id(11), 'incomplete_evidence'], [id(12), 'not_assessed']]);
  const [observed, pending] = section.exercises;
  assert.equal(observed.title, 'Rozmowa z klientem');
  assert.equal(observed.definitionVersion, 1);
  assert.equal(observed.statusLabel, 'Niepełne dowody');
  assert.equal(observed.evidencedCriteria, 1);
  assert.equal(observed.totalCriteria, 2);
  assert.deepEqual(observed.observation, { version: 2, observedAt: '2026-11-16T09:30:00Z', observer: 'Ty (rekruter)' });
  assert.deepEqual(observed.criteria, [
    { criterionIndex: 0, competency: 'Komunikacja', rating: 'meets', ratingLabel: 'Zgodnie z wymaganiami', observerNote: 'Zadał otwarte pytanie.' },
    { criterionIndex: 1, competency: 'Analiza', rating: 'insufficient_data', ratingLabel: 'Brak wystarczających danych', observerNote: null },
  ]);
  assert.equal(pending.observation, null);
  assert.equal(pending.statusLabel, 'Nieocenione');
  assert.ok(pending.criteria.every(c => c.observerNote === null && c.rating === 'insufficient_data'));
  assert.doesNotMatch(JSON.stringify(section), new RegExp(recruiterId + '|work_sample|score'));
  // Nazwane kolumny (bez work_sample, bez *) i zakres firma → rekrutacja → zgłoszenie.
  const [defs, obs] = calls;
  assert.equal(defs.table, 'exercise_definition_entries');
  assert.doesNotMatch(defs.select, /\*/);
  assert.deepEqual(defs.eqs, [['company_id', route.companyId], ['recruitment_id', route.recruitmentId],
    ['definition->>kind', 'assessment_center']]);
  assert.equal(defs.limit, EXERCISES_SCAN_LIMIT + 1);
  assert.equal(obs.table, 'latest_exercise_observations');
  assert.doesNotMatch(obs.select, /\*|work_sample/);
  assert.deepEqual(obs.eqs, [['company_id', route.companyId], ['recruitment_id', route.recruitmentId], ['application_id', route.applicationId]]);
  assert.equal(obs.limit, EXERCISES_SCAN_LIMIT + 1);
});

test('R2-B ćwiczenia: pełne dowody i rola innego autora', async () => {
  const full = obsRow(10, { author_id: ownerId, observations: [
    { criterionIndex: 0, rating: 'above', evidence: 'Podsumował ustalenia.' },
    { criterionIndex: 1, rating: 'below', evidence: 'Nie sprawdził przyczyny.' }] });
  const { client } = fakeClient({ exercise_definition_entries: [defRow(10, 100, 1, '2026-11-15T10:00:00Z')],
    latest_exercise_observations: [full] });
  const section = await loadExercisesReportSection(client, route, recruiter);
  assert.equal(section.exercises[0].status, 'review_required');
  assert.equal(section.exercises[0].statusLabel, 'Do sprawdzenia przez człowieka');
  assert.equal(section.exercises[0].observation.observer, 'Właściciel konta firmy');
  assert.equal(reportActorLabel(ownerId, { userId: ownerId, ownerId, canEdit: true }), 'Ty (właściciel konta firmy)');
});

test('R2-B ćwiczenia: brak ćwiczeń AC i brak schematu mają neutralne stany', async () => {
  const none = fakeClient({ exercise_definition_entries: [defRow(13, 102, 1, '2026-11-12T10:00:00Z', competencyDefinition)] });
  assert.deepEqual(await loadExercisesReportSection(none.client, route, recruiter),
    { kind: 'empty', message: exercisesSectionMessages.empty });
  const missing = fakeClient({}, { errors: { latest_exercise_observations: { code: 'PGRST205' } } });
  assert.equal((await loadExercisesReportSection(missing.client, route, recruiter)).kind, 'unavailable');
});

test('R2-B ćwiczenia: niezgodny zapis albo błąd odczytu przerywa sekcję bez częściowych ocen', async () => {
  const error = { kind: 'error', message: exercisesSectionMessages.error };
  const defs = [defRow(10, 100, 1, '2026-11-15T10:00:00Z')];
  const cases = [
    fakeClient({}, { errors: { exercise_definition_entries: { code: 'PT500' } } }),
    // Obserwacja przypięta do innego zgłoszenia albo innej firmy.
    fakeClient({ exercise_definition_entries: defs, latest_exercise_observations: [{ ...obsRow(10, { application_id: id(9) }), __forged: true }] }),
    fakeClient({ exercise_definition_entries: defs, latest_exercise_observations: [{ ...obsRow(10, { company_id: id(9) }), __forged: true }] }),
    // Wersja ćwiczenia z innej rekrutacji.
    fakeClient({ exercise_definition_entries: [{ ...defRow(10, 100, 1, '2026-11-15T10:00:00Z'), recruitment_id: id(9), __forged: true }] }),
    // Ocena bez dowodu, dwie „najnowsze" obserwacje tej samej wersji, brak czasu.
    fakeClient({ exercise_definition_entries: defs, latest_exercise_observations: [obsRow(10, { observations: [
      { criterionIndex: 0, rating: 'meets', evidence: '' }, { criterionIndex: 1, rating: 'insufficient_data', evidence: '' }] })] }),
    fakeClient({ exercise_definition_entries: defs, latest_exercise_observations: [obsRow(10), obsRow(10)] }),
    fakeClient({ exercise_definition_entries: defs, latest_exercise_observations: [obsRow(10, { created_at: null })] }),
  ];
  for (const { client } of cases) assert.deepEqual(await loadExercisesReportSection(client, route, recruiter), error);
  assert.deepEqual(await loadExercisesReportSection(fakeClient({}).client, { ...route, applicationId: 'x' }, recruiter), error);
  const throwing = { from: () => { throw new Error('network'); } };
  assert.deepEqual(await loadExercisesReportSection(throwing, route, recruiter), error);
});

test('R2-B ćwiczenia: raport pokazuje najwyżej kilka najnowszych ćwiczeń', async () => {
  const many = Array.from({ length: EXERCISES_REPORT_LIMIT + 2 }, (_, i) =>
    defRow(20 + i, 200 + i, 1, `2026-11-${String(10 + i).padStart(2, '0')}T10:00:00Z`));
  const section = await loadExercisesReportSection(fakeClient({ exercise_definition_entries: many }).client, route, recruiter);
  assert.equal(section.exercises.length, EXERCISES_REPORT_LIMIT);
  assert.equal(section.truncated, true);
});

// --- Etapy rekrutacji ---
const scoped = { ...tenant, application_id: route.applicationId };
const stageRows = [
  { id: id(31), ...tenant, name: 'Rozmowa telefoniczna', sequence: 1 },
  { id: id(32), ...tenant, name: 'Rozmowa z kierownikiem', sequence: 2 },
];
const appRow = (overrides = {}) => ({ id: route.applicationId, ...tenant, current_stage_id: id(32),
  human_decision: 'next_stage', human_decision_reason: 'Spełnia wymagania konieczne z rozmowy.', ...overrides });
const stageTables = (overrides = {}) => ({
  applications: [appRow()],
  assessment_stages: stageRows,
  application_stage_events: [
    { id: id(41), ...scoped, from_stage_id: id(31), to_stage_id: id(32), actor_id: ownerId, created_at: '2026-11-16T12:00:00Z' },
    { id: id(42), ...scoped, from_stage_id: null, to_stage_id: id(33), actor_id: recruiterId, created_at: '2026-11-15T12:00:00Z' },
  ],
  application_decision_events: [
    { id: id(51), ...scoped, previous_decision: null, new_decision: 'next_stage',
      reason: 'Spełnia wymagania konieczne z rozmowy.', actor_id: recruiterId, created_at: '2026-11-16T13:00:00Z' },
  ],
  ...overrides,
});

test('R2-B ćwiczenia: oceniona wersja spoza 100 najnowszych definicji jest doczytana po id', async () => {
  // 100 nowszych, nieocenionych wersji AC tego samego ćwiczenia wypycha ocenioną wersję poza limit odczytu.
  const filler = Array.from({ length: EXERCISES_SCAN_LIMIT }, (_, i) =>
    defRow(1000 + i, 100, 3 + i, `2026-11-20T${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`));
  const { client, calls } = fakeClient({
    exercise_definition_entries: [
      ...filler,
      defRow(10, 100, 2, '2026-11-15T10:00:00Z'),
      defRow(11, 100, 1, '2026-11-14T10:00:00Z'),
    ],
    latest_exercise_observations: [obsRow(10)],
  });
  const section = await loadExercisesReportSection(client, route, recruiter);
  assert.equal(section.kind, 'list');
  assert.deepEqual(section.exercises.map(e => [e.definitionEntryId, e.status, e.definitionVersion]),
    [[id(10), 'incomplete_evidence', 2]]);
  assert.equal(section.exercises[0].evidencedCriteria, 1);
  // Doczytanie po id zachowuje filtry firmy i rekrutacji.
  const extra = calls.filter(c => c.table === 'exercise_definition_entries').at(-1);
  assert.ok(extra.eqs.some(([k, v]) => k === 'company_id' && v === route.companyId));
  assert.ok(extra.eqs.some(([k, v]) => k === 'recruitment_id' && v === route.recruitmentId));
  assert.ok(extra.eqs.some(([k]) => k === 'id'));
  assert.ok(extra.eqs.some(([k, v]) => k === 'definition->>kind' && v === 'assessment_center'));
});

test('R2-B ćwiczenia: 100 nowszych testów kompetencji nie ukrywa starszego, nieocenionego ćwiczenia AC', async () => {
  // Rodzaj jest filtrowany w zapytaniu przed limitem, więc testy kompetencji nie zajmują okna odczytu.
  const filler = Array.from({ length: EXERCISES_SCAN_LIMIT }, (_, i) =>
    defRow(1000 + i, 2000 + i, 1, `2026-11-20T${String(10 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`, competencyDefinition));
  const { client, calls } = fakeClient({
    exercise_definition_entries: [...filler, defRow(10, 100, 1, '2026-11-01T10:00:00Z')],
  });
  const section = await loadExercisesReportSection(client, route, recruiter);
  assert.equal(section.kind, 'list');
  assert.equal(section.truncated, false);
  assert.deepEqual(section.exercises.map(e => [e.definitionEntryId, e.status]), [[id(10), 'not_assessed']]);
  const defs = calls.find(c => c.table === 'exercise_definition_entries');
  assert.ok(defs.eqs.some(([k, v]) => k === 'definition->>kind' && v === 'assessment_center'));
  assert.equal(defs.limit, EXERCISES_SCAN_LIMIT + 1);
});

test('R2-B etapy: czytelnik bez roli rekrutera nie wywołuje zapytań', async () => {
  const { client, calls } = fakeClient(stageTables());
  assert.deepEqual(await loadStagesReportSection(client, route, { ...recruiter, canEdit: false }),
    { kind: 'no_access', message: stagesSectionMessages.noAccess });
  assert.equal(calls.length, 0);
});

test('R2-B etapy: aktualny etap, kolejność, historia i ręczna decyzja z uzasadnieniem; autor jako rola', async () => {
  const { client, calls } = fakeClient(stageTables());
  const section = await loadStagesReportSection(client, route, recruiter);
  assert.equal(section.kind, 'list');
  assert.equal(section.currentStage, 'Rozmowa z kierownikiem');
  assert.deepEqual(section.stages, [
    { name: 'Rozmowa telefoniczna', sequence: 1, current: false },
    { name: 'Rozmowa z kierownikiem', sequence: 2, current: true },
  ]);
  assert.deepEqual(section.moves, [
    { fromStage: 'Rozmowa telefoniczna', toStage: 'Rozmowa z kierownikiem', at: '2026-11-16T12:00:00Z', actor: 'Właściciel konta firmy' },
    { fromStage: 'Nieprzypisany', toStage: 'Usunięty etap', at: '2026-11-15T12:00:00Z', actor: 'Ty (rekruter)' },
  ]);
  assert.deepEqual(section.decision, { label: 'Kolejny etap', reason: 'Spełnia wymagania konieczne z rozmowy.' });
  assert.deepEqual(section.decisions, [{ previousDecision: 'Brak decyzji', newDecision: 'Kolejny etap',
    reason: 'Spełnia wymagania konieczne z rozmowy.', at: '2026-11-16T13:00:00Z', actor: 'Ty (rekruter)' }]);
  assert.equal(section.movesTruncated, false);
  assert.equal(section.decisionsTruncated, false);
  assert.doesNotMatch(JSON.stringify(section), new RegExp(`${ownerId}|${recruiterId}|notes`));
  // Bez notatek z rozmów, nazwane kolumny, zakres firma → rekrutacja → zgłoszenie.
  assert.deepEqual(calls.map(c => c.table).sort(),
    ['application_decision_events', 'application_stage_events', 'applications', 'assessment_stages']);
  for (const call of calls) assert.doesNotMatch(call.select, /\*|notes/);
  const events = calls.find(c => c.table === 'application_stage_events');
  assert.deepEqual(events.eqs, [['company_id', route.companyId], ['recruitment_id', route.recruitmentId], ['application_id', route.applicationId]]);
  assert.equal(events.limit, STAGES_HISTORY_LIMIT + 1);
});

test('R2-B etapy: brak etapów, brak przypisania i brak decyzji to neutralne stany, nie zera', async () => {
  const { client } = fakeClient(stageTables({
    applications: [appRow({ current_stage_id: null, human_decision: null, human_decision_reason: null })],
    assessment_stages: [], application_stage_events: [], application_decision_events: [],
  }));
  const section = await loadStagesReportSection(client, route, recruiter);
  assert.equal(section.currentStage, stagesSectionMessages.unassigned);
  assert.deepEqual([section.stages, section.moves, section.decisions, section.decision], [[], [], [], null]);
});

test('R2-B etapy: niezgodne powiązanie, nieznana decyzja albo błąd odczytu przerywa sekcję', async () => {
  const error = { kind: 'error', message: stagesSectionMessages.error };
  const t = stageTables();
  const cases = [
    fakeClient(t, { errors: { application_stage_events: { code: 'PT500' } } }),
    fakeClient({ ...t, applications: [] }),
    fakeClient({ ...t, applications: [{ ...appRow({ recruitment_id: id(9) }), __forged: true }] }),
    fakeClient({ ...t, assessment_stages: [{ ...stageRows[0], company_id: id(9), __forged: true }] }),
    fakeClient({ ...t, application_stage_events: [{ ...t.application_stage_events[0], application_id: id(9), __forged: true }] }),
    fakeClient({ ...t, application_decision_events: [{ ...t.application_decision_events[0], application_id: id(9), __forged: true }] }),
    fakeClient({ ...t, application_decision_events: [{ ...t.application_decision_events[0], new_decision: 'hire' }] }),
    fakeClient({ ...t, applications: [appRow({ human_decision: 'reject' })] }),
    fakeClient({ ...t, application_stage_events: [{ ...t.application_stage_events[0], created_at: 'wczoraj' }] }),
  ];
  for (const { client } of cases) assert.deepEqual(await loadStagesReportSection(client, route, recruiter), error);
  const missing = fakeClient(t, { errors: { application_decision_events: { code: '42P01' } } });
  assert.equal((await loadStagesReportSection(missing.client, route, recruiter)).kind, 'unavailable');
  const throwing = { from: () => { throw new Error('network'); } };
  assert.deepEqual(await loadStagesReportSection(throwing, route, recruiter), error);
});

test('R2-B etapy: historia jest skracana do limitu z informacją o skróceniu', async () => {
  const many = Array.from({ length: STAGES_HISTORY_LIMIT + 1 }, (_, i) => ({ id: id(600 + i), ...scoped,
    from_stage_id: id(31), to_stage_id: id(32), actor_id: recruiterId, created_at: '2026-11-16T12:00:00Z' }));
  const section = await loadStagesReportSection(fakeClient(stageTables({ application_stage_events: many })).client, route, recruiter);
  assert.equal(section.moves.length, STAGES_HISTORY_LIMIT);
  assert.equal(section.movesTruncated, true);
});
