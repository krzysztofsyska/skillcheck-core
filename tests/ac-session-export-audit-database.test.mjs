// SC-AC-EXPORT-AUDIT — dziennik pobrań CSV sesji Assessment Center w bazie.
// Natywny PostgreSQL 16/17, pełny łańcuch migracji, dwie syntetyczne firmy.
// Sprawdza: wpis z actor = auth.uid() i rolą (właściciel, rekruter), odmowę dla czytelnika,
// osoby spoza firmy i anonima, izolację firm (ten sam 42501 dla obcej firmy, obcej rekrutacji,
// obcej i nieistniejącej sesji), brak danych kandydata we wpisie, zamknięty schemat,
// niezmienność dziennika, nietknięty dziennik SC-015-D oraz rollback bez zmiany sygnatury SC-010.
// Dane są fikcyjne; żadnego prawdziwego kandydata, CV ani firmy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sessionBoot, users } from './helpers/ac-session-fixture.mjs';

const migration = '20261117120000_sc_ac_session_export_audit.sql';
const sql = name => readFile(new URL(`../supabase/${name}`, import.meta.url), 'utf8');
const rollback = () => sql(`rollbacks/${migration.replace('.sql', '_down.sql')}`);
const code = (...codes) => error => codes.includes(error.code);
const fn = 'public.record_assessment_center_session_export(uuid,uuid,uuid,text)';

test('SC-AC-EXPORT-AUDIT: zapis przed plikiem, role, izolacja firm, niezmienność i rollback', async t => {
  const e = await sessionBoot(t, { throughMigration: null });
  const { db, h } = e;
  const record = (f, sessionId, overrides = {}) => db.query(
    `select ${fn.replace(/\(.*$/, '')}($1,$2,$3,$4) as id`,
    [overrides.company ?? f.companyId, overrides.recruitment ?? f.recruitment.id, overrides.session ?? sessionId, 'kind' in overrides ? overrides.kind : 'ac_session_csv'],
  ).then(result => result.rows[0].id);
  const entries = async () => { await h.asAdmin(); return (await db.query('select * from report_audit.assessment_center_session_exports order by created_at, id')).rows; };
  const signature = async () => { await h.asAdmin(); return (await db.query('select private.erasure_schema_signature() v')).rows[0].v; };

  // Firma A (właściciel + rekruter z fixture) i firma B, każda z własną sesją AC.
  const a = await e.finalist();
  const b = await e.finalist(users.otherOwner);
  const { sessionId: sessionA } = await e.plan(a);
  const { sessionId: sessionB } = await e.plan(b);
  await h.asAdmin();
  await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'viewer') on conflict(company_id,user_id) do nothing", [a.companyId, users.viewer]);

  await t.test('właściciel i rekruter zapisują wpis z własnym actor_id i rolą; bez danych kandydata', async () => {
    await h.asUser(a.owner);
    const first = await record(a, sessionA);
    await h.asUser(users.recruiter);
    const second = await record(a, sessionA);
    const rows = await entries();
    assert.deepEqual(rows.map(r => r.id), [first, second]);
    assert.deepEqual(rows.map(r => r.actor_id), [a.owner, users.recruiter]);
    assert.deepEqual(rows.map(r => r.actor_role), ['owner', 'recruiter']);
    for (const row of rows) {
      assert.equal(row.company_id, a.companyId);
      assert.equal(row.recruitment_id, a.recruitment.id);
      assert.equal(row.session_id, sessionA);
      assert.equal(row.export_kind, 'ac_session_csv');
      assert.ok(row.created_at instanceof Date);
    }
    assert.deepEqual(Object.keys(rows[0]).sort(),
      ['actor_id', 'actor_role', 'company_id', 'created_at', 'export_kind', 'id', 'recruitment_id', 'session_id']);
  });

  await t.test('czytelnik, osoba spoza firmy i anonim: 42501, nic nie zapisano', async () => {
    const before = (await entries()).length;
    for (const user of [users.viewer, users.outsider]) {
      await h.asUser(user);
      await assert.rejects(record(a, sessionA), code('42501'), user);
    }
    await h.asUser(null, 'anon');
    await assert.rejects(record(a, sessionA), code('42501'));
    assert.equal((await entries()).length, before);
  });

  await t.test('izolacja firm: obca firma, obca rekrutacja, obca i nieistniejąca sesja dają ten sam 42501', async () => {
    const before = (await entries()).length;
    await h.asUser(users.otherOwner);
    // Firma B podaje firmę A.
    await assert.rejects(record(a, sessionA), code('42501'));
    // Firma B podaje własną firmę i rekrutację, ale sesję firmy A.
    await assert.rejects(record(b, sessionA), code('42501'));
    // Firma B podaje własną firmę, ale rekrutację firmy A.
    await assert.rejects(record(b, sessionB, { recruitment: a.recruitment.id }), code('42501'));
    await h.asUser(a.owner);
    // Własna firma, sesja innej firmy; rekrutacja innej firmy; nieistniejąca sesja i rekrutacja.
    await assert.rejects(record(a, sessionB), code('42501'));
    await assert.rejects(record(a, sessionA, { recruitment: b.recruitment.id }), code('42501'));
    await assert.rejects(record(a, randomUUID()), code('42501'));
    await assert.rejects(record(a, sessionA, { recruitment: randomUUID() }), code('42501'));
    await assert.rejects(record(a, sessionA, { company: randomUUID() }), code('42501'));
    await assert.rejects(record(a, null), code('42501'));
    assert.equal((await entries()).length, before);
  });

  await t.test('nieprawidłowy rodzaj eksportu jest odrzucany (22023)', async () => {
    await h.asUser(a.owner);
    await assert.rejects(record(a, sessionA, { kind: 'candidate_report_csv' }), code('22023'));
    await assert.rejects(record(a, sessionA, { kind: null }), code('22023'));
  });

  await t.test('funkcja: security definer, search_path pusty, wykonanie tylko dla authenticated', async () => {
    await h.asAdmin();
    const meta = (await db.query('select prosecdef d, proconfig c from pg_proc where oid=$1::regprocedure', [fn])).rows[0];
    assert.deepEqual(meta, { d: true, c: ['search_path=""'] });
    const grants = (await db.query(`select r.rolname, has_function_privilege(r.oid,$1,'EXECUTE') v
      from pg_roles r where r.rolname in ('anon','authenticated','screening_worker','service_role') order by 1`, [fn])).rows;
    for (const { rolname, v } of grants) assert.equal(v, rolname === 'authenticated', rolname);
    // Brak wpisu dla PUBLIC w ACL funkcji.
    const acl = (await db.query("select coalesce(array_agg(a.grantee::regrole::text) filter (where a.grantee=0),'{}') pub from pg_proc p cross join lateral aclexplode(p.proacl) a where p.oid=$1::regprocedure", [fn])).rows[0].pub;
    assert.deepEqual(acl, []);
  });

  await t.test('schemat zamknięty dla ról API, dziennik niezmienny, RLS włączone', async () => {
    for (const role of ['anon', 'authenticated']) {
      await h.asAdmin();
      assert.equal((await db.query("select has_schema_privilege($1,'report_audit','USAGE') v", [role])).rows[0].v, false, role);
    }
    await h.asAdmin();
    assert.equal((await db.query("select relrowsecurity v from pg_class where oid='report_audit.assessment_center_session_exports'::regclass")).rows[0].v, true);
    await h.asUser(a.owner);
    await assert.rejects(db.query('select * from report_audit.assessment_center_session_exports'), code('42501'));
    await assert.rejects(db.query(`insert into report_audit.assessment_center_session_exports(company_id,recruitment_id,session_id,actor_id,actor_role,export_kind)
      values($1,$2,$3,$4,'owner','ac_session_csv')`, [a.companyId, a.recruitment.id, sessionA, a.owner]), code('42501'));
    await h.asAdmin();
    await assert.rejects(db.query("update report_audit.assessment_center_session_exports set actor_role='owner'"), code('42501'));
    await assert.rejects(db.query('delete from report_audit.assessment_center_session_exports'), code('42501'));
    await assert.rejects(db.query('truncate report_audit.assessment_center_session_exports'), code('42501'));
    // Dziennik raportów kandydata (SC-015-D) nie dostał żadnego wpisu.
    assert.equal((await db.query('select count(*)::int n from report_audit.candidate_report_exports')).rows[0].n, 0);
  });

  await t.test('rollback: odmowa przy wpisach, potem czysto, SC-015-D nietknięte, bez zmiany sygnatury SC-010', async () => {
    const installed = await signature();
    await assert.rejects(db.query(await rollback()), error => /sc_ac_export_audit_rollback_not_empty/.test(error.message));
    await db.query('rollback').catch(() => {});
    assert.notEqual((await db.query('select to_regprocedure($1) v', [fn])).rows[0].v, null, 'odmowa nie usuwa funkcji');
    await db.query('begin');
    await db.query("select set_config('report_audit.purge_company',$1,true)", [a.companyId]);
    await db.query('delete from report_audit.assessment_center_session_exports where company_id=$1', [a.companyId]);
    await db.query('commit');
    await db.query(await rollback());
    assert.equal(await signature(), installed);
    assert.equal((await db.query("select to_regclass('report_audit.assessment_center_session_exports') v")).rows[0].v, null);
    assert.equal((await db.query('select to_regprocedure($1) v', [fn])).rows[0].v, null);
    assert.notEqual((await db.query("select to_regclass('report_audit.candidate_report_exports') v")).rows[0].v, null);
    assert.notEqual((await db.query("select to_regprocedure('public.record_candidate_report_export(uuid,uuid,uuid,text,integer)') v")).rows[0].v, null);
    // Ponownie: rollback idempotentny, migracja daje się nałożyć jeszcze raz i działa.
    await db.query(await rollback());
    await db.query(await sql(`migrations/${migration}`));
    assert.equal(await signature(), installed);
    await h.asUser(a.owner);
    assert.match(await record(a, sessionA), /^[0-9a-f-]{36}$/);
  });
});
