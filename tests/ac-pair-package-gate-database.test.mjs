// R3 SC-016b — nowa para asesorów poza sesją tylko dla firmy z opłaconym pakietem ASSESSMENT CENTER
// (20261127160000_r3_ac_pair_package_gate.sql). Natywny PostgreSQL 16/17, pełny łańcuch migracji.
// Sprawdza: bez pakietu public.ac_assign_pair odmawia (PT402) i nic nie zapisuje; z pakietem działa;
// osoba spoza firmy, właściciel innej firmy i rekruter dostają tę samą odmowę co wcześniej (42501 / PT404);
// ścieżka sesji (ac_session_assign_pair) działa w otwartej sesji także przy pakiecie available=0;
// para utworzona przed bramką (po rollbacku) dalej jest czytana i arkusze są oddawane bez pakietu;
// uprawnienia i security definer bez zmian; sygnatura SC-010 bez zmian; ponowne uruchomienie
// odmawia; dowód negatywny: po rollbacku para bez pakietu przechodzi (test wykrywa brak bramki). Dane fikcyjne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sessionBoot, users, sheetFor } from './helpers/ac-session-fixture.mjs';

const migration = '20261127160000_r3_ac_pair_package_gate.sql';
const rollback = migration.replace('.sql', '_down.sql');
const sql = path => readFile(new URL(`../supabase/${path}`, import.meta.url), 'utf8');
const code = (...codes) => error => codes.includes(error.code);
const forbidden = code('42501', 'PT404');
const packageRequired = error => error.code === 'PT402' && error.message === 'Assessment Center package required';

test('R3 SC-016b: nowa para asesorów poza sesją wymaga pakietu ASSESSMENT CENTER', async t => {
  const e = await sessionBoot(t, { throughMigration: null });
  const { db, h, call } = e;
  const signature = async () => { await h.asAdmin(); return (await db.query('select private.erasure_schema_signature() v')).rows[0].v; };
  const setPackage = async (companyId, available) => {
    await h.asAdmin();
    await db.query(`insert into sc19_commerce.entitlements(company_id,code,available) values($1,'package:ASSESSMENT_CENTER',$2)
      on conflict(company_id,code) do update set available=excluded.available`, [companyId, available]);
  };
  const rawAssign = async (f, user = f.owner, revision = f.definitionId) => {
    await h.asUser(user);
    return call('public.ac_assign_pair', [f.application.id, revision, f.owner, users.recruiter]);
  };
  const pairsOf = async f => { await h.asAdmin(); return (await db.query('select count(*)::int n from private.ac_paired_sheets where application_id=$1', [f.application.id])).rows[0].n; };
  const submitBoth = async (f, pairId) => {
    for (const user of [f.owner, users.recruiter]) {
      await h.asUser(user);
      await call('public.ac_submit_sheet', [pairId, JSON.stringify(sheetFor(f.definition))]);
    }
    await h.asUser(f.owner);
    return call('public.ac_read_pair', [pairId]);
  };

  await t.test('ac_assign_pair zachowuje uprawnienia, security definer i search_path', async () => {
    await h.asAdmin();
    assert.deepEqual((await db.query(`select prosecdef definer, proconfig config,
      has_function_privilege('anon',oid,'execute') anon, has_function_privilege('authenticated',oid,'execute') staff
      from pg_proc where oid='public.ac_assign_pair(uuid,uuid,uuid,uuid)'::regprocedure`)).rows[0],
    { definer: true, config: ['search_path=""'], anon: false, staff: true });
  });

  const a = await e.finalist();
  const b = await e.finalist(users.otherOwner);

  await t.test('bez pakietu (brak wiersza, available=0, pakiet innej firmy): PT402 i brak zapisu', async () => {
    await assert.rejects(rawAssign(a), packageRequired, 'no entitlement row');
    await setPackage(a.companyId, 0);
    await assert.rejects(rawAssign(a), packageRequired, 'available = 0');
    await setPackage(b.companyId, 1);
    await assert.rejects(rawAssign(a), packageRequired, 'package of another company');
    assert.equal(await pairsOf(a), 0);
  });

  await t.test('osoba spoza firmy, właściciel innej firmy i rekruter: ta sama odmowa co wcześniej, nie PT402', async () => {
    for (const available of [0, 1]) {
      await setPackage(a.companyId, available);
      for (const user of [users.otherOwner, users.outsider, users.recruiter]) await assert.rejects(rawAssign(a, user), forbidden, `${user} ${available}`);
    }
    await setPackage(a.companyId, 0);
    assert.equal(await pairsOf(a), 0);
  });

  await t.test('z pakietem: para poza sesją powstaje, arkusze oddane; pakiet nie jest zużywany', async () => {
    await setPackage(a.companyId, 1);
    const pairId = await rawAssign(a);
    assert.equal((await submitBoth(a, pairId)).state, 'ready');
    await h.asAdmin();
    assert.deepEqual((await db.query("select available, used from sc19_commerce.entitlements where company_id=$1 and code='package:ASSESSMENT_CENTER'", [a.companyId])).rows[0], { available: 1, used: 0 });
  });

  await t.test('ścieżka sesji: otwarta sesja przypisuje parę także przy pakiecie available=0', async () => {
    const c = await e.finalist(users.viewer);
    const { sessionId, stages } = await e.plan(c);
    await e.addFinalist(sessionId, c);
    // Draft session: the raw RPC on a stage revision keeps the R16 refusal (42501), never PT402.
    await setPackage(c.companyId, 0);
    await assert.rejects(rawAssign(c, c.owner, stages[0].definitionId), error => error.code === '42501' && /Session is not open/.test(error.message));
    await setPackage(c.companyId, 1);
    await h.asUser(c.owner);
    await e.setStatus(sessionId, 'open');
    await setPackage(c.companyId, 0);
    await h.asUser(c.owner);
    const pairId = await e.assign(sessionId, stages[0], c);
    assert.ok(pairId);
    assert.equal((await submitBoth({ ...c, definition: stages[0].definition }, pairId)).state, 'ready');
    // Still gated outside the session for the same company.
    await assert.rejects(rawAssign(c), packageRequired);
  });

  await t.test('para sprzed bramki: odczyt i oddanie arkuszy bez pakietu; ponowne uruchomienie odmawia; rollback = dowód negatywny', async () => {
    const before = await signature();
    await assert.rejects(db.query(await sql(`migrations/${migration}`)), /r3_ac_pair_package_gate_source_unreviewed/);
    await db.query('rollback').catch(() => {});
    await db.query(await sql(`rollbacks/${rollback}`));
    assert.equal(await signature(), before);
    // Negative proof: without the gate a company without the package assigns a pair.
    const d = await e.finalist(users.outsider);
    await setPackage(d.companyId, 0);
    const oldPair = await rawAssign(d);
    assert.ok(oldPair, 'R13 behaviour after rollback: no package check');
    await h.asAdmin();
    await db.query(await sql(`rollbacks/${rollback}`)); // idempotent
    await db.query(await sql(`migrations/${migration}`));
    assert.equal(await signature(), before);
    // The pair created before the gate keeps working without the package.
    await h.asUser(d.owner);
    assert.equal(await call('public.ac_find_pair', [d.application.id, d.definitionId]), oldPair);
    assert.equal((await call('public.ac_read_pair', [oldPair])).state, 'pending');
    assert.equal((await submitBoth(d, oldPair)).state, 'ready');
    // ...but a new pair for the same company is refused again.
    const g = await e.finalist(users.outsider);
    await assert.rejects(rawAssign(g), packageRequired);
    assert.equal(await pairsOf(g), 0);
  });
});
