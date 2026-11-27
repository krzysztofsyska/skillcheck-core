// SC-009 (docs/ROADMAP.md R0): raport z preselekcji i pobranie pliku, od ocenionych CV
// i zatwierdzonej shortlisty. Natywny PostgreSQL 16/17, pełny łańcuch migracji, dwie
// fikcyjne firmy; role i RLS wykonuje baza (adapter niżej tylko tłumaczy wywołania
// klienta Data API na SQL pod rolą zalogowanego użytkownika).
//
// Sprawdza: raport zawiera właściwych kandydatów (i żadnego z obcej firmy), oceny z
// uzasadnieniem i cytatem, wyraźne oznaczenie oceny niepełnej, nieaktualnej i
// niezatwierdzonej, brak danych osobowych i surowego CV w pliku; pobranie raportu
// kandydata zapisuje wpis w rejestrze (report_audit); obca firma, osoba spoza firmy i
// osoba niezalogowana nie pobiorą pliku i nie zostawią wpisu.
// Dane wyłącznie fikcyjne. Analiza AI na Preview (klucz dostawcy) NOT RUN w tym teście:
// oceny wpisuje fikstura przez te same funkcje bazy, których używa pracownik analizy.
import test from 'node:test';
import assert from 'node:assert/strict';
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
const scalarFunctions = new Set(['get_preselection_groups', 'record_candidate_report_export']);
const tables = new Set(['companies', 'recruitments', 'positions', 'applications', 'candidates', 'candidate_documents',
  'screening_analysis_versions', 'screening_result_reviews', 'screening_criterion_results', 'screening_criterion_review_overrides']);
const functions = new Set(['get_screening_ranking', 'get_recruitment_shortlist', 'get_preselection_groups',
  'position_requirement_flags', 'record_candidate_report_export']);

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

  // Luka znaleziona przez ten test: plik CSV raportu preselekcji (całej rekrutacji) nie zapisuje wpisu w rejestrze,
  // w przeciwieństwie do raportu kandydata. Naprawa wymaga nowej funkcji i migracji (L3), więc jest osobnym krokiem.
  await t.test('pobranie raportu preselekcji zapisuje wpis w rejestrze', { todo: 'luka: eksport CSV preselekcji nie ma wpisu w rejestrze; osobny krok L3' }, async () => {
    const before = (await audit()).length;
    await as(users.owner);
    const response = await exportScreeningReport(client, alpha.companyId, alpha.recruitment.id, '5');
    assert.equal(response.status, 200);
    assert.equal((await audit()).length, before + 1);
  });
});
