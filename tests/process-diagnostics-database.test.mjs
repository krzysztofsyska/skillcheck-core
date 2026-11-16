// SC-PROCESS / #277, część A — diagnostyka rekrutacji i wskaźniki czasu w bazie.
// Natywny PostgreSQL 16/17, pełny łańcuch migracji, dwie syntetyczne firmy.
// Sprawdza: ścieżkę od formularza panelu (lib/process-diagnostics.ts) do zapisanego
// wpisu, regułę „najpierw sprawdź pięć obszarów, potem budżet", brak danych jako
// `not_measured` (nie zero), nieuprawnioną rolę, dostęp między firmami, niezmienność
// historii oraz to, że migracja i rollback nie zmieniają sygnatury inwentarza SC-010.
// Dane są fikcyjne; żadnego prawdziwego kandydata, CV ani firmy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { activeBoot, users } from './helpers/competency-active-fixture.mjs';
import { lifecycleHarness, lifecycleRules } from './helpers/erasure-lifecycle-fixture.mjs';
import {
  diagnosticAreas, diagnosticProblems, parseDiagnosticContent, parseDiagnosticForm, parseDiagnosticsState, processError, proposeDiagnosticAreas,
} from '../lib/process-diagnostics.ts';
import { describeMetrics, metricKeys } from '../lib/process-metrics.ts';

const migration = '20261112140000_sc_process_diagnostics.sql';
const code = (...codes) => error => codes.includes(error.code);
const says = (sqlstate, text) => error => error.code === sqlstate && error.message.includes(text);
const sql = name => readFile(new URL(`../supabase/${name}`, import.meta.url), 'utf8');
const functions = [
  'process_record_diagnostic(uuid,uuid,jsonb,text,text,integer)', 'process_diagnostics_state(uuid,uuid)',
  'process_recruitment_metrics(uuid,uuid)',
];

// Formularz panelu: te same nazwy pól co w diagnostic-form.tsx.
function form(areas, { channels = [], kind = 'keep_watching', recommendation = 'Obserwujemy kolejny tydzień.' } = {}) {
  const data = new FormData();
  for (const area of diagnosticAreas) {
    const [status, note = ''] = [].concat(areas[area] ?? 'not_checked');
    data.set(`area.${area}.status`, status); data.set(`area.${area}.note`, note);
  }
  for (const channel of channels) data.append('channel', channel);
  data.set('recommendationKind', kind); data.set('recommendation', recommendation);
  return parseDiagnosticForm(data);
}
const allChecked = { channels: 'ok', role_name: 'ok', tasks: 'ok', job_ad: 'ok', market: ['problem', 'Stawka poniżej ofert konkurencji w regionie.'] };

test('SC-PROCESS diagnostics: record, budget rule, not_measured, roles, tenant isolation and rollback', async t => {
  const e = await activeBoot(t, { fullChain: true });
  const { db, h, call } = e;
  const record = (companyId, recruitmentId, submission, expected) => call('public.process_record_diagnostic',
    [companyId, recruitmentId, JSON.stringify(submission.content), submission.recommendationKind, submission.recommendation, expected]);
  const state = async (companyId, recruitmentId) => parseDiagnosticsState(await call('public.process_diagnostics_state', [companyId, recruitmentId]));
  const metrics = (companyId, recruitmentId) => call('public.process_recruitment_metrics', [companyId, recruitmentId]);
  const byKey = raw => Object.fromEntries(raw.metrics.map(metric => [metric.key, metric]));
  const signature = async () => { await h.asAdmin(); return (await db.query('select private.erasure_schema_signature() v')).rows[0].v; };
  const stored = async () => { await h.asAdmin(); return (await db.query('select count(*)::int n from process.diagnostic_records')).rows[0].n; };

  // Firma A: rekrutacja z kandydatem na krótkiej liście (a.recruitment) i pusta rekrutacja bez zgłoszeń (quiet).
  const a = await e.seed();
  const b = await e.seed({ owner: users.otherOwner });
  await h.asAdmin();
  await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter'),($1,$3,'viewer')",
    [a.companyId, users.recruiter, users.viewer]);
  await h.asUser(users.owner);
  const quietPosition = await h.insert('positions', { company_id: a.companyId, title: 'Sales Ninja B2B LVL 3',
    description: 'Szukamy osoby do działu.', tasks: [], kpis: [], required_competencies: [], status: 'active' });
  // Tak jak panel (createRecruitment w app/dashboard/[companyId]/actions.ts): bez statusu, czyli `draft`,
  // bez opened_at i closed_at. Nic w aplikacji tych pól później nie zmienia.
  const quiet = await h.insert('recruitments', { company_id: a.companyId, position_id: quietPosition.id, name: 'Cicha rekrutacja' });
  assert.deepEqual([quiet.status, quiet.opened_at, quiet.closed_at], ['draft', null, null]);
  await h.asAdmin();
  await db.query("update public.recruitments set created_at = now() - interval '20 days 1 hour' where id=$1", [quiet.id]);
  const signatureInstalled = await signature();

  await t.test('installs outside the SC-010 inventory: schema closed to API roles, no link into public/private', async () => {
    await h.asAdmin();
    assert.equal((await db.query("select count(*)::int n from pg_namespace where nspname='process'")).rows[0].n, 1,
      `${migration} must be part of the checked-in chain`);
    const tables = (await db.query(`select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='process' and c.relkind='r' order by 1`)).rows;
    assert.deepEqual(tables, [{ relname: 'diagnostic_records', relrowsecurity: true }]);
    assert.equal((await db.query("select count(*)::int n from pg_policies where schemaname='process'")).rows[0].n, 0, 'deny by default: no policies');
    // Żaden więz ze schematu `process` nie wskazuje na public/private (to zmieniłoby sygnaturę SC-010).
    assert.equal((await db.query(`select count(*)::int n from pg_constraint k
      join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace
      join pg_class f on f.oid=k.confrelid join pg_namespace fn on fn.oid=f.relnamespace
      where n.nspname='process' and fn.nspname<>'process'`)).rows[0].n, 0);
    // Tabela nie ma kolumny wskazującej kandydata ani zgłoszenie.
    const columns = (await db.query(`select column_name from information_schema.columns
      where table_schema='process' and table_name='diagnostic_records' order by 1`)).rows.map(row => row.column_name);
    assert.deepEqual(columns, ['company_id', 'content', 'created_at', 'created_by', 'id', 'inflow_snapshot', 'recommendation',
      'recommendation_kind', 'record_no', 'recruitment_id']);
    // service_role zwykle nie istnieje w klastrze testowym, a role są wspólne dla całego klastra: inne zestawy
    // wymagają, żeby jej nie było. Dlatego powstaje tylko wewnątrz transakcji, która jest zawsze wycofywana.
    // Migracja odbiera jej prawa, gdy istnieje; bez grantu dla PUBLIC rola utworzona później też ich nie ma.
    const serviceRoleBefore = (await db.query("select count(*)::int n from pg_roles where rolname='service_role'")).rows[0].n;
    await db.exec('begin');
    try {
    if ((await db.query("select count(*)::int n from pg_roles where rolname='service_role'")).rows[0].n === 0) await db.exec('create role service_role nologin');
    for (const role of ['anon', 'authenticated', 'screening_worker', 'service_role']) {
      assert.equal((await db.query("select has_schema_privilege($1,'process','USAGE') v", [role])).rows[0].v, false, role);
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        assert.equal((await db.query("select has_table_privilege($1,'process.diagnostic_records',$2) v", [role, privilege])).rows[0].v, false, `${role} ${privilege}`);
      }
      for (const fn of functions) {
        assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') v", [role, `public.${fn}`])).rows[0].v,
          role === 'authenticated', `${role} ${fn}`);
      }
    }
    } finally { await db.exec('rollback'); }
    assert.equal((await db.query("select count(*)::int n from pg_roles where rolname='service_role'")).rows[0].n, serviceRoleBefore, 'the cluster-wide role list is left as it was');
    const definer = (await db.query(`select p.proname, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('process_record_diagnostic','process_diagnostics_state','process_recruitment_metrics') order by 1`)).rows;
    assert.equal(definer.length, functions.length);
    for (const row of definer) {
      assert.equal(row.prosecdef, true, row.proname);
      assert.deepEqual(row.proconfig, ['search_path=""'], row.proname);
    }
    await h.asUser(users.owner);
    await assert.rejects(db.query('select * from process.diagnostic_records'), code('42501'));
  });

  await t.test('positive path: panel form -> RPC -> stored, versioned record with an inflow snapshot of counts only', async () => {
    await h.asUser(users.owner);
    const empty = await state(a.companyId, quiet.id);
    assert.equal(empty.can_edit, true);
    assert.equal(empty.latest_record_no, 0);
    assert.deepEqual(empty.history, []);
    assert.equal(empty.inflow.total, 0);
    assert.equal(empty.inflow.days_open, 20);
    assert.equal(empty.inflow.status, 'draft', 'a panel-created recruitment is a draft and is still judged');
    assert.equal(empty.inflow.start_source, 'created_at');
    assert.equal(empty.inflow.last_application_at, null);
    assert.deepEqual(empty.inflow.weekly.map(week => week.count), [0, 0, 0, 0, 0, 0, 0, 0]);

    // Podpowiedź liczona z tego, co zwróciła baza, i z profilu stanowiska.
    const proposal = proposeDiagnosticAreas({ status: empty.inflow.status, daysOpen: empty.inflow.days_open,
      applicationsTotal: empty.inflow.total, applicationsLast14Days: empty.inflow.last_14_days,
      title: quietPosition.title, description: quietPosition.description, tasks: quietPosition.tasks });
    assert.equal(proposal.level, 'none');
    assert.equal(proposal.levelText, 'Przez 20 dni nie wpłynęło żadne CV.');
    assert.deepEqual(proposal.hints.map(hint => hint.area), ['channels', 'role_name', 'tasks', 'job_ad', 'market']);

    const first = form({ channels: ['problem', '  Ogłoszenie tylko na stronie firmy.\t'], role_name: ['problem', 'Nazwa z wewnętrznym oznaczeniem.'], tasks: 'ok' },
      { channels: ['other', 'company_site'], kind: 'fix_areas', recommendation: '  Opublikować na portalu i uprościć nazwę.  ' });
    assert.deepEqual(diagnosticProblems(first), []);
    assert.equal(await record(a.companyId, quiet.id, first, 0), 1);

    // Drugi wpis dopisuje rekruter; pierwszy zostaje bez zmian.
    await h.asUser(users.recruiter);
    const second = form({ ...allChecked, channels: 'ok' }, { channels: ['job_board', 'company_site'] });
    assert.equal(await record(a.companyId, quiet.id, second, 1), 2);

    const now = await state(a.companyId, quiet.id);
    assert.equal(now.latest_record_no, 2);
    assert.deepEqual(now.history.map(row => row.record_no), [2, 1]);
    const saved = now.history[1];
    assert.deepEqual(saved.content, first.content, 'the stored record equals the canonical form content');
    assert.equal(saved.content.areas.channels.note, 'Ogłoszenie tylko na stronie firmy.', 'notes are trimmed');
    assert.deepEqual(saved.content.channelsUsed, ['company_site', 'other'], 'channels are stored in catalogue order');
    assert.equal(saved.content.areas.job_ad.status, 'not_checked');
    assert.equal(saved.recommendation_kind, 'fix_areas');
    assert.equal(saved.recommendation, 'Opublikować na portalu i uprościć nazwę.');
    assert.deepEqual(saved.inflow_snapshot, { total: 0, last_14_days: 0, last_30_days: 0, days_open: 20 });
    await h.asAdmin();
    const row = (await db.query('select created_by, inflow_snapshot from process.diagnostic_records where id=$1', [saved.id])).rows[0];
    assert.equal(row.created_by, users.owner);
    assert.deepEqual(Object.keys(row.inflow_snapshot).sort(), ['days_open', 'last_14_days', 'last_30_days', 'total'], 'numbers only: no ids, no dates');
  });

  await t.test('budget rule: "change budget" is refused while any of the five areas is not checked', async () => {
    await h.asUser(users.owner);
    const before = await stored();
    await h.asUser(users.owner);
    for (const missing of diagnosticAreas) {
      const submission = form({ ...allChecked, [missing]: 'not_checked' }, { kind: 'change_budget', recommendation: 'Zwiększyć budżet ogłoszeń.' });
      assert.match(diagnosticProblems(submission).join(' '), /Zanim zalecisz zmianę budżetu, sprawdź wszystkie obszary/, `${missing}: the panel says so first`);
      await assert.rejects(record(a.companyId, quiet.id, submission, 2), error => {
        assert.ok(says('22023', `process_budget_requires_full_check:${missing}`)(error), `${missing}: ${error.message}`);
        assert.match(processError(error), /Zanim zalecisz zmianę budżetu, sprawdź wszystkie obszary\. Jeszcze nie sprawdzone: /);
        return true;
      });
    }
    await assert.rejects(record(a.companyId, quiet.id, form({ channels: 'ok' }, { kind: 'change_budget' }), 2),
      says('22023', 'process_budget_requires_full_check:job_ad,market,role_name,tasks'));
    assert.equal(await stored(), before, 'nothing was stored');
    // Ta sama niepełna lista z innym zaleceniem jest dozwolona — reguła dotyczy tylko budżetu.
    await h.asUser(users.owner);
    assert.equal(await record(a.companyId, quiet.id, form({ channels: 'ok' }), 2), 3);
    // Po sprawdzeniu wszystkich pięciu obszarów (także z wynikiem „do poprawy") budżet można zalecić.
    assert.equal(await record(a.companyId, quiet.id, form(allChecked, { kind: 'change_budget', recommendation: 'Zwiększyć budżet ogłoszeń o jedną publikację.' }), 3), 4);
    assert.equal((await state(a.companyId, quiet.id)).history[0].recommendation_kind, 'change_budget');
    // Druga linia obrony: więz tabeli, niezależny od funkcji zapisu.
    await h.asAdmin();
    await assert.rejects(db.query(`insert into process.diagnostic_records(company_id,recruitment_id,record_no,content,recommendation_kind,recommendation,inflow_snapshot,created_by)
      select company_id,recruitment_id,99,jsonb_set(content,'{areas,tasks,status}','"not_checked"'),'change_budget','x','{}',created_by
        from process.diagnostic_records where record_no=4 and recruitment_id=$1`, [quiet.id]), code('23514'));
    // Więz nie zależy od kształtu `content`: brak `areas`, brak obszaru albo brak statusu też blokuje budżet.
    const four = { channels: { status: 'ok' }, role_name: { status: 'ok' }, tasks: { status: 'ok' }, job_ad: { status: 'ok' } };
    for (const content of ['{}', '{"areas":{}}', '{"areas":null}', JSON.stringify({ areas: four }),
      JSON.stringify({ areas: { ...four, market: {} } }), JSON.stringify({ areas: { ...four, market: { status: 'later' } } })]) {
      await assert.rejects(db.query(`insert into process.diagnostic_records(company_id,recruitment_id,record_no,content,recommendation_kind,recommendation,inflow_snapshot,created_by)
        values($1,$2,99,$3::jsonb,'change_budget','x','{}',$4)`, [a.companyId, quiet.id, content, users.owner]), code('23514'), content);
    }
  });

  await t.test('validation: incomplete or malformed diagnostics are refused and say what is missing', async () => {
    await h.asUser(users.owner);
    const base = form(allChecked).content;
    const send = (content, kind = 'keep_watching', recommendation = 'Uzasadnienie.') =>
      call('public.process_record_diagnostic', [a.companyId, quiet.id, JSON.stringify(content), kind, recommendation, 4]);
    const withArea = (area, item) => ({ ...base, areas: { ...base.areas, [area]: item } });
    await assert.rejects(send(withArea('job_ad', { status: 'problem', note: '  ' })), error => {
      assert.ok(says('22023', 'process_diagnostic_incomplete:job_ad.note')(error));
      assert.equal(processError(error), 'Obszar „Ogłoszenie”: opisz krótko, co jest do poprawy.');
      return true;
    });
    await assert.rejects(send(form({ channels: 'ok', role_name: 'ok', tasks: 'ok', job_ad: 'ok', market: 'ok' }).content, 'fix_areas'),
      says('22023', 'process_diagnostic_incomplete:fix_areas.problem'));
    await assert.rejects(send(base, 'keep_watching', ' \n '), says('22023', 'process_diagnostic_incomplete:recommendation'));
    const { market: _dropped, ...fourAreas } = base.areas;
    for (const invalid of [[], 'tekst', {}, { areas: [] }, { ...base, areas: fourAreas }, { ...base, areas: { ...base.areas, budget: { status: 'ok', note: '' } } },
      withArea('tasks', { status: 'maybe', note: '' }), withArea('tasks', { status: 'ok', note: 'x'.repeat(501) }), withArea('tasks', { status: 'ok', note: 7 }),
      withArea('tasks', 'ok'), { ...base, channelsUsed: ['job_board', 'job_board'] }, { ...base, channelsUsed: ['telepatia'] }, { ...base, channelsUsed: 'job_board' }]) {
      await assert.rejects(send(invalid), says('22023', 'process_diagnostic_invalid'), JSON.stringify(invalid).slice(0, 80));
    }
    for (const kind of ['cut_budget', '', null]) await assert.rejects(send(base, kind), says('22023', 'process_diagnostic_invalid'));
    // Dane kontaktowe w wolnym tekście: baza odmawia także wtedy, gdy ktoś ominie panel.
    for (const text of ['Pisać na jan.kowalski@example.com', 'Kandydat: 600 700 800', 'tel. +48 600-700-800']) {
      await assert.rejects(send(withArea('tasks', { status: 'ok', note: text })), error => {
        assert.ok(says('22023', 'process_diagnostic_contact_data:tasks')(error), text);
        assert.match(processError(error), /^Pole „Zadania — notatka”: treść wygląda na adres e-mail lub numer telefonu/);
        return true;
      });
      await assert.rejects(send(base, 'keep_watching', text), says('22023', 'process_diagnostic_contact_data:recommendation'));
      assert.throws(() => parseDiagnosticContent(withArea('tasks', { status: 'ok', note: text })), /adres e-mail lub numer telefonu/, 'the panel refuses the same text');
    }
    await h.asAdmin();
    for (const [text, expected] of [['Widełki 8 000–9 500 zł, konkurencja 10 000 - 12 000 zł.', false], ['Ogłoszenie wygasło 2026-11-01.', false],
      ['a@b.pl', true], ['600700800', true], [null, false]]) {
      assert.equal((await db.query('select process.has_contact_data($1) v', [text])).rows[0].v, expected, String(text));
    }
    await h.asUser(users.owner);
    await assert.rejects(send(base, 'keep_watching', 'x'.repeat(1001)), says('22023', 'process_diagnostic_invalid'));
    // Nieaktualny numer ostatniego wpisu (druga karta) — konflikt, bez zapisu.
    for (const stale of [0, 3, 5]) {
      await assert.rejects(call('public.process_record_diagnostic', [a.companyId, quiet.id, JSON.stringify(base), 'keep_watching', 'Uzasadnienie.', stale]),
        says('PT409', 'process_record_changed'));
    }
    await assert.rejects(call('public.process_record_diagnostic', [a.companyId, quiet.id, JSON.stringify(base), 'keep_watching', 'Uzasadnienie.', -1]),
      says('22023', 'process_diagnostic_invalid'));
    assert.equal((await state(a.companyId, quiet.id)).latest_record_no, 4, 'refused calls changed nothing');
  });

  await t.test('missing data is not_measured, never zero; post-hire metrics are not faked', async () => {
    await h.asUser(users.owner);
    const raw = await metrics(a.companyId, quiet.id);
    assert.equal(raw.definition_version, 'process-metrics-v1');
    assert.equal(raw.start_source, 'created_at');
    assert.deepEqual(raw.metrics.map(metric => metric.key), [...metricKeys], 'the database returns the whole catalogue, in order');
    assert.deepEqual(Object.fromEntries(raw.metrics.map(metric => [metric.key, metric.reason])), {
      days_to_first_application: 'no_data', days_to_first_shortlist: 'no_data', days_to_first_next_stage_decision: 'no_data',
      median_days_application_to_decision: 'no_data', recruitment_duration_days: 'recruitment_not_closed', days_to_hire: 'requires_hire_date',
      probation_pass_rate: 'requires_post_hire_observations', retention_rate: 'requires_post_hire_observations',
    });
    for (const metric of raw.metrics) {
      assert.equal(metric.state, 'not_measured', metric.key);
      assert.equal(metric.value, null, `${metric.key}: no value, not 0`);
    }
    assert.equal(byKey(raw).days_to_first_application.scope.rows, 0);
    for (const metric of describeMetrics(raw)) {
      assert.equal(metric.state, 'not_measured', metric.key);
      assert.equal(metric.value, null, metric.key);
      assert.match(metric.display, /^Brak pomiaru: /, metric.key);
      assert.ok(metric.definition.length > 20 && metric.dataScope.length > 20, `${metric.key}: definition and data scope`);
    }
  });

  await t.test('measured metrics: values, data scope, a real zero, a negative value and too few rows', async () => {
    // Rekrutacja A: początek 10 dni temu, pierwsze CV 8 dni temu, pierwszy wpis krótkiej listy przed chwilą
    // (wpisy krótkiej listy są niezmienne, więc ich daty nie da się cofnąć nawet w teście).
    await h.asAdmin();
    await db.query("update public.recruitments set created_at = now() - interval '10 days' where id=$1", [a.recruitment.id]);
    await db.query("update public.applications set created_at = now() - interval '8 days' where id=$1", [a.application.id]);
    await h.asUser(users.owner);
    let m = byKey(await metrics(a.companyId, a.recruitment.id));
    assert.deepEqual([m.days_to_first_application.state, Number(m.days_to_first_application.value)], ['measured', 2]);
    assert.equal(m.days_to_first_application.scope.source, 'applications');
    assert.equal(m.days_to_first_application.scope.rows, 1);
    assert.ok(m.days_to_first_application.scope.period_from && m.days_to_first_application.scope.period_to, 'the period used is reported');
    assert.deepEqual([m.days_to_first_shortlist.state, Number(m.days_to_first_shortlist.value)], ['measured', 10]);
    assert.equal(m.days_to_first_shortlist.scope.rows, 1);
    assert.deepEqual([m.days_to_first_next_stage_decision.state, m.days_to_first_next_stage_decision.value, m.days_to_first_next_stage_decision.reason],
      ['not_measured', null, 'no_data'], 'no decision recorded yet');
    assert.deepEqual([m.recruitment_duration_days.state, m.recruitment_duration_days.reason], ['not_measured', 'recruitment_not_closed']);

    // Jedna decyzja rekrutera: czas do pierwszej decyzji jest mierzony, mediana jeszcze nie (za mało wierszy).
    const decide = (application, decision) => call('public.set_application_human_decision',
      [a.companyId, a.recruitment.id, application.id, decision, 'Syntetyczne uzasadnienie decyzji rekrutera.']);
    await decide(a.application, 'on_hold');
    m = byKey(await metrics(a.companyId, a.recruitment.id));
    assert.equal(m.days_to_first_next_stage_decision.state, 'not_measured', '"on hold" is not a next-stage decision');
    await decide(a.application, 'next_stage');
    m = byKey(await metrics(a.companyId, a.recruitment.id));
    assert.deepEqual([m.days_to_first_next_stage_decision.state, Number(m.days_to_first_next_stage_decision.value)], ['measured', 10]);
    assert.deepEqual([m.median_days_application_to_decision.state, m.median_days_application_to_decision.value, m.median_days_application_to_decision.reason],
      ['not_measured', null, 'too_few_rows']);
    assert.deepEqual([m.median_days_application_to_decision.scope.rows, m.median_days_application_to_decision.scope.population, m.median_days_application_to_decision.scope.min_rows], [1, 1, 3]);
    assert.match(describeMetrics({ definition_version: 'process-metrics-v1', metrics: Object.values(m) })
      .find(metric => metric.key === 'median_days_application_to_decision').display, /za mało danych/);

    // Trzy zgłoszenia z decyzją (8, 6 i 4 dni po zgłoszeniu) + jedno bez decyzji: mediana 6 dni z 3 wierszy na 4.
    const second = await h.candidate(a), third = await h.candidate(a), undecided = await h.candidate(a);
    await h.asAdmin();
    await db.query("update public.applications set created_at = now() - interval '6 days' where id=$1", [second.application.id]);
    await db.query("update public.applications set created_at = now() - interval '4 days' where id=$1", [third.application.id]);
    await h.asUser(users.owner);
    await decide(second.application, 'closed');
    await decide(third.application, 'on_hold');
    m = byKey(await metrics(a.companyId, a.recruitment.id));
    assert.deepEqual([m.median_days_application_to_decision.state, Number(m.median_days_application_to_decision.value), m.median_days_application_to_decision.reason],
      ['measured', 6, null]);
    assert.deepEqual([m.median_days_application_to_decision.scope.rows, m.median_days_application_to_decision.scope.population], [3, 4]);
    assert.ok(undecided.application.id);

    // Zamknięta rekrutacja z datą otwarcia: czas trwania liczony od otwarcia.
    await h.asAdmin();
    await db.query("update public.recruitments set opened_at = now() - interval '9 days', closed_at = now() - interval '1 day', status='closed' where id=$1", [a.recruitment.id]);
    await h.asUser(users.owner);
    const closed = await metrics(a.companyId, a.recruitment.id);
    assert.equal(closed.start_source, 'opened_at');
    assert.deepEqual([byKey(closed).recruitment_duration_days.state, Number(byKey(closed).recruitment_duration_days.value)], ['measured', 8]);
    assert.equal(Number(byKey(closed).days_to_first_application.value), 1, 'now measured from the opening date');

    // Prawdziwe zero i wartość ujemna są POMIARAMI — odróżnialnymi od braku pomiaru.
    await h.asAdmin();
    await db.query('update public.applications set created_at = r.opened_at from public.recruitments r where r.id=$1 and applications.id=$2', [a.recruitment.id, a.application.id]);
    await h.asUser(users.owner);
    const zero = describeMetrics(await metrics(a.companyId, a.recruitment.id)).find(metric => metric.key === 'days_to_first_application');
    assert.deepEqual([zero.state, zero.value, zero.reason, zero.display], ['measured', 0, null, '0 dni']);
    await h.asAdmin();
    await db.query("update public.applications set created_at = r.opened_at - interval '2 days' from public.recruitments r where r.id=$1 and applications.id=$2", [a.recruitment.id, a.application.id]);
    await h.asUser(users.owner);
    const negative = describeMetrics(await metrics(a.companyId, a.recruitment.id)).find(metric => metric.key === 'days_to_first_application');
    assert.deepEqual([negative.state, negative.value], ['measured', -2]);
    // Wskaźniki po zatrudnieniu pozostają brakiem pomiaru także przy pełnych danych rekrutacji.
    const full = byKey(await metrics(a.companyId, a.recruitment.id));
    for (const key of ['days_to_hire', 'probation_pass_rate', 'retention_rate']) assert.deepEqual([full[key].state, full[key].value], ['not_measured', null], key);
  });

  await t.test('inflow figures are live aggregates of existing applications', async () => {
    await h.asUser(users.owner);
    const position = await h.insert('positions', { company_id: a.companyId, title: 'Księgowy', tasks: ['Księgowanie faktur'], kpis: [], required_competencies: [], status: 'active' });
    const recruitment = await h.insert('recruitments', { company_id: a.companyId, position_id: position.id, name: 'Rekrutacja z napływem', status: 'open' });
    const tenant = { owner: users.owner, companyId: a.companyId, position, recruitment };
    const ages = [1, 3, 10, 20, 40];
    for (const age of ages) {
      const candidate = await h.candidate(tenant);
      await h.asAdmin();
      await db.query("update public.applications set created_at = now() - make_interval(days => $2::int, hours => 1) where id=$1", [candidate.application.id, age]);
    }
    await db.query("update public.recruitments set created_at = now() - interval '45 days 1 hour' where id=$1", [recruitment.id]);
    await h.asUser(users.viewer);
    const seen = await state(a.companyId, recruitment.id);
    assert.equal(seen.can_edit, false, 'a viewer reads the same figures');
    const { inflow } = seen;
    assert.deepEqual([inflow.total, inflow.last_7_days, inflow.last_14_days, inflow.last_30_days, inflow.days_open], [5, 2, 3, 4, 45]);
    assert.deepEqual(inflow.weekly, [2, 1, 1, 0, 0, 1, 0, 0].map((count, weeks_ago) => ({ weeks_ago, count })));
    assert.equal(proposeDiagnosticAreas({ status: inflow.status, daysOpen: inflow.days_open, applicationsTotal: inflow.total,
      applicationsLast14Days: inflow.last_14_days, title: position.title, description: position.description, tasks: position.tasks }).level, 'low');
    // Rekrutacja firmy B ma własne liczby.
    await h.asUser(users.otherOwner);
    assert.equal((await state(b.companyId, b.recruitment.id)).inflow.total, 1);
  });

  await t.test('unauthorised role: viewer reads but cannot record; outsiders and anon get nothing', async () => {
    const submission = form(allChecked);
    await h.asUser(users.viewer);
    const seen = await state(a.companyId, quiet.id);
    assert.equal(seen.can_edit, false);
    assert.equal(seen.history.length, 4, 'a viewer reads the history');
    assert.equal((await metrics(a.companyId, quiet.id)).metrics.length, metricKeys.length);
    await assert.rejects(record(a.companyId, quiet.id, submission, 4), error => {
      assert.ok(says('42501', 'process_forbidden')(error));
      assert.equal(processError(error), 'Masz dostęp tylko do odczytu.');
      return true;
    });
    for (const outsider of [users.outsider, null]) {
      await h.asUser(outsider);
      await assert.rejects(state(a.companyId, quiet.id), code('42501'));
      await assert.rejects(metrics(a.companyId, quiet.id), code('42501'));
      await assert.rejects(record(a.companyId, quiet.id, submission, 4), code('42501'));
    }
    await h.asUser(null, 'anon');
    for (const [name, args] of [['process_diagnostics_state', [a.companyId, quiet.id]], ['process_recruitment_metrics', [a.companyId, quiet.id]],
      ['process_record_diagnostic', [a.companyId, quiet.id, JSON.stringify(submission.content), 'keep_watching', 'x', 4]]]) {
      await assert.rejects(call(`public.${name}`, args), code('42501'), `anon ${name}`);
    }
    await h.asUser(users.owner);
    assert.equal((await state(a.companyId, quiet.id)).latest_record_no, 4, 'refused calls changed nothing');
  });

  await t.test('cross-company: company B cannot read or write anything of company A', async () => {
    const submission = form(allChecked);
    await h.asUser(users.otherOwner);
    await assert.rejects(state(a.companyId, quiet.id), code('42501'));
    await assert.rejects(metrics(a.companyId, quiet.id), code('42501'));
    await assert.rejects(record(a.companyId, quiet.id, submission, 4), code('42501'));
    // Rekrutacja firmy A pod własnym company_id też nie przechodzi.
    await assert.rejects(state(b.companyId, quiet.id), code('42501'));
    await assert.rejects(metrics(b.companyId, a.recruitment.id), code('42501'));
    await assert.rejects(record(b.companyId, quiet.id, submission, 0), code('42501'));
    // Własne dane firmy B działają i nie mieszają się z firmą A.
    assert.equal(await record(b.companyId, b.recruitment.id, submission, 0), 1);
    const own = await state(b.companyId, b.recruitment.id);
    assert.deepEqual(own.history.map(row => row.record_no), [1]);
    await h.asUser(users.owner);
    await assert.rejects(state(a.companyId, b.recruitment.id), code('42501'));
    assert.equal((await state(a.companyId, quiet.id)).history.length, 4);
    await h.asAdmin();
    assert.equal((await db.query('select count(*)::int n from process.diagnostic_records where company_id=$1', [b.companyId])).rows[0].n, 1);
  });

  await t.test('erasure freeze hides candidate data from security-definer aggregates', async () => {
    const lifecycle = lifecycleHarness(h);
    // Właściciel ma limit jednej firmy: użyj już istniejącej, izolowanej firmy B.
    const f = b;
    await h.asUser(f.owner);
    await lifecycle.policy(f, 0, lifecycleRules);
    f.resolutionId = await lifecycle.resolve(f, [f.candidate.id]);
    const before = await state(f.companyId, f.recruitment.id);
    assert.ok(before.inflow.total > 0, 'the fixture has an application');
    const beforeMetrics = byKey(await metrics(f.companyId, f.recruitment.id));
    assert.equal(beforeMetrics.days_to_first_application.state, 'measured');
    await lifecycle.freeze(f);
    await h.asUser(f.owner);
    const after = await state(f.companyId, f.recruitment.id);
    assert.equal(after.inflow.total, 0, 'the frozen candidate does not contribute to counts');
    assert.equal(after.inflow.first_application_at, null, 'no first-application timestamp is disclosed');
    assert.equal(after.inflow.last_application_at, null, 'no last-application timestamp is disclosed');
    const afterMetrics = byKey(await metrics(f.companyId, f.recruitment.id));
    assert.equal(afterMetrics.days_to_first_application.state, 'not_measured');
    assert.equal(afterMetrics.days_to_first_application.value, null);
    assert.equal(afterMetrics.days_to_first_application.scope.rows, 0);
  });

  await t.test('history is append-only for every role, including the table owner', async () => {
    await h.asAdmin();
    await assert.rejects(db.query("update process.diagnostic_records set recommendation='zmienione' where recruitment_id=$1", [quiet.id]), says('42501', 'process_history_immutable'));
    await assert.rejects(db.query("update process.diagnostic_records set recommendation_kind='keep_watching' where recruitment_id=$1 and record_no=4", [quiet.id]), says('42501', 'process_history_immutable'));
    await assert.rejects(db.query('delete from process.diagnostic_records where recruitment_id=$1', [quiet.id]), says('42501', 'process_history_immutable'));
  });

  await t.test('rollback refuses while records exist, then removes everything; the SC-010 signature never moves', async () => {
    assert.equal(await signature(), signatureInstalled, 'recording diagnostics does not touch the inventory');
    const down = await sql('rollbacks/20261112140000_sc_process_diagnostics_down.sql');
    await assert.rejects(db.exec(down), says('55000', 'sc_process_rollback_not_empty'));
    await db.exec('rollback');
    assert.equal(await stored() > 0, true);
    // Jedyna droga usunięcia: uprzywilejowana procedura z jawnym wskazaniem firmy, tylko dla tej firmy.
    await db.exec('begin');
    await db.query("select set_config('process.purge_company',$1,true)", [a.companyId]);
    await assert.rejects(db.query('delete from process.diagnostic_records where company_id=$1', [b.companyId]), says('42501', 'process_history_immutable'));
    await db.exec('rollback');
    for (const companyId of [a.companyId, b.companyId]) {
      await db.exec('begin');
      await db.query("select set_config('process.purge_company',$1,true)", [companyId]);
      await db.query('delete from process.diagnostic_records where company_id=$1', [companyId]);
      await db.exec('commit');
    }
    await db.exec(down);
    assert.equal((await db.query("select to_regnamespace('process') v")).rows[0].v, null);
    assert.equal((await db.query("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('process_record_diagnostic','process_diagnostics_state','process_recruitment_metrics')")).rows[0].n, 0);
    // Porównanie przed/po, bez przypiętej wartości: sygnatura bez migracji = sygnatura z migracją.
    assert.equal(await signature(), signatureInstalled, 'the schema without the migration has the same inventory signature');
    await db.exec(down); // idempotentny
    await db.exec(await sql(`migrations/${migration}`));
    assert.equal(await signature(), signatureInstalled, 'the migration leaves the inventory signature unchanged');
    await assert.rejects(db.exec(await sql(`migrations/${migration}`)), says('55000', 'sc_process_already_installed'));
    await db.exec('rollback');
    await h.asUser(users.owner);
    assert.equal((await state(a.companyId, quiet.id)).latest_record_no, 0, 're-installed and usable');
  });
});
