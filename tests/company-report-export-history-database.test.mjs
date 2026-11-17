// SC-015-D3 — historia eksportów raportów na poziomie firmy, w bazie.
// Natywny PostgreSQL 16/17, pełny łańcuch migracji, dwie syntetyczne firmy.
// Sprawdza: tylko właściciel widzi przegląd firmy (rekruter, czytelnik, osoba
// spoza firmy, obca i nieistniejąca firma oraz anonim dostają ten sam 42501),
// pola wyniku bez danych kandydata, role i is_me, kolejność, limit domyślny 100
// i twardy 200, stronicowanie bez zgubionych wpisów przy tym samym czasie,
// tylko odczyt, uprawnienia funkcji, rollback.
// Dane są fikcyjne; żadnego prawdziwego kandydata, CV ani firmy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { bootMigrationDatabase } from './helpers/sc19-migration-fixture.mjs';
import { setupRankingDatabase, users } from './helpers/screening-ranking-fixture.mjs';

const migration = '20261117090000_sc015d3_company_report_export_history.sql';
const signatureText = 'public.list_company_report_exports(uuid,integer,timestamptz,uuid)';
const sql = name => readFile(new URL(`../supabase/${name}`, import.meta.url), 'utf8');
const code = (...codes) => error => codes.includes(error.code);

test('SC-015-D3: historia eksportów firmy — tylko właściciel, izolacja, limit, stronicowanie i rollback', async t => {
  const env = await bootMigrationDatabase(t);
  const { db } = env;
  const h = await setupRankingDatabase(db, { throughMigration: null });
  const record = f => db.query('select public.record_candidate_report_export($1,$2,$3,$4,$5)',
    [f.companyId, f.recruitment.id, f.application.id, 'candidate_report_csv', 1]);
  const list = (company, limit = null, before = null, id = null) => db.query(
    `select * from public.list_company_report_exports($1, coalesce($2::integer, 100), $3, $4)`, [company, limit, before, id],
  ).then(result => result.rows);
  const listDefault = company => db.query('select * from public.list_company_report_exports($1)', [company]).then(r => r.rows);
  const count = async () => { await h.asAdmin(); return Number((await db.query('select count(*) n from report_audit.candidate_report_exports')).rows[0].n); };

  const a = await h.seed(users.owner, 'A');
  const b = await h.seed(users.otherOwner, 'B');
  await h.asAdmin();
  await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'viewer'),($1,$3,'recruiter')",
    [a.companyId, users.viewer, users.recruiter]);
  const a2 = await h.candidate({ owner: users.owner, companyId: a.companyId, position: a.position, recruitment: a.recruitment }, 'A2');

  await t.test('właściciel widzi pustą historię, potem wpisy całej firmy z rolą, is_me i identyfikatorami', async () => {
    await h.asUser(users.owner);
    assert.deepEqual(await listDefault(a.companyId), []);
    await record(a);
    await h.asUser(users.viewer);
    await record(a2);
    await h.asUser(users.recruiter);
    await record(a);
    await h.asUser(users.otherOwner);
    await record(b);
    await h.asUser(users.owner);
    const rows = await listDefault(a.companyId);
    assert.deepEqual(Object.keys(rows[0]).sort(),
      ['actor_id', 'actor_role', 'application_id', 'export_id', 'exported_at', 'is_me', 'recruitment_id']);
    assert.deepEqual(rows.map(r => r.actor_id), [users.recruiter, users.viewer, users.owner]);
    assert.deepEqual(rows.map(r => r.actor_role), ['recruiter', 'viewer', 'owner']);
    assert.deepEqual(rows.map(r => r.is_me), [false, false, true]);
    assert.deepEqual(rows.map(r => r.application_id), [a.application.id, a2.application.id, a.application.id]);
    for (const r of rows) {
      assert.equal(r.recruitment_id, a.recruitment.id);
      assert.ok(r.exported_at instanceof Date);
    }
    // Obca firma nie przecieka: właściciel B widzi tylko swój wpis.
    await h.asUser(users.otherOwner);
    assert.deepEqual((await listDefault(b.companyId)).map(r => r.application_id), [b.application.id]);
  });

  await t.test('osoba usunięta z zespołu ma etykietę former_member', async () => {
    await h.asAdmin();
    await db.query('delete from public.company_members where company_id=$1 and user_id=$2', [a.companyId, users.recruiter]);
    await h.asUser(users.owner);
    assert.equal((await listDefault(a.companyId))[0].actor_role, 'former_member');
    await h.asAdmin();
    await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter')", [a.companyId, users.recruiter]);
  });

  await t.test('rekruter, czytelnik, osoba spoza firmy, obca i nieistniejąca firma, anonim: ten sam 42501', async () => {
    for (const user of [users.recruiter, users.viewer, users.outsider, users.otherOwner]) {
      await h.asUser(user);
      await assert.rejects(listDefault(a.companyId), code('42501'), user);
    }
    await h.asUser(users.owner);
    await assert.rejects(listDefault(b.companyId), code('42501'));
    await assert.rejects(listDefault(randomUUID()), code('42501'));
    await assert.rejects(listDefault(null), code('42501'));
    await h.asUser(null, 'anon');
    await assert.rejects(listDefault(a.companyId), code('42501'));
  });

  await t.test('uprawnienia: tylko authenticated, security definer, pusty search_path, report_audit zamknięty', async () => {
    await h.asAdmin();
    const grants = (await db.query(`select r.rolname, has_function_privilege(r.oid,$1,'EXECUTE') v
      from pg_roles r where r.rolname in ('anon','authenticated','screening_worker','service_role') order by 1`, [signatureText])).rows;
    assert.ok(grants.length >= 2);
    for (const { rolname, v } of grants) assert.equal(v, rolname === 'authenticated', rolname);
    const fn = (await db.query('select p.prosecdef, p.provolatile, p.proconfig from pg_proc p where p.oid = $1::regprocedure',
      [signatureText])).rows[0];
    assert.equal(fn.prosecdef, true);
    assert.equal(fn.provolatile, 's');
    assert.deepEqual(fn.proconfig, ['search_path=""']);
    for (const role of ['anon', 'authenticated']) {
      assert.equal((await db.query("select has_schema_privilege($1,'report_audit','USAGE') v", [role])).rows[0].v, false, role);
    }
  });

  await t.test('najnowsze pierwsze, domyślnie 100, twardy limit 200, odczyt nic nie dopisuje', async () => {
    await h.asAdmin();
    await db.query(`insert into report_audit.candidate_report_exports(company_id,recruitment_id,application_id,actor_id,export_kind,created_at)
      select $1,$2,$3,$4,'candidate_report_csv', timestamptz '2026-01-01 00:00:00+00' + make_interval(mins => g)
        from generate_series(1, 250) g`, [a.companyId, a.recruitment.id, a.application.id, users.owner]);
    const before = await count();
    await h.asUser(users.owner);
    const page = await listDefault(a.companyId);
    assert.equal(page.length, 100);
    for (let i = 1; i < page.length; i += 1) assert.ok(page[i - 1].exported_at >= page[i].exported_at, `kolejność ${i}`);
    assert.equal(page[3].exported_at.toISOString(), '2026-01-01T04:10:00.000Z', 'po trzech dzisiejszych wpisach minuta 250');
    assert.equal((await list(a.companyId, 1000)).length, 200);
    assert.equal((await list(a.companyId, 0)).length, 1);
    assert.equal((await list(a.companyId, -5)).length, 1);
    assert.equal(await count(), before);
  });

  await t.test('stronicowanie: wpisy o tym samym czasie nie giną; kursor musi być pełny', async () => {
    await h.asAdmin();
    await db.query(`insert into report_audit.candidate_report_exports(company_id,recruitment_id,application_id,actor_id,export_kind,created_at)
      select $1,$2,$3,$4,'candidate_report_csv', timestamptz '2025-12-31 12:00:00+00' from generate_series(1, 7)`,
    [a.companyId, a.recruitment.id, a.application.id, users.owner]);
    const total = await count() - 1; // jeden wpis firmy B
    await h.asUser(users.owner);
    const seen = [];
    let cursor = [null, null];
    for (let guard = 0; guard < 100; guard += 1) {
      // Kursor w pełnej precyzji (mikrosekundy): czas jako tekst, jak w aplikacji.
      const rows = (await db.query(`select export_id, exported_at::text at
        from public.list_company_report_exports($1, 3, $2, $3)`, [a.companyId, ...cursor])).rows;
      seen.push(...rows.map(r => r.export_id));
      if (rows.length < 3) break;
      cursor = [rows.at(-1).at, rows.at(-1).export_id];
    }
    assert.equal(seen.length, total);
    assert.equal(new Set(seen).size, total);
    await assert.rejects(list(a.companyId, 10, '2026-01-01T00:00:00Z', null), code('22023'));
    await assert.rejects(list(a.companyId, 10, null, randomUUID()), code('22023'));
  });

  await t.test('historia zostaje widoczna po wycofaniu zgłoszenia', async () => {
    const withdrawn = await h.candidate({ owner: users.owner, companyId: a.companyId, position: a.position, recruitment: a.recruitment }, 'W');
    await h.asUser(users.owner);
    await record(withdrawn);
    await h.asAdmin();
    await db.exec('set role competency_test_marker_writer');
    await db.query("update public.applications set status='withdrawn' where id=$1", [withdrawn.application.id]);
    await h.asUser(users.owner);
    assert.equal((await listDefault(a.companyId))[0].application_id, withdrawn.application.id);
  });

  await t.test('rollback usuwa tylko funkcję, dziennik i odczyt D2 zostają; migracja daje się nałożyć ponownie', async () => {
    await h.asAdmin();
    const signature = (await db.query('select private.erasure_schema_signature() v')).rows[0].v;
    const entries = await count();
    await h.asAdmin();
    const down = await sql(`rollbacks/${migration.replace('.sql', '_down.sql')}`);
    await db.query(down);
    assert.equal((await db.query('select to_regprocedure($1) v', [signatureText])).rows[0].v, null);
    assert.notEqual((await db.query("select to_regprocedure('public.list_candidate_report_exports(uuid,uuid,uuid)') v")).rows[0].v, null);
    assert.notEqual((await db.query("select to_regprocedure('public.record_candidate_report_export(uuid,uuid,uuid,text,integer)') v")).rows[0].v, null);
    assert.equal(await count(), entries);
    await h.asAdmin();
    assert.equal((await db.query('select private.erasure_schema_signature() v')).rows[0].v, signature);
    await db.query(down);
    await db.query(await sql(`migrations/${migration}`));
    await assert.rejects(db.query(await sql(`migrations/${migration}`)), error => /sc015d3_already_installed/.test(error.message));
    await db.query('rollback').catch(() => {});
    await h.asUser(users.owner);
    assert.equal((await listDefault(a.companyId)).length, 100);
  });
});
