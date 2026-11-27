// SC-009 (docs/ROADMAP.md R0): raport z preselekcji i pobranie pliku, od ocenionych CV
// i zatwierdzonej shortlisty. Natywny PostgreSQL 16/17, pełny łańcuch migracji, dwie
// fikcyjne firmy; role i RLS wykonuje baza (adapter niżej tylko tłumaczy wywołania
// klienta Data API na SQL pod rolą zalogowanego użytkownika).
//
// Sprawdza: raport zawiera właściwych kandydatów (i żadnego z obcej firmy), oceny z
// uzasadnieniem i cytatem, wyraźne oznaczenie oceny niepełnej, nieaktualnej i
// niezatwierdzonej, brak danych osobowych i surowego CV w pliku; pobranie raportu
// kandydata i pobranie raportu preselekcji (SC-009a) zapisują wpis w rejestrze
// (report_audit); obca firma, osoba spoza firmy i osoba niezalogowana nie pobiorą pliku,
// nie zostawią wpisu i nie odczytają cudzego wpisu.
// Dane wyłącznie fikcyjne. Analiza AI na Preview (klucz dostawcy) NOT RUN w tym teście:
// oceny wpisuje fikstura przez te same funkcje bazy, których używa pracownik analizy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bootMigrationDatabase, seedSyntheticPolicy } from './helpers/sc19-migration-fixture.mjs';
import { setupRankingDatabase, users } from './helpers/screening-ranking-fixture.mjs';
import { loadScreeningReport } from '../lib/screening-report-source.ts';
import { exportScreeningReport } from '../lib/screening-report-export.ts';
import { screeningReportCsv } from '../lib/screening-report.ts';
import { exportCandidateReport } from '../lib/candidate-report-export.ts';

const identifier = value => {
  if (value !== '*' && !/^[a-z_][a-z_0-9]*$/.test(value)) throw Error('Invalid test SQL identifier');
  return value === '*' ? '*' : `"${value}"`;
};
// Funkcje zwracające jedną wartość: PostgREST oddaje samą wartość, nie wiersze.
const scalarFunctions = new Set(['get_preselection_groups', 'record_candidate_report_export', 'record_screening_report_export']);
const tables = new Set(['companies', 'recruitments', 'positions', 'applications', 'candidates', 'candidate_documents',
  'screening_analysis_versions', 'screening_result_reviews', 'screening_criterion_results', 'screening_criterion_review_overrides']);
const functions = new Set(['get_screening_ranking', 'get_recruitment_shortlist', 'get_preselection_groups',
  'position_requirement_flags', 'record_candidate_report_export', 'record_screening_report_export']);

function dataApiClient(db, getUser) {
  const reads = [];
  const query = (name, args) => {
    const filters = []; const orders = [];
    let fields = '*'; let offset = 0; let limit = 1000; let single = false;
    const chain = {
      select(value) { fields = value.split(',').map(item => identifier(item.trim())).join(','); return this; },
      eq(key, value) { filters.push([key, value, false]); return this; },
      in(key, value) { filters.push([key, value, true]); return this; },
      order(key, options) { orders.push(`${identifier(key)}${options?.ascending === false ? ' desc' : ' asc'}`); return this; },
      limit(value) { limit = value; return this; },
      range(from, to) { offset = from; limit = to - from + 1; return this; },
      maybeSingle() { single = true; return this; },
      then(resolve, reject) {
        return (async () => {
          const values = []; const parameter = value => { values.push(value); return `$${values.length}`; };
          const source = args
            ? `public.${identifier(name)}(${Object.entries(args).map(([key, value]) => `${identifier(key)} => ${parameter(value)}`).join(',')})`
            : `public.${identifier(name)}`;
          const where = filters.map(([key, value, many]) => `${identifier(key)}${many ? ` = any(${parameter(value)})` : ` = ${parameter(value)}`}`).join(' and ');
          const sql = `select row_to_json(result) as row from (select ${fields} from ${source}${where ? ` where ${where}` : ''}${orders.length ? ` order by ${orders.join(',')}` : ''} limit ${parameter(limit)} offset ${parameter(offset)}) result`;
          reads.push({ name, fields });
          try {
            const rows = (await db.query(sql, values)).rows.map(item => item.row);
            if (args && scalarFunctions.has(name)) return { data: rows[0]?.[name] ?? null, error: null };
            return { data: single ? (rows[0] ?? null) : rows, error: null };
          } catch (error) { return { data: null, error: { code: error.code ?? 'TEST_ADAPTER_ERROR', message: error.message } }; }
        })().then(resolve, reject);
      },
    };
    return chain;
  };
  return {
    reads,
    auth: { async getUser() { const user = getUser(); return { data: { user }, error: null }; } },
    from(table) { if (!tables.has(table)) throw Error(`Unexpected test table ${table}`); return query(table); },
    rpc(name, args) { if (!functions.has(name)) throw Error(`Unexpected test RPC ${name}`); return query(name, args); },
  };
}

test('SC-009: raport z preselekcji i pobranie pliku na pełnym łańcuchu migracji', async t => {
  const env = await bootMigrationDatabase(t);
  const { db } = env;
  const h = await setupRankingDatabase(db, { throughMigration: null });
  await seedSyntheticPolicy(db);
  // Każda fikcyjna firma dostaje pulę analiz; limit i rozliczenie są testowane w SC-007.
  const funded = async tenant => {
    await h.asAdmin();
    await db.query('select private.sc19_grant_paid($1,$2)', [tenant.companyId, `synthetic-sc009-${tenant.companyId}`]);
    await db.query('update private.sc19_balances set available=50 where company_id=$1', [tenant.companyId]);
    return tenant;
  };
  let signedIn = { id: users.owner };
  const client = dataApiClient(db, () => signedIn);
  const as = async (userId, role = 'authenticated') => { signedIn = userId ? { id: userId } : null; await h.asUser(userId, role); };
  const audit = async () => {
    await h.asAdmin();
    return (await db.query('select company_id,recruitment_id,application_id,actor_id,export_kind,analysis_version from report_audit.candidate_report_exports order by created_at,id')).rows;
  };
  const screeningAudit = async () => {
    await h.asAdmin();
    return (await db.query('select id,company_id,recruitment_id,actor_id,actor_role,export_kind,target_size from report_audit.screening_report_exports order by created_at,id')).rows;
  };

  // Firma A: pięć zgłoszeń o różnym stanie. Firma B: jedno zgłoszenie, które nie może trafić do raportu A.
  const alpha = await h.completedApplication(await funded(await h.seed(users.owner, 'A-alpha', 5)), ['above', 'above', 'meets', 'above', 'meets']);
  const beta = await h.completedApplication(await h.candidate(alpha, 'Beta'), Array(5).fill('meets'));
  const gamma = await h.completedApplication(await h.candidate(alpha, 'Gamma'), ['meets', ...Array(4).fill('insufficient_data')]);
  const delta = await h.completedApplication(await h.candidate(alpha, 'Delta'), Array(5).fill('meets'));
  const epsilon = await h.completedApplication(await h.candidate(alpha, 'Epsilon'), Array(5).fill('meets'), null);
  const foreign = await h.completedApplication(await funded(await h.seed(users.otherOwner, 'B-zeta', 5)), Array(5).fill('above'));
  await h.asAdmin();
  await h.insert('company_members', { company_id: alpha.companyId, user_id: users.viewer, role: 'viewer' });
  await as(users.owner);
  const ids = { alpha, beta, gamma, delta, epsilon };
  const appId = name => ids[name].application.id;
  // Zatwierdzona shortlista: dwie sugestie systemu i jedna decyzja ręczna (ocena niepełna).
  await h.add(alpha, 'suggested', undefined, null, 5);
  await h.add(beta, 'suggested', undefined, null, 5);
  await h.add(gamma, 'manual');
  // CV po analizie zostało zmienione: wynik jest nieaktualny.
  await db.query('update public.candidate_documents set redacted_text=$2 where id=$1', [delta.document.id, 'Changed SQL material.']);

  let report;
  let csv;
  await t.test('raport zawiera dokładnie zgłoszenia tej rekrutacji i ich ranking', async () => {
    report = await loadScreeningReport(client, alpha.companyId, alpha.recruitment.id, '5');
    csv = screeningReportCsv(report);
    const reported = report.applications.map(item => item.ranking.application_id).sort();
    assert.deepEqual(reported, Object.keys(ids).map(appId).sort());
    assert.ok(!csv.includes(foreign.application.id), 'zgłoszenie obcej firmy nie może być w pliku');
    assert.ok(!csv.includes(foreign.companyId));
    const rank = name => report.applications.find(item => item.ranking.application_id === appId(name)).ranking;
    assert.equal(rank('alpha').rank, 1);
    assert.equal(rank('beta').rank, 2);
    assert.equal(rank('alpha').raw_score, 80);
    assert.equal(rank('beta').raw_score, 50);
    // Shortlista człowieka widoczna przy właściwych osobach.
    const shortlisted = report.applications.filter(item => item.shortlist).map(item => item.ranking.application_id).sort();
    assert.deepEqual(shortlisted, [appId('alpha'), appId('beta'), appId('gamma')].sort());
    assert.equal(report.applications.find(item => item.ranking.application_id === appId('gamma')).shortlist.source, 'manual');
    assert.equal(report.targetSize, 5);
  });

  await t.test('każda zatwierdzona ocena ma uzasadnienie i cytat z CV, a cytat pasuje do tekstu CV', async () => {
    const item = report.applications.find(entry => entry.ranking.application_id === appId('alpha'));
    assert.equal(item.criteria.length, 5);
    for (const criterion of item.criteria) {
      assert.ok(criterion.explanation && criterion.explanation.length > 0, 'uzasadnienie');
      assert.ok(criterion.evidence.length > 0, 'cytat');
      for (const quote of criterion.evidence) assert.equal(alpha.document.redacted_text.slice(quote.start, quote.end), quote.quote);
    }
    assert.deepEqual(item.criteria.map(criterion => criterion.rating), ['above', 'above', 'meets', 'above', 'meets']);
    assert.match(csv, /Synthetic fixture\./);
    assert.match(csv, /\[0–3\] SQL/);
    assert.match(csv, /Powyżej wymagań/);
    assert.match(csv, /Spełnia wymagania/);
  });

  await t.test('ocena niepełna, nieaktualna i niezatwierdzona jest wyraźnie oznaczona i nie ma w rankingu', async () => {
    const find = name => report.applications.find(entry => entry.ranking.application_id === appId(name));
    assert.equal(find('gamma').ranking.eligibility_reason, 'insufficient_evidence');
    assert.equal(find('gamma').ranking.rank, null);
    assert.equal(find('gamma').ranking.suggested_shortlist, false);
    assert.equal(find('delta').ranking.eligibility_reason, 'stale');
    assert.equal(find('delta').ranking.rank, null);
    assert.deepEqual(find('delta').criteria, [], 'nieaktualne dowody nie są publikowane');
    assert.equal(find('epsilon').ranking.eligibility_reason, 'no_human_review');
    assert.deepEqual(find('epsilon').criteria, [], 'niezatwierdzone dowody nie są publikowane');
    assert.match(csv, /Za mało ocenionych kryteriów/);
    assert.match(csv, /Wynik nieaktualny/);
    assert.match(csv, /Oczekuje na sprawdzenie przez człowieka/);
    // Decyzja ręczna przy ocenie niepełnej jest widoczna jako wybór człowieka, bez wyniku liczbowego.
    assert.match(csv, /Wybrano przez człowieka/);
  });

  await t.test('plik nie zawiera nazwisk, surowego CV ani notatek', async () => {
    for (const secret of ['PRIVATE original CV', 'Beta', 'Gamma', 'Delta', 'Epsilon']) assert.ok(!csv.includes(secret), secret);
    assert.ok(client.reads.every(read => !read.fields.includes('source_text') && !read.fields.includes('input_cv_text_snapshot')));
    // Zgłoszenia pojawiają się wyłącznie jako identyfikatory.
    assert.ok(csv.includes(appId('alpha')));
  });

  await t.test('pobranie raportu preselekcji: pełny plik CSV dla członka firmy, nagłówki bez cache', async () => {
    await as(users.owner);
    const response = await exportScreeningReport(client, alpha.companyId, alpha.recruitment.id, '5');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/csv/);
    assert.match(response.headers.get('content-disposition'), new RegExp(`skillcheck-preselekcja-${alpha.recruitment.id}\\.csv`));
    assert.match(response.headers.get('cache-control'), /no-store/);
    const body = await response.text();
    assert.ok(body.includes(appId('beta')));
    assert.ok(!body.includes(foreign.application.id));
  });

  await t.test('pobranie raportu kandydata zapisuje wpis w rejestrze (właściciel i czytelnik), z oceną i bez danych osobowych', async () => {
    const before = (await audit()).length;
    await as(users.owner);
    const route = name => ({ companyId: alpha.companyId, recruitmentId: alpha.recruitment.id, applicationId: appId(name) });
    const first = await exportCandidateReport(client, route('alpha'));
    assert.equal(first.status, 200);
    const firstBody = await first.text();
    assert.match(firstBody, /Rekrutacja/);
    assert.ok(!firstBody.includes('PRIVATE original CV'));
    await as(users.viewer);
    const second = await exportCandidateReport(client, route('beta'));
    assert.equal(second.status, 200);
    // Nieaktualny wynik też da się pobrać, ale plik mówi, że wynik może być nieaktualny.
    await as(users.owner);
    const stale = await exportCandidateReport(client, route('delta'));
    assert.equal(stale.status, 200);
    assert.match(await stale.text(), /nieaktualny/);
    const rows = (await audit()).slice(before);
    assert.deepEqual(rows.map(row => row.application_id), [appId('alpha'), appId('beta'), appId('delta')]);
    assert.deepEqual(rows.map(row => row.actor_id), [users.owner, users.viewer, users.owner]);
    for (const row of rows) {
      assert.equal(row.company_id, alpha.companyId);
      assert.equal(row.recruitment_id, alpha.recruitment.id);
      assert.equal(row.export_kind, 'candidate_report_csv');
    }
    // Rejestr trzyma tylko identyfikatory, rodzaj i wersję analizy: brak kolumn z tekstem lub nazwiskiem.
    await h.asAdmin();
    const columns = (await db.query("select column_name from information_schema.columns where table_schema='report_audit' and table_name='candidate_report_exports' order by 1")).rows.map(row => row.column_name);
    for (const column of columns) assert.doesNotMatch(column, /name|text|cv|email|note/i, column);
  });

  await t.test('obca firma, osoba spoza firmy i niezalogowany nie pobiorą plików i nie zostawią wpisu', async () => {
    const before = (await audit()).length;
    const route = { companyId: alpha.companyId, recruitmentId: alpha.recruitment.id, applicationId: appId('alpha') };
    for (const [who, status] of [[users.otherOwner, 404], [users.outsider, 404], [null, 401]]) {
      await as(who, who ? 'authenticated' : 'anon');
      const candidate = await exportCandidateReport(client, route);
      assert.equal(candidate.status, status, `raport kandydata: ${who}`);
      assert.ok(!(await candidate.text()).includes('Kurier'), 'brak treści raportu');
      const preselection = await exportScreeningReport(client, alpha.companyId, alpha.recruitment.id, '5');
      assert.equal(preselection.status, status, `raport preselekcji: ${who}`);
      assert.doesNotMatch(await preselection.text(), new RegExp(appId('alpha')));
    }
    // Firma B próbuje własną firmę z rekrutacją i zgłoszeniem firmy A.
    await as(users.otherOwner);
    const mixed = await exportCandidateReport(client, { companyId: foreign.companyId, recruitmentId: alpha.recruitment.id, applicationId: appId('alpha') });
    assert.equal(mixed.status, 404);
    assert.equal((await audit()).length, before, 'odmowa nie zapisuje wpisu');
  });

  // R0 SC-009a: luka znaleziona przez ten test (PR #623) — plik CSV raportu preselekcji nie zapisywał
  // wpisu w rejestrze — jest naprawiona migracją 20261127140000_sc009a_screening_report_export_audit.sql.
  await t.test('pobranie raportu preselekcji zapisuje wpis w rejestrze (właściciel i czytelnik), same identyfikatory', async () => {
    const before = (await screeningAudit()).length;
    const candidateBefore = (await audit()).length;
    await as(users.owner);
    const response = await exportScreeningReport(client, alpha.companyId, alpha.recruitment.id, '5');
    assert.equal(response.status, 200);
    await as(users.viewer);
    const viewer = await exportScreeningReport(client, alpha.companyId, alpha.recruitment.id, '7');
    assert.equal(viewer.status, 200);
    const rows = (await screeningAudit()).slice(before);
    assert.deepEqual(rows.map(row => [row.actor_id, row.actor_role, row.target_size]), [[users.owner, 'owner', 5], [users.viewer, 'viewer', 7]]);
    for (const row of rows) {
      assert.equal(row.company_id, alpha.companyId);
      assert.equal(row.recruitment_id, alpha.recruitment.id);
      assert.equal(row.export_kind, 'screening_report_csv');
    }
    // Raport preselekcji nie dopisuje się do dziennika raportów kandydata.
    assert.equal((await audit()).length, candidateBefore);
    // Rejestr trzyma tylko identyfikatory firmy, rekrutacji i osoby, rolę, rodzaj i rozmiar:
    // brak kolumn z tekstem, nazwiskiem ani identyfikatorem zgłoszenia lub kandydata.
    await h.asAdmin();
    const columns = (await db.query("select column_name from information_schema.columns where table_schema='report_audit' and table_name='screening_report_exports' order by ordinal_position")).rows.map(row => row.column_name);
    assert.deepEqual(columns, ['id', 'company_id', 'recruitment_id', 'actor_id', 'actor_role', 'export_kind', 'target_size', 'created_at']);
  });

  await t.test('obca firma, osoba spoza firmy i niezalogowany: brak pliku preselekcji i brak wpisu; obca rekrutacja = ta sama odmowa', async () => {
    const before = (await screeningAudit()).length;
    for (const [who, status] of [[users.otherOwner, 404], [users.outsider, 404], [null, 401]]) {
      await as(who, who ? 'authenticated' : 'anon');
      const response = await exportScreeningReport(client, alpha.companyId, alpha.recruitment.id, '5');
      assert.equal(response.status, status, `raport preselekcji: ${who}`);
      assert.equal(response.headers.get('content-disposition'), null);
    }
    const record = (company, recruitment, kind = 'screening_report_csv', size = 5) =>
      db.query('select public.record_screening_report_export($1,$2,$3,$4) as id', [company, recruitment, kind, size]);
    const forbidden = error => error.code === '42501';
    // Firma B wprost przez funkcję: cudza firma, własna firma z cudzą rekrutacją, nieistniejąca rekrutacja.
    await as(users.otherOwner);
    await assert.rejects(record(alpha.companyId, alpha.recruitment.id), forbidden);
    await assert.rejects(record(foreign.companyId, alpha.recruitment.id), forbidden);
    await assert.rejects(record(foreign.companyId, '00000000-0000-4000-8000-000000000999'), forbidden);
    await as(users.outsider);
    await assert.rejects(record(alpha.companyId, alpha.recruitment.id), forbidden);
    await as(null, 'anon');
    await assert.rejects(record(alpha.companyId, alpha.recruitment.id), forbidden);
    // Zły rodzaj albo rozmiar spoza 5–10 nie zapisuje wpisu.
    await as(users.owner);
    for (const [kind, size] of [['candidate_report_csv', 5], ['screening_report_csv', 4], ['screening_report_csv', 11], ['screening_report_csv', null]]) {
      await assert.rejects(record(alpha.companyId, alpha.recruitment.id, kind, size), error => error.code === '22023', `${kind}/${size}`);
    }
    assert.equal((await screeningAudit()).length, before, 'odmowa nie zapisuje wpisu');
  });

  await t.test('obca firma nie odczyta wpisu firmy A; dziennik zamknięty dla ról API i niezmienny', async () => {
    const entries = await screeningAudit();
    assert.ok(entries.some(row => row.company_id === alpha.companyId), 'firma A ma wpisy');
    // Firma B ma własny wpis, żeby odczyt nie był pusty z braku danych.
    await as(users.otherOwner);
    const own = await exportScreeningReport(client, foreign.companyId, foreign.recruitment.id, '5');
    assert.equal(own.status, 200);
    for (const [who, role] of [[users.otherOwner, 'authenticated'], [users.outsider, 'authenticated'], [users.viewer, 'authenticated'], [users.owner, 'authenticated'], [null, 'anon']]) {
      await as(who, role);
      await assert.rejects(db.query('select company_id, recruitment_id from report_audit.screening_report_exports'), error => error.code === '42501', `${who}`);
      await assert.rejects(db.query('select company_id from report_audit.screening_report_exports where company_id=$1', [alpha.companyId]), error => error.code === '42501');
    }
    // Przegląd firmy (SC-015-D3) też nie wydaje wpisów firmy A obcej firmie.
    await as(users.otherOwner);
    await assert.rejects(db.query('select * from public.list_company_report_exports($1)', [alpha.companyId]), error => error.code === '42501');
    await h.asAdmin();
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const exists = (await db.query('select 1 from pg_roles where rolname=$1', [role])).rows.length;
      if (!exists) continue;
      assert.equal((await db.query("select has_schema_privilege($1,'report_audit','USAGE') v", [role])).rows[0].v, false, role);
      assert.equal((await db.query("select has_table_privilege($1,'report_audit.screening_report_exports','SELECT') v", [role])).rows[0].v, false, role);
    }
    const grants = (await db.query(`select r.rolname, has_function_privilege(r.oid,'public.record_screening_report_export(uuid,uuid,text,integer)','EXECUTE') v
      from pg_roles r where r.rolname in ('anon','authenticated','screening_worker','service_role') order by 1`)).rows;
    for (const { rolname, v } of grants) assert.equal(v, rolname === 'authenticated', rolname);
    const fn = (await db.query("select prosecdef, proconfig from pg_proc where oid='public.record_screening_report_export(uuid,uuid,text,integer)'::regprocedure")).rows[0];
    assert.equal(fn.prosecdef, true);
    assert.deepEqual(fn.proconfig, ['search_path=""']);
    assert.equal((await db.query("select relrowsecurity v from pg_class where oid='report_audit.screening_report_exports'::regclass")).rows[0].v, true);
    await assert.rejects(db.query('update report_audit.screening_report_exports set target_size=6'), error => error.code === '42501');
    await assert.rejects(db.query('delete from report_audit.screening_report_exports'), error => error.code === '42501');
    await assert.rejects(db.query('truncate report_audit.screening_report_exports'), error => error.code === '42501');
    assert.equal((await screeningAudit()).length, entries.length + 1);
  });

  await t.test('rollback SC-009a: odmowa przy wpisach, potem czysto, bez zmiany sygnatury SC-010; migracja nakłada się ponownie', async () => {
    const migration = '20261127140000_sc009a_screening_report_export_audit';
    const file = name => readFile(new URL(`../supabase/${name}`, import.meta.url), 'utf8');
    const signature = async () => { await h.asAdmin(); return (await db.query('select private.erasure_schema_signature() v')).rows[0].v; };
    const installed = await signature();
    await assert.rejects(db.query(await file(`rollbacks/${migration}_down.sql`)), error => /sc009a_rollback_not_empty/.test(error.message));
    await db.query('rollback').catch(() => {});
    assert.notEqual((await db.query("select to_regprocedure('public.record_screening_report_export(uuid,uuid,text,integer)') v")).rows[0].v, null, 'odmowa nie usuwa funkcji');
    // Jedyna droga usunięcia wpisów: procedura usuwania firmy (report_audit.purge_company).
    for (const company of [alpha.companyId, foreign.companyId]) {
      await db.query('begin');
      await db.query("select set_config('report_audit.purge_company',$1,true)", [company]);
      await db.query('delete from report_audit.screening_report_exports where company_id=$1', [company]);
      await db.query('commit');
    }
    await db.query(await file(`rollbacks/${migration}_down.sql`));
    assert.equal(await signature(), installed);
    assert.equal((await db.query("select to_regclass('report_audit.screening_report_exports') v")).rows[0].v, null);
    assert.notEqual((await db.query("select to_regclass('report_audit.candidate_report_exports') v")).rows[0].v, null, 'dziennik SC-015-D zostaje');
    await db.query(await file(`rollbacks/${migration}_down.sql`));
    await db.query(await file(`migrations/${migration}.sql`));
    assert.equal(await signature(), installed);
    await as(users.owner);
    assert.equal((await exportScreeningReport(client, alpha.companyId, alpha.recruitment.id, '5')).status, 200);
    assert.equal((await screeningAudit()).length, 1);
  });
});
