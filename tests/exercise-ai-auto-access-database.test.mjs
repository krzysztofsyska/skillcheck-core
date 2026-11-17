import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { activeBoot, users } from './helpers/competency-active-fixture.mjs';

// R1-AUTO-ACCESS (20261117200000_r1_auto_competency_access.sql): w trybie automatycznym
// dostęp do zwolnionego testu AI powstaje bez kliknięcia, tylko dla krótkiej listy (R1 w bazie).
const migration = '20261117200000_r1_auto_competency_access.sql';
const denied = (...codes) => error => codes.includes(error.code);
const autoKey = (application, definition) => {
  const hex = createHash('md5').update(`r1-auto-access:${application}:${definition}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

test('R1-AUTO-ACCESS: tryb automatyczny wydaje dostęp tylko krótkiej liście; tryb ręczny, obca firma i powtórka nic nie wydają', async t => {
  const e = await activeBoot(t, { fullChain: true }), { db, h, call } = e;
  await h.asAdmin();
  const acl = (await db.query(`select proacl::text acl, prosecdef, pg_get_userbyid(proowner) owner from pg_proc
    where oid='public.issue_exercise_ai_auto_access(uuid,uuid)'::regprocedure`)).rows[0];
  assert.deepEqual(acl, { acl: '{postgres=X/postgres,authenticated=X/postgres}', prosecdef: true, owner: 'postgres' });
  const signature = (await db.query('select private.erasure_schema_signature() s')).rows[0].s;

  // f i g: na krótkiej liście; n: poza nią. Każdy seed dokłada też własną definicję testu.
  const f = await e.seed(), g = await e.seed({ tenant: f }), n = await e.seed({ tenant: f, shortlist: false });
  const other = await e.seed({ owner: users.otherOwner });
  await h.asAdmin();
  await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter'),($1,$3,'viewer')",
    [f.companyId, users.recruiter, users.viewer]);
  const provenance = x => JSON.stringify({ provider: 'synthetic', model: 'fixture', prompt_version: 'v1', payload_schema_version: 1,
    result_schema_version: 1, input_fingerprint: 'a'.repeat(64), position_id: x.position.id, position_updated_at: x.position.updated_at });
  const record = async (x, definitionId) => {
    await h.asUser(x.owner);
    await db.query('select exercise_ai.record_proposal($1,$2,$3::jsonb,20)', [x.recruitment.id, definitionId, provenance(x)]);
  };
  const issue = (company = f.companyId, recruitment = f.recruitment.id) =>
    call('public.issue_exercise_ai_auto_access', [company, recruitment]);
  const grants = async () => { await h.asAdmin();
    return (await db.query(`select application_id, definition_entry_id, issuance_request_key, created_by, start_by_at > now() + interval '6 days' as window_ok
      from private.competency_test_grants where recruitment_id=$1 order by application_id, definition_entry_id`, [f.recruitment.id])).rows; };

  // Zadanie AI zatwierdzone przez rekrutera (f.definitionId) i drugie, niezatwierdzone (g.definitionId).
  await record(f, f.definitionId);
  await h.asUser(f.owner);await db.query('select exercise_ai.approve_proposal($1)', [f.definitionId]);
  await record(f, g.definitionId);

  // Tryb ręczny (brak ustawienia): nic nie jest wydawane.
  await h.asUser(users.recruiter);
  assert.deepEqual(await issue(), { autoRelease: false, issued: 0, access: [] });
  assert.deepEqual(await grants(), []);

  // Obca firma, czytelnik, anonim, rekrutacja innej firmy i nieistniejąca: ten sam błąd, nic nie wydane.
  await h.asUser(f.owner);
  assert.equal(await call('public.set_exercise_ai_auto_release', [f.companyId, f.recruitment.id, true]), true);
  for (const [actor, role, company, recruitment] of [
    [users.otherOwner, 'authenticated', f.companyId, f.recruitment.id],
    [users.otherOwner, 'authenticated', other.companyId, f.recruitment.id],
    [users.viewer, 'authenticated', f.companyId, f.recruitment.id],
    [null, 'anon', f.companyId, f.recruitment.id],
    [f.owner, 'authenticated', f.companyId, other.recruitment.id],
    [f.owner, 'authenticated', f.companyId, randomUUID()],
  ]) {
    await h.asUser(actor, role);
    await assert.rejects(issue(company, recruitment), denied('42501'), `${actor}/${company}/${recruitment}`);
  }
  assert.deepEqual(await grants(), []);

  // Rozliczenie jak przy ręcznym wydaniu: przy włączonym liczeniu testów brak jednostek
  // (albo za mało na wszystkich) przerywa całe wywołanie; nic nie jest wydane ani zużyte.
  const units = async () => { await h.asAdmin();
    return (await db.query("select available, used from sc19_commerce.entitlements where company_id=$1 and code='skill_test'", [f.companyId])).rows[0]; };
  await h.asAdmin();
  await db.exec('update sc19_commerce.settings set skill_test_metering=true');
  await h.asUser(users.recruiter);
  await assert.rejects(issue(), denied('PT422'), 'brak jednostek: nic nie wychodzi');
  assert.deepEqual(await grants(), []);
  await h.asAdmin();
  await db.query("insert into sc19_commerce.entitlements(company_id, code, available) values($1, 'skill_test', 1)", [f.companyId]);
  await h.asUser(users.recruiter);
  await assert.rejects(issue(), denied('PT422'), 'jednostka na jeden z dwóch dostępów: nic nie wychodzi');
  assert.deepEqual(await grants(), []);
  assert.deepEqual(await units(), { available: 1, used: 0 }, 'przerwane wywołanie niczego nie zużywa');
  await db.query("update sc19_commerce.entitlements set available=3 where company_id=$1 and code='skill_test'", [f.companyId]);

  // Tryb automatyczny: dostęp tylko dla f i g (krótka lista), tylko do zwolnionego testu, nie dla n.
  await h.asUser(users.recruiter);
  const first = await issue();
  assert.equal(first.autoRelease, true);
  assert.equal(first.issued, 2);
  const issued = await grants();
  assert.deepEqual(issued.map(r => [r.application_id, r.definition_entry_id]).sort(),
    [[f.application.id, f.definitionId], [g.application.id, f.definitionId]].sort());
  for (const r of issued) {
    assert.equal(r.issuance_request_key, autoKey(r.application_id, r.definition_entry_id), 'klucz wydania oznacza automat');
    assert.equal(r.created_by, users.recruiter);
    assert.equal(r.window_ok, true);
  }
  assert.equal(issued.some(r => r.application_id === n.application.id), false, 'R1: brak dostępu poza krótką listą');
  assert.equal(issued.some(r => r.definition_entry_id === g.definitionId), false, 'niezatwierdzone zadanie AI nie wychodzi');
  assert.equal((await db.query("select count(*)::int c from private.competency_test_grant_events where recruitment_id=$1 and kind='issued'", [f.recruitment.id])).rows[0].c, 2);
  assert.equal(first.access.length, 2);
  assert.ok(first.access.every(x => x.definitionId === f.definitionId && x.revision === 1 && x.revoked === false && x.title));
  assert.equal(JSON.stringify(first).includes('token'), false, 'sekret linku nie jest zwracany');
  assert.deepEqual(await units(), { available: 1, used: 2 }, 'jedna jednostka na każdy nowy dostęp');

  // Powtórka jest idempotentna.
  await h.asUser(f.owner);
  const second = await issue();
  assert.equal(second.issued, 0);
  assert.equal(second.access.length, 2);
  assert.equal((await grants()).length, 2);
  assert.deepEqual(await units(), { available: 1, used: 2 }, 'powtórka niczego nie zużywa');

  // Odwołany dostęp nie wraca przy kolejnym wywołaniu.
  await h.asUser(f.owner);
  const revokedId = first.access.find(x => x.applicationId === g.application.id).grantId;
  await call('public.revoke_competency_test_grant', [revokedId, randomUUID()]);
  assert.equal((await issue()).issued, 0);

  // Link do przekazania: istniejąca rotacja C3 zwraca nowy sekret dla dostępu wydanego automatycznie.
  const own = first.access.find(x => x.applicationId === f.application.id);
  const rotated = await call('public.rotate_competency_test_grant', [own.grantId, own.revision, randomUUID()]);
  assert.match(rotated.token, /^[0-9a-f]{64}$/);

  // Kandydat dopisany później do krótkiej listy dostaje dostęp przy następnym wywołaniu.
  await h.asUser(f.owner);
  await h.completedApplication(n, ['meets', 'meets', 'meets', 'meets', 'meets']);
  const entry = await h.add(n);
  await h.asUser(f.owner);
  assert.equal((await issue()).issued, 1);
  assert.deepEqual(await units(), { available: 0, used: 3 });
  // Usunięcie z krótkiej listy blokuje rotację (R1 przy każdym użyciu) i nic nie jest wydawane ponownie.
  await h.asUser(f.owner);
  await h.remove(entry);
  assert.equal((await issue()).issued, 0);
  assert.deepEqual(await units(), { available: 0, used: 3 }, 'bez nowego dostępu nic nie jest zużywane');

  // Rekrutacja zamknięta: nic nie jest wydawane (nowy kandydat z krótkiej listy czeka).
  const late = await e.seed({ tenant: f });
  await h.asAdmin();
  await db.query("update public.recruitments set status='closed' where id=$1", [f.recruitment.id]);
  await h.asUser(f.owner);
  assert.equal((await issue()).issued, 0);
  await h.asAdmin();
  assert.equal((await db.query('select count(*)::int c from private.competency_test_grants where application_id=$1', [late.application.id])).rows[0].c, 0);

  // Sygnatura SC-010 bez zmian, rollback usuwa tylko funkcję i nie kasuje wydanych dostępów.
  assert.equal((await db.query('select private.erasure_schema_signature() s')).rows[0].s, signature);
  const before = (await db.query('select count(*)::int c from private.competency_test_grants')).rows[0].c;
  await db.exec(await readFile(new URL(`../supabase/rollbacks/${migration.replace('.sql', '_down.sql')}`, import.meta.url), 'utf8'));
  assert.equal((await db.query("select to_regprocedure('public.issue_exercise_ai_auto_access(uuid,uuid)') p")).rows[0].p, null);
  assert.equal((await db.query('select count(*)::int c from private.competency_test_grants')).rows[0].c, before);
  assert.equal((await db.query('select private.erasure_schema_signature() s')).rows[0].s, signature);
  // Ponowna instalacja na tym samym schemacie działa (preflight sprawdza zależności, nie dane).
  await db.exec(await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8'));
  await assert.rejects(db.exec(await readFile(new URL(`../supabase/migrations/${migration}`, import.meta.url), 'utf8')), denied('55000'));
});

test('R1-AUTO-ACCESS native PostgreSQL: przełączenie na tryb ręczny w trakcie wywołania wygrywa', async t => {
  if (process.env.SC_WER_PGLITE_PATH) { t.skip('Native independent connections required'); return; }
  const e = await activeBoot(t, { fullChain: true }), { db, h, call } = e;
  const rival = await e.connect(), observer = await e.connect();
  const f = await e.seed();
  await h.asUser(f.owner);
  await db.query('select exercise_ai.record_proposal($1,$2,$3::jsonb,20)', [f.recruitment.id, f.definitionId, JSON.stringify({
    provider: 'synthetic', model: 'fixture', prompt_version: 'v1', payload_schema_version: 1, result_schema_version: 1,
    input_fingerprint: 'a'.repeat(64), position_id: f.position.id, position_updated_at: f.position.updated_at })]);
  await db.query('select exercise_ai.approve_proposal($1)', [f.definitionId]);
  assert.equal(await call('public.set_exercise_ai_auto_release', [f.companyId, f.recruitment.id, true]), true);

  await rival.exec('reset role;set role authenticated');
  await rival.query("select set_config('request.jwt.claim.sub',$1,false)", [f.owner]);
  await rival.exec('begin');
  let pending;
  try {
    assert.equal(await call('public.set_exercise_ai_auto_release', [f.companyId, f.recruitment.id, false], rival), false);
    await h.asUser(f.owner);
    let settled = false;
    pending = call('public.issue_exercise_ai_auto_access', [f.companyId, f.recruitment.id]).finally(() => { settled = true; });
    pending.catch(() => {});
    // Wywołanie musi czekać na blokadę wiersza ustawień, a nie czytać starego trybu.
    let waiting = false;
    for (let i = 0; i < 60 && !settled && !waiting; i++) {
      waiting = (await observer.query("select count(*)::int c from pg_stat_activity where datname=current_database() and wait_event_type='Lock'")).rows[0].c > 0;
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(waiting, true, 'wywołanie czeka na trwające przełączenie trybu');
    await rival.exec('commit');
  } finally { await rival.exec('rollback').catch(() => {}); }
  assert.deepEqual(await pending, { autoRelease: false, issued: 0, access: [] });
  await h.asAdmin();
  assert.equal((await db.query('select count(*)::int c from private.competency_test_grants where recruitment_id=$1', [f.recruitment.id])).rows[0].c, 0);
});
