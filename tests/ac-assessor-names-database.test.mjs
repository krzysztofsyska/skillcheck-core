// R3-AC-NAMES — public.ac_assessor_display_names w bazie (natywny PostgreSQL 16/17, pełny łańcuch migracji).
// Sprawdza: nazwy (e-mail konta) tylko właściciela i obecnych rekruterów tej firmy; czytelnik nie jest
// zwracany; członek usunięty z zespołu znika z wyniku i traci dostęp; członkowie innej firmy nigdy nie
// są zwracani; czytelnik, osoba spoza firmy, anonim, obca firma i obca/nieistniejąca rekrutacja dostają
// ten sam 42501; funkcja security definer z pustym search_path, wykonanie tylko dla authenticated;
// rollback bez zmiany sygnatury SC-010. Dane są fikcyjne (adresy w domenie example.invalid).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sessionBoot, users } from './helpers/ac-session-fixture.mjs';

const migration = '20261117213000_ac_assessor_display_names.sql';
const sql = name => readFile(new URL(`../supabase/${name}`, import.meta.url), 'utf8');
const rollback = () => sql(`rollbacks/${migration.replace('.sql', '_down.sql')}`);
const code = (...codes) => error => codes.includes(error.code);
const fn = 'public.ac_assessor_display_names(uuid,uuid)';
const mail = id => `u-${id.slice(-4)}@example.invalid`;

test('R3-AC-NAMES: nazwy asesorów tylko w obrębie firmy, odmowy, usunięty członek i rollback', async t => {
  const e = await sessionBoot(t, { throughMigration: null });
  const { db, h } = e;
  const names = (company, recruitment) => db.query(`select user_id, display_name from ${fn.replace(/\(.*$/, '')}($1,$2) order by display_name`, [company, recruitment])
    .then(result => Object.fromEntries(result.rows.map(row => [row.user_id, row.display_name])));
  const signature = async () => { await h.asAdmin(); return (await db.query('select private.erasure_schema_signature() v')).rows[0].v; };

  // Firma A (właściciel + rekruter z fixture) i firma B (otherOwner; fixture dopisuje też rekrutera).
  const a = await e.finalist();
  const b = await e.finalist(users.otherOwner);
  const onlyB = randomUUID(), noMail = randomUUID();
  await h.asAdmin();
  // Testowy auth.users ma tylko id; e-mail dochodzi tu, jak w Supabase Auth.
  await db.query('alter table auth.users add column if not exists email text');
  await db.query('insert into auth.users(id) values($1),($2)', [onlyB, noMail]);
  for (const id of [...Object.values(users), onlyB]) await db.query('update auth.users set email=$2 where id=$1', [id, mail(id)]);
  await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'viewer') on conflict(company_id,user_id) do nothing", [a.companyId, users.viewer]);
  await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter')", [b.companyId, onlyB]);
  await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter')", [a.companyId, noMail]);

  await t.test('właściciel i rekruter A widzą tylko właściciela i rekruterów A; bez czytelnika i bez osób z B', async () => {
    const expected = { [users.owner]: mail(users.owner), [users.recruiter]: mail(users.recruiter) };
    for (const user of [users.owner, users.recruiter]) {
      await h.asUser(user);
      assert.deepEqual(await names(a.companyId, a.recruitment.id), expected, user);
    }
    await h.asUser(users.otherOwner);
    const forB = await names(b.companyId, b.recruitment.id);
    assert.deepEqual(Object.keys(forB).sort(), [users.otherOwner, users.recruiter, onlyB].sort());
    assert.ok(!(users.owner in forB), 'właściciel A nie jest zwracany dla firmy B');
  });

  await t.test('czytelnik, osoba spoza firmy i anonim: 42501', async () => {
    for (const user of [users.viewer, users.outsider]) {
      await h.asUser(user);
      await assert.rejects(names(a.companyId, a.recruitment.id), code('42501'), user);
    }
    await h.asUser(null, 'anon');
    await assert.rejects(names(a.companyId, a.recruitment.id), code('42501'));
  });

  await t.test('inna firma: obca firma, obca i nieistniejąca rekrutacja, puste argumenty dają ten sam 42501', async () => {
    await h.asUser(users.otherOwner);
    await assert.rejects(names(a.companyId, a.recruitment.id), code('42501'));
    await assert.rejects(names(b.companyId, a.recruitment.id), code('42501'));
    await h.asUser(onlyB);
    await assert.rejects(names(a.companyId, a.recruitment.id), code('42501'));
    await h.asUser(users.owner);
    await assert.rejects(names(a.companyId, b.recruitment.id), code('42501'));
    await assert.rejects(names(a.companyId, randomUUID()), code('42501'));
    await assert.rejects(names(randomUUID(), a.recruitment.id), code('42501'));
    await assert.rejects(names(a.companyId, null), code('42501'));
    await assert.rejects(names(null, a.recruitment.id), code('42501'));
  });

  await t.test('usunięty członek: znika z wyniku i sam traci dostęp', async () => {
    await h.asUser(users.owner);
    await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter')", [a.companyId, users.outsider]);
    assert.equal((await names(a.companyId, a.recruitment.id))[users.outsider], mail(users.outsider));
    await db.query('delete from public.company_members where company_id=$1 and user_id=$2', [a.companyId, users.outsider]);
    assert.ok(!(users.outsider in await names(a.companyId, a.recruitment.id)));
    await h.asUser(users.outsider);
    await assert.rejects(names(a.companyId, a.recruitment.id), code('42501'));
    // Rekruter zdegradowany do czytelnika: też bez nazwy.
    await h.asUser(users.owner);
    await db.query("update public.company_members set role='viewer' where company_id=$1 and user_id=$2", [a.companyId, users.recruiter]);
    assert.deepEqual(await names(a.companyId, a.recruitment.id), { [users.owner]: mail(users.owner) });
    await db.query("update public.company_members set role='recruiter' where company_id=$1 and user_id=$2", [a.companyId, users.recruiter]);
  });

  await t.test('funkcja: security definer, search_path pusty, wykonanie tylko dla authenticated, bez PUBLIC', async () => {
    await h.asAdmin();
    const meta = (await db.query('select prosecdef d, proconfig c, provolatile v from pg_proc where oid=$1::regprocedure', [fn])).rows[0];
    assert.deepEqual(meta, { d: true, c: ['search_path=""'], v: 's' });
    const grants = (await db.query(`select r.rolname, has_function_privilege(r.oid,$1,'EXECUTE') v
      from pg_roles r where r.rolname in ('anon','authenticated','screening_worker','service_role') order by 1`, [fn])).rows;
    for (const { rolname, v } of grants) assert.equal(v, rolname === 'authenticated', rolname);
    const acl = (await db.query("select coalesce(array_agg(a.grantee::regrole::text) filter (where a.grantee=0),'{}') pub from pg_proc p cross join lateral aclexplode(p.proacl) a where p.oid=$1::regprocedure", [fn])).rows[0].pub;
    assert.deepEqual(acl, []);
    // Zwraca wyłącznie identyfikator i nazwę — żadnych innych kolumn auth.users.
    await h.asUser(users.owner);
    const row = (await db.query(`select * from ${fn.replace(/\(.*$/, '')}($1,$2) limit 1`, [a.companyId, a.recruitment.id])).rows[0];
    assert.deepEqual(Object.keys(row).sort(), ['display_name', 'user_id']);
  });

  await t.test('rollback: funkcja usunięta, sygnatura SC-010 bez zmian, migracja daje się nałożyć ponownie', async () => {
    const installed = await signature();
    await db.query(await rollback());
    assert.equal(await signature(), installed);
    assert.equal((await db.query('select to_regprocedure($1) v', [fn])).rows[0].v, null);
    await db.query(await rollback());
    await db.query(await sql(`migrations/${migration}`));
    assert.equal(await signature(), installed);
    await h.asUser(users.owner);
    assert.equal((await names(a.companyId, a.recruitment.id))[users.owner], mail(users.owner));
  });
});
