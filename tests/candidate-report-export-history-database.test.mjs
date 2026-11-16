// SC-015-D2 — odczyt historii eksportu raportu kandydata w bazie.
// Natywny PostgreSQL 16/17, pełny łańcuch migracji, dwie syntetyczne firmy.
// Sprawdza: kto widzi historię (właściciel, rekruter, czytelnik), izolację firm
// (ten sam 42501 dla obcego i nieistniejącego rekordu), brak dostępu dla osoby
// spoza firmy i anonima, kolejność (najnowsze pierwsze) i limit 50, etykiety ról
// i is_me, brak danych kandydata w wyniku, tylko odczyt, rollback.
// Dane są fikcyjne; żadnego prawdziwego kandydata, CV ani firmy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { bootMigrationDatabase } from './helpers/sc19-migration-fixture.mjs';
import { setupRankingDatabase, users } from './helpers/screening-ranking-fixture.mjs';

const migration = '20261116210000_sc015d2_candidate_report_export_history.sql';
const sql = name => readFile(new URL(`../supabase/${name}`, import.meta.url), 'utf8');
const code = (...codes) => error => codes.includes(error.code);

test('SC-015-D2: historia eksportu — dostęp, izolacja firm, kolejność, limit i rollback', async t => {
  const env = await bootMigrationDatabase(t);
  const { db } = env;
  const h = await setupRankingDatabase(db, { throughMigration: null });
  const record = f => db.query('select public.record_candidate_report_export($1,$2,$3,$4,$5)',
    [f.companyId, f.recruitment.id, f.application.id, 'candidate_report_csv', 1]);
  const list = (f, overrides = {}) => db.query(
    'select * from public.list_candidate_report_exports($1,$2,$3)',
    ['company' in overrides ? overrides.company : f.companyId, overrides.recruitment ?? f.recruitment.id, overrides.application ?? f.application.id],
  ).then(result => result.rows);
  const count = async () => { await h.asAdmin(); return Number((await db.query('select count(*) n from report_audit.candidate_report_exports')).rows[0].n); };

  const a = await h.seed(users.owner, 'A');
  const b = await h.seed(users.otherOwner, 'B');
  await h.asAdmin();
  await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'viewer'),($1,$3,'recruiter')",
    [a.companyId, users.viewer, users.recruiter]);

  await t.test('pusta historia, potem wpisy z rolą i is_me, bez danych kandydata', async () => {
    await h.asUser(users.owner);
    assert.deepEqual(await list(a), []);
    await record(a);
    await h.asUser(users.viewer);
    await record(a);
    await h.asUser(users.recruiter);
    await record(a);
    const rows = await list(a);
    assert.deepEqual(Object.keys(rows[0]).sort(), ['actor_id', 'actor_role', 'exported_at', 'is_me']);
    assert.deepEqual(rows.map(r => r.actor_id), [users.recruiter, users.viewer, users.owner]);
    assert.deepEqual(rows.map(r => r.actor_role), ['recruiter', 'viewer', 'owner']);
    assert.deepEqual(rows.map(r => r.is_me), [true, false, false]);
    for (const row of rows) assert.ok(row.exported_at instanceof Date);
    await h.asUser(users.viewer);
    assert.deepEqual((await list(a)).map(r => r.is_me), [false, true, false]);
  });

  await t.test('osoba usunięta z zespołu ma etykietę former_member', async () => {
    await h.asAdmin();
    await db.query('delete from public.company_members where company_id=$1 and user_id=$2', [a.companyId, users.recruiter]);
    await h.asUser(users.owner);
    assert.equal((await list(a))[0].actor_role, 'former_member');
    await h.asAdmin();
    await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter')", [a.companyId, users.recruiter]);
  });

  await t.test('izolacja firm: obca firma, obca rekrutacja i brak rekordu dają ten sam 42501', async () => {
    await h.asUser(users.otherOwner);
    assert.deepEqual(await list(b), []);
    await assert.rejects(list(b, { application: a.application.id }), code('42501'));
    await assert.rejects(list(b, { recruitment: a.recruitment.id, application: a.application.id }), code('42501'));
    await assert.rejects(list(a), code('42501'));
    await h.asUser(users.owner);
    await assert.rejects(list(a, { recruitment: b.recruitment.id }), code('42501'));
    await assert.rejects(list(a, { application: randomUUID() }), code('42501'));
    await assert.rejects(list(a, { company: null }), code('42501'));
  });

  await t.test('osoba spoza firmy i anonim nie mają dostępu; tylko authenticated może wywołać', async () => {
    await h.asUser(users.outsider);
    await assert.rejects(list(a), code('42501'));
    await h.asUser(null, 'anon');
    await assert.rejects(list(a), code('42501'));
    await h.asAdmin();
    const grants = (await db.query(`select r.rolname, has_function_privilege(r.oid,'public.list_candidate_report_exports(uuid,uuid,uuid)','EXECUTE') v
      from pg_roles r where r.rolname in ('anon','authenticated','screening_worker','service_role') order by 1`)).rows;
    assert.ok(grants.length >= 2);
    for (const { rolname, v } of grants) assert.equal(v, rolname === 'authenticated', rolname);
    const fn = (await db.query(`select p.prosecdef, p.provolatile, p.proconfig from pg_proc p
      where p.oid = 'public.list_candidate_report_exports(uuid,uuid,uuid)'::regprocedure`)).rows[0];
    assert.equal(fn.prosecdef, true);
    assert.equal(fn.provolatile, 's');
    assert.deepEqual(fn.proconfig, ['search_path=""']);
    for (const role of ['anon', 'authenticated']) {
      assert.equal((await db.query("select has_schema_privilege($1,'report_audit','USAGE') v", [role])).rows[0].v, false, role);
    }
  });

  await t.test('najnowsze pierwsze, najwyżej 50 wpisów, odczyt nic nie dopisuje', async () => {
    await h.asAdmin();
    await db.query(`insert into report_audit.candidate_report_exports(company_id,recruitment_id,application_id,actor_id,export_kind,created_at)
      select $1,$2,$3,$4,'candidate_report_csv', timestamptz '2026-01-01 00:00:00+00' + make_interval(mins => g)
        from generate_series(1, 60) g`, [a.companyId, a.recruitment.id, a.application.id, users.owner]);
    // Wpis innego zgłoszenia tej samej firmy nie trafia do tej historii.
    const other = await h.candidate({ owner: users.owner, companyId: a.companyId, position: a.position, recruitment: a.recruitment }, 'O');
    await h.asUser(users.owner);
    await record(other);
    const before = await count();
    await h.asUser(users.owner);
    const rows = await list(a);
    assert.equal(rows.length, 50);
    for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i - 1].exported_at >= rows[i].exported_at, `kolejność ${i}`);
    // Trzy prawdziwe wpisy z dzisiaj są najnowsze, potem syntetyczne od 60. minuty w dół.
    assert.equal(rows[3].exported_at.toISOString(), '2026-01-01T01:00:00.000Z');
    assert.equal(rows[49].exported_at.toISOString(), '2026-01-01T00:14:00.000Z');
    await h.asUser(users.owner);
    assert.equal((await list(other)).length, 1);
    assert.equal(await count(), before);
  });

  await t.test('historia zostaje widoczna po wycofaniu zgłoszenia', async () => {
    const withdrawn = await h.candidate({ owner: users.owner, companyId: a.companyId, position: a.position, recruitment: a.recruitment }, 'W');
    await h.asUser(users.owner);
    await record(withdrawn);
    await h.asAdmin();
    await db.exec('set role competency_test_marker_writer');
    await db.query("update public.applications set status='withdrawn' where id=$1", [withdrawn.application.id]);
    await h.asUser(users.owner);
    assert.equal((await list(withdrawn)).length, 1);
  });

  await t.test('rollback usuwa tylko funkcję, dziennik zostaje; migracja daje się nałożyć ponownie', async () => {
    await h.asAdmin();
    const signature = (await db.query('select private.erasure_schema_signature() v')).rows[0].v;
    const entries = await count();
    await h.asAdmin();
    const down = await sql(`rollbacks/${migration.replace('.sql', '_down.sql')}`);
    await db.query(down);
    assert.equal((await db.query("select to_regprocedure('public.list_candidate_report_exports(uuid,uuid,uuid)') v")).rows[0].v, null);
    assert.notEqual((await db.query("select to_regprocedure('public.record_candidate_report_export(uuid,uuid,uuid,text,integer)') v")).rows[0].v, null);
    assert.equal(await count(), entries);
    await h.asAdmin();
    assert.equal((await db.query('select private.erasure_schema_signature() v')).rows[0].v, signature);
    await db.query(down);
    await db.query(await sql(`migrations/${migration}`));
    await assert.rejects(db.query(await sql(`migrations/${migration}`)), error => /sc015d2_already_installed/.test(error.message));
    await db.query('rollback').catch(() => {});
    await h.asUser(users.owner);
    assert.equal((await list(a)).length, 50);
  });
});
