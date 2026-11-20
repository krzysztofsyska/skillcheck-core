// R3 — sesja Assessment Center powiązana z kupionym pakietem ASSESSMENT CENTER
// (20261121090000_r3_ac_package_gate.sql). Natywny PostgreSQL 16/17, pełny łańcuch migracji.
// Sprawdza: bez pakietu (brak wiersza, available=0, pakiet innej firmy, inny pakiet) firma nie
// tworzy ani nie otwiera sesji (PT402); z pakietem może; osoba spoza firmy i rekruter dostają tę
// samą odmowę co wcześniej (42501 / PT404) (nic nie wie o pakiecie obcej firmy); zamknięcie otwartej sesji nie wymaga pakietu;
// pomocnik niedostępny dla ról API, uprawnienia RPC bez zmian; sygnatura SC-010 bez zmian;
// ponowne uruchomienie migracji odmawia; rollback przywraca zachowanie R16. Dane fikcyjne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sessionBoot, users, hrbpCaseTemplate } from './helpers/ac-session-fixture.mjs';

const migration = '20261121090000_r3_ac_package_gate.sql';
const sql = path => readFile(new URL(`../supabase/${path}`, import.meta.url), 'utf8');
const code = (...codes) => error => codes.includes(error.code);
// Pre-gate refusals of R16 (company access 42501, owner-only authority PT404); never PT402.
const forbidden = code('42501', 'PT404');
const packageRequired = error => error.code === 'PT402' && error.message === 'Assessment Center package required';

test('R3: sesja AC tylko dla firmy z opłaconym pakietem ASSESSMENT CENTER', async t => {
  const e = await sessionBoot(t, { throughMigration: null });
  const { db, h, call } = e;
  const signature = async () => { await h.asAdmin(); return (await db.query('select private.erasure_schema_signature() v')).rows[0].v; };
  const setEntitlement = async (companyId, entitlementCode, available) => {
    await h.asAdmin();
    await db.query(`insert into sc19_commerce.entitlements(company_id,code,available) values($1,$2,$3)
      on conflict(company_id,code) do update set available=excluded.available`, [companyId, entitlementCode, available]);
  };
  const create = async (f, user = f.owner) => {
    await h.asUser(user);
    return call('public.ac_session_create', [f.recruitment.id, 'Sesja finalistów', ['Analiza']]);
  };

  const a = await e.finalist();
  const b = await e.finalist(users.otherOwner);

  await t.test('pomocnik tylko dla właściciela funkcji; RPC sesji zachowują uprawnienia i security definer', async () => {
    await h.asAdmin();
    const helper = (await db.query(`select prosecdef definer, proconfig config,
      has_function_privilege('anon',oid,'execute') anon, has_function_privilege('authenticated',oid,'execute') staff
      from pg_proc where oid='private.ac_package_required(uuid)'::regprocedure`)).rows[0];
    assert.deepEqual(helper, { definer: true, config: ['search_path=""'], anon: false, staff: false });
    for (const fn of ['public.ac_session_create(uuid,text,text[])', 'public.ac_session_set_status(uuid,text)']) {
      assert.deepEqual((await db.query(`select prosecdef definer, proconfig config,
        has_function_privilege('anon',oid,'execute') anon, has_function_privilege('authenticated',oid,'execute') staff
        from pg_proc where oid=$1::regprocedure`, [fn])).rows[0], { definer: true, config: ['search_path=""'], anon: false, staff: true }, fn);
    }
  });

  await t.test('bez pakietu: brak wiersza, available=0, inny pakiet i pakiet innej firmy dają PT402', async () => {
    await assert.rejects(create(a), packageRequired, 'no entitlement row');
    await setEntitlement(a.companyId, 'package:ASSESSMENT_CENTER', 0);
    await assert.rejects(create(a), packageRequired, 'available = 0');
    await setEntitlement(a.companyId, 'package:WERYFIKACJA', 1);
    await assert.rejects(create(a), packageRequired, 'another package');
    await setEntitlement(b.companyId, 'package:ASSESSMENT_CENTER', 1);
    await assert.rejects(create(a), packageRequired, 'package of another company');
    await h.asAdmin();
    assert.equal((await db.query('select count(*)::int n from private.ac_sessions where company_id=$1', [a.companyId])).rows[0].n, 0);
  });

  await t.test('osoba spoza firmy i rekruter dostają tę samą odmowę co przed bramką (nie PT402), z pakietem i bez', async () => {
    // B ma pakiet, A nie ma: właściciel B nie dowiaduje się niczego o A.
    await assert.rejects(create(a, users.otherOwner), forbidden);
    await assert.rejects(create(a, users.outsider), forbidden);
    await assert.rejects(create(a, users.recruiter), forbidden);
    await setEntitlement(a.companyId, 'package:ASSESSMENT_CENTER', 1);
    await assert.rejects(create(a, users.otherOwner), forbidden);
    await assert.rejects(create(a, users.recruiter), forbidden);
  });

  await t.test('z pakietem: właściciel tworzy i otwiera sesję; zamknięcie nie wymaga pakietu', async () => {
    await e.grantAcPackage(a);
    const { sessionId } = await e.plan(a, { acPackage: false });
    await e.addFinalist(sessionId, a);
    await e.setStatus(sessionId, 'open');
    await setEntitlement(a.companyId, 'package:ASSESSMENT_CENTER', 0);
    await h.asUser(a.owner);
    await e.setStatus(sessionId, 'closed');
    await h.asAdmin();
    assert.equal((await db.query('select status from private.ac_sessions where id=$1', [sessionId])).rows[0].status, 'closed');
  });

  await t.test('szkic bez pakietu nie otwiera się (PT402); po przyznaniu pakietu otwiera się', async () => {
    const c = await e.finalist(users.viewer);
    await e.grantAcPackage(c);
    const { sessionId } = await e.plan(c, { acPackage: false, template: hrbpCaseTemplate });
    await e.addFinalist(sessionId, c);
    await setEntitlement(c.companyId, 'package:ASSESSMENT_CENTER', 0);
    await h.asUser(c.owner);
    await assert.rejects(e.setStatus(sessionId, 'open'), packageRequired);
    await h.asAdmin();
    assert.equal((await db.query('select status from private.ac_sessions where id=$1', [sessionId])).rows[0].status, 'draft');
    await setEntitlement(c.companyId, 'package:ASSESSMENT_CENTER', 2);
    await h.asUser(c.owner);
    await e.setStatus(sessionId, 'open');
    // Pakiet nie jest zużywany przez sesję.
    await h.asAdmin();
    assert.deepEqual((await db.query("select available, used from sc19_commerce.entitlements where company_id=$1 and code='package:ASSESSMENT_CENTER'", [c.companyId])).rows[0], { available: 2, used: 0 });
  });

  await t.test('ponowne uruchomienie odmawia; rollback przywraca R16 bez zmiany sygnatury; migracja wraca', async () => {
    const before = await signature();
    await assert.rejects(db.query(await sql(`migrations/${migration}`)), /r3_ac_package_gate_already_installed/);
    await db.query('rollback').catch(() => {});
    await db.query(await sql(`rollbacks/${migration.replace('.sql', '_down.sql')}`));
    assert.equal(await signature(), before);
    assert.equal((await db.query("select to_regprocedure('private.ac_package_required(uuid)') is null gone")).rows[0].gone, true);
    const d = await e.finalist(users.outsider);
    await setEntitlement(d.companyId, 'package:ASSESSMENT_CENTER', 0);
    assert.ok(await create(d), 'R16 behaviour: no package check after rollback');
    await h.asAdmin();
    await db.query(await sql(`rollbacks/${migration.replace('.sql', '_down.sql')}`));
    await db.query(await sql(`migrations/${migration}`));
    assert.equal(await signature(), before);
    const g = await e.finalist(users.recruiter);
    await assert.rejects(create(g), packageRequired);
  });
});
