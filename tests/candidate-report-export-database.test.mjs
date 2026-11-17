// SC-015-D — dziennik eksportu raportu kandydata w bazie.
// Natywny PostgreSQL 16/17, pełny łańcuch migracji, dwie syntetyczne firmy.
// Sprawdza: wpis z actor = auth.uid(), dostęp czytelnika, izolację firm (ten sam
// błąd dla obcego i nieistniejącego rekordu), odmowę po wycofaniu zgłoszenia
// i przy zamrożeniu danych, niezmienność dziennika, zamknięty schemat oraz to,
// że migracja i rollback nie zmieniają sygnatury inwentarza SC-010.
// Dane są fikcyjne; żadnego prawdziwego kandydata, CV ani firmy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { bootMigrationDatabase } from './helpers/sc19-migration-fixture.mjs';
import { setupRankingDatabase, users } from './helpers/screening-ranking-fixture.mjs';

const migration = '20261116120000_sc015d_candidate_report_export_audit.sql';
const sql = name => readFile(new URL(`../supabase/${name}`, import.meta.url), 'utf8');
const code = (...codes) => error => codes.includes(error.code);

test('SC-015-D: audyt eksportu, uprawnienia, wycofanie, izolacja firm i rollback', async t => {
  const env = await bootMigrationDatabase(t);
  const { db } = env;
  const h = await setupRankingDatabase(db, { throughMigration: null });
  const record = (f, kind = 'candidate_report_csv', version = 1, overrides = {}) => db.query(
    'select public.record_candidate_report_export($1,$2,$3,$4,$5) as id',
    [overrides.company ?? f.companyId, overrides.recruitment ?? f.recruitment.id, overrides.application ?? f.application.id, kind, version],
  ).then(result => result.rows[0].id);
  const entries = async () => { await h.asAdmin(); return (await db.query('select * from report_audit.candidate_report_exports order by created_at, id')).rows; };
  const signature = async () => { await h.asAdmin(); return (await db.query('select private.erasure_schema_signature() v')).rows[0].v; };

  const a = await h.seed(users.owner, 'A');
  const b = await h.seed(users.otherOwner, 'B');
  await h.asAdmin();
  await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'viewer')", [a.companyId, users.viewer]);

  await t.test('właściciel i czytelnik zapisują wpis z własnym actor_id', async () => {
    await h.asUser(users.owner);
    const first = await record(a, 'candidate_report_csv', 1);
    await h.asUser(users.viewer);
    const second = await record(a, 'candidate_report_csv', null);
    const rows = await entries();
    assert.deepEqual(rows.map(r => r.id), [first, second]);
    assert.deepEqual(rows.map(r => r.actor_id), [users.owner, users.viewer]);
    for (const row of rows) {
      assert.equal(row.company_id, a.companyId);
      assert.equal(row.recruitment_id, a.recruitment.id);
      assert.equal(row.application_id, a.application.id);
      assert.equal(row.export_kind, 'candidate_report_csv');
    }
    assert.equal(rows[1].analysis_version, null);
  });

  await t.test('izolacja firm: obca firma, obca rekrutacja i brak rekordu dają ten sam 42501', async () => {
    const before = (await entries()).length;
    await h.asUser(users.otherOwner);
    // Firma B podaje własną firmę, ale zgłoszenie firmy A.
    await assert.rejects(record(b, undefined, 1, { application: a.application.id }), code('42501'));
    // Firma B podaje firmę A.
    await assert.rejects(record(a), code('42501'));
    // Ten sam identyfikator zgłoszenia pod niewłaściwą rekrutacją własnej firmy A.
    await h.asUser(users.owner);
    await assert.rejects(record(a, undefined, 1, { recruitment: b.recruitment.id }), code('42501'));
    await assert.rejects(record(a, undefined, 1, { application: randomUUID() }), code('42501'));
    // Obcy użytkownik i anonim.
    await h.asUser(users.outsider);
    await assert.rejects(record(a), code('42501'));
    await h.asUser(null, 'anon');
    await assert.rejects(record(a), code('42501'));
    assert.equal((await entries()).length, before);
  });

  await t.test('nieprawidłowy rodzaj eksportu albo wersja analizy są odrzucane', async () => {
    await h.asUser(users.owner);
    await assert.rejects(record(a, 'full_cv_dump'), code('22023'));
    await assert.rejects(record(a, 'candidate_report_csv', 0), code('22023'));
  });

  await t.test('po wycofaniu zgłoszenia i przy zamrożeniu danych zapis jest odmawiany (55000)', async () => {
    const before = (await entries()).length;
    await h.asAdmin();
    await db.query('update private.erasure_execution_config set restore_isolated=true where singleton');
    await h.asUser(users.owner);
    await assert.rejects(record(a), code('55000'));
    await h.asAdmin();
    await db.query('update private.erasure_execution_config set restore_isolated=false where singleton');
    const withdrawn = await h.candidate({ owner: users.owner, companyId: a.companyId, position: a.position, recruitment: a.recruitment }, 'W');
    // Wycofanie przechodzi wyłącznie kontrolowaną ścieżką (rola znacznika z SC-WER-C1), tak jak w produkcie.
    await h.asAdmin();
    await db.exec('set role competency_test_marker_writer');
    await db.query("update public.applications set status='withdrawn' where id=$1", [withdrawn.application.id]);
    await h.asUser(users.owner);
    await assert.rejects(record(withdrawn), code('55000'));
    assert.equal((await entries()).length, before);
  });

  await t.test('schemat zamknięty dla ról API, dziennik niezmienny', async () => {
    for (const role of ['anon', 'authenticated']) {
      await h.asAdmin();
      assert.equal((await db.query("select has_schema_privilege($1,'report_audit','USAGE') v", [role])).rows[0].v, false, role);
    }
    await h.asUser(users.owner);
    await assert.rejects(db.query('select * from report_audit.candidate_report_exports'), code('42501'));
    await assert.rejects(db.query(`insert into report_audit.candidate_report_exports(company_id,recruitment_id,application_id,actor_id,export_kind)
      values($1,$2,$3,$4,'candidate_report_csv')`, [a.companyId, a.recruitment.id, a.application.id, users.owner]), code('42501'));
    await h.asAdmin();
    await assert.rejects(db.query("update report_audit.candidate_report_exports set export_kind='candidate_report_csv'"), code('42501'));
    await assert.rejects(db.query('delete from report_audit.candidate_report_exports'), code('42501'));
    await assert.rejects(db.query('truncate report_audit.candidate_report_exports'), code('42501'));
    const grants = (await db.query(`select r.rolname, has_function_privilege(r.oid,'public.record_candidate_report_export(uuid,uuid,uuid,text,integer)','EXECUTE') v
      from pg_roles r where r.rolname in ('anon','authenticated','screening_worker','service_role') order by 1`)).rows;
    for (const { rolname, v } of grants) assert.equal(v, rolname === 'authenticated', rolname);
  });

  await t.test('rollback: odmowa przy wpisach, potem czysto i bez zmiany sygnatury SC-010', async () => {
    const installed = await signature();
    await assert.rejects(db.query(await sql(`rollbacks/${migration.replace('.sql', '_down.sql')}`)), error => /sc015d_rollback_not_empty/.test(error.message));
    await db.query('rollback').catch(() => {});
    await db.query('begin');
    await db.query("select set_config('report_audit.purge_company',$1,true)", [a.companyId]);
    await db.query('delete from report_audit.candidate_report_exports where company_id=$1', [a.companyId]);
    await db.query('commit');
    await db.query(await sql(`rollbacks/${migration.replace('.sql', '_down.sql')}`));
    assert.equal(await signature(), installed);
    assert.equal((await db.query("select to_regnamespace('report_audit') v")).rows[0].v, null);
    // Ponownie: rollback idempotentny, migracja daje się nałożyć jeszcze raz.
    await db.query(await sql(`rollbacks/${migration.replace('.sql', '_down.sql')}`));
    await db.query(await sql(`migrations/${migration}`));
    assert.equal(await signature(), installed);
  });
});
