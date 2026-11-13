// SC-020-B — domeny klienta: cykl życia, weryfikacja tylko przez rolę
// weryfikatora, jeden host = jedna firma, przejęcie wiszącej domeny,
// uprawnienia (tylko właściciel), rozpoznanie hosta. Natywny PostgreSQL,
// pełny łańcuch migracji, dwie syntetyczne firmy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootMigrationDatabase } from './helpers/sc19-migration-fixture.mjs';
import { setupRankingDatabase, users } from './helpers/screening-ranking-fixture.mjs';

const migration = '20261109200000_sc020_customer_domains.sql';
// Full current chain: R16 since SC-AC-SESSION (#276). SC-020 itself stays outside the inventory.
const signature = '8ad238e75d4d4ccb82e03b89f368ba06483580781494fe1f7f9306a3c9c7f73f';
const code = (...codes) => error => codes.includes(error.code);
const forbidden = code('42501');

async function boot(t) {
  const env = await bootMigrationDatabase(t);
  const { db } = env;
  const h = await setupRankingDatabase(db, { throughMigration: null });
  await h.asAdmin();
  assert.equal((await db.query("select count(*)::int n from pg_namespace where nspname='tenant_domains'")).rows[0].n, 1,
    `${migration} must be part of the checked-in chain`);
  const a = await h.seed(users.owner, 'A');
  const b = await h.seed(users.otherOwner, 'B');
  await h.asAdmin();
  await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter'),($1,$3,'viewer')",
    [a.companyId, users.recruiter, users.viewer]);
  const call = async (sql, args) => (await db.query(sql, args)).rows;
  const as = async user => h.asUser(user);
  const claim = async (company, host, kind = 'custom', user = users.owner) => {
    await as(user);
    return (await call('select * from public.tenant_domain_claim($1,$2,$3)', [company, host, kind]))[0];
  };
  const state = async (company, user = users.owner) => {
    await as(user);
    return (await call('select public.tenant_domain_state($1) s', [company]))[0].s;
  };
  const verifier = async () => { await db.exec('reset role'); await db.exec('set role tenant_domain_verifier'); };
  const ownerOf = { [a.companyId]: users.owner, [b.companyId]: users.otherOwner };
  const dns = async (company, id, token, ok, actor = ownerOf[company]) => {
    await verifier();
    return (await call('select tenant_domains.record_dns_check($1,$2,$3,$4,$5) r', [company, id, token, ok, actor]))[0].r;
  };
  const tls = async (company, id, token, ok, actor = ownerOf[company]) => {
    await verifier();
    return (await call('select tenant_domains.record_tls_check($1,$2,$3,$4,$5) r', [company, id, token, ok, actor]))[0].r;
  };
  const owner = async (fn, company, id, user = users.owner) => {
    await as(user);
    return (await call(`select public.${fn}($1,$2) r`, [company, id]))[0].r;
  };
  const resolve = async (host, role = 'anon') => {
    await h.asUser(null, role);
    return (await call('select public.tenant_domain_resolve($1) c', [host]))[0].c;
  };
  const activeDomain = async (company, host, user) => {
    const c = await claim(company, host, 'custom', user);
    assert.equal(await dns(company, c.domain_id, c.verification_token, true), 'verified');
    await tls(company, c.domain_id, c.verification_token, true);
    assert.equal(await owner('tenant_domain_activate', company, c.domain_id, user), 'active');
    return c;
  };
  return { ...env, db, h, a, b, call, as, claim, state, verifier, dns, tls, owner, resolve, activeDomain };
}

test('SC-020-B customer domains: lifecycle, isolation, takeover and permissions', async t => {
  const e = await boot(t);
  const { db, h, a, b } = e;

  await t.test('installs outside the SC-010 inventory; tables hidden from API roles', async () => {
    await h.asAdmin();
    assert.equal((await db.query('select private.erasure_schema_signature() v')).rows[0].v, signature);
    for (const role of ['anon', 'authenticated']) {
      const usage = (await db.query("select has_schema_privilege($1,'tenant_domains','USAGE') u", [role])).rows[0].u;
      assert.equal(usage, false, `${role} must not see schema tenant_domains`);
    }
    const verifierRole = (await db.query("select rolcanlogin, rolbypassrls, rolsuper from pg_roles where rolname='tenant_domain_verifier'")).rows[0];
    assert.deepEqual(verifierRole, { rolcanlogin: false, rolbypassrls: false, rolsuper: false });
    // Weryfikator nie może czytać tabel ani wołać funkcji właściciela.
    for (const table of ['domains', 'events', 'settings']) {
      assert.equal((await db.query(`select has_table_privilege('tenant_domain_verifier','tenant_domains.${table}','SELECT,INSERT,UPDATE,DELETE') p`)).rows[0].p, false);
    }
    const anonExec = (await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where (n.nspname='tenant_domains' or p.proname like 'tenant_domain%') and has_function_privilege('anon',p.oid,'EXECUTE') order by 1`)).rows.map(r => r.proname);
    assert.deepEqual(anonExec, ['tenant_domain_resolve']);
    const verifierExec = (await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='tenant_domains' and has_function_privilege('tenant_domain_verifier',p.oid,'EXECUTE') order by 1`)).rows.map(r => r.proname);
    // SC-020-D's scheduled re-verification functions belong to a separate role (tenant_domain_reverifier), not this one.
    assert.deepEqual(verifierExec, ['record_dns_check', 'record_tls_check', 'verifier_target']);
    assert.equal((await db.query("select has_function_privilege('authenticated','tenant_domains.require_acting_owner(uuid,uuid)','EXECUTE') p")).rows[0].p, false);
  });

  await t.test('only the company owner manages domains; recruiters, viewers, outsiders and the other tenant are refused', async () => {
    for (const user of [users.recruiter, users.viewer, users.outsider, users.otherOwner]) {
      await assert.rejects(e.claim(a.companyId, 'kariera.firma-a.pl', 'custom', user), forbidden);
      await assert.rejects(e.state(a.companyId, user), forbidden);
    }
    await h.asUser(null, 'anon');
    await assert.rejects(db.query("select * from public.tenant_domain_claim($1,'kariera.firma-a.pl','custom')", [a.companyId]), forbidden);
  });

  await t.test('invalid and reserved hostnames are refused', async () => {
    for (const host of ['Kariera.Firma.pl', 'kariera.firma.pl.', '-bad.firma.pl', 'firma', '10.0.0.1', 'a..pl',
      'kariera.firma.pl:443', 'ex ample.pl', 'x'.repeat(64) + '.pl', 'kariera_firma.pl']) {
      await assert.rejects(e.claim(a.companyId, host), code('22023'), host);
    }
    for (const host of ['skillcheck.pl', 'app.skillcheck.pl', 'evil.vercel.app', 'db.supabase.co', 'intranet.local', 'localhost.localdomain']) {
      await assert.rejects(e.claim(a.companyId, host), code('22023', '23514'), host);
    }
    await assert.rejects(e.claim(a.companyId, 'acme.skillcheck.pl', 'subdomain'), code('55000'), 'subdomains disabled by default');
  });

  await t.test('owner cannot self-verify; only the verifier role records checks, and only with the current token', async () => {
    const c = await e.claim(a.companyId, 'kariera.firma-a.pl');
    assert.equal(c.status, 'pending');
    assert.match(c.verification_token, /^[0-9a-f]{64}$/);
    await e.as(users.owner);
    await assert.rejects(db.query('select tenant_domains.record_dns_check($1,$2,$3,true,$4)', [a.companyId, c.domain_id, c.verification_token, users.owner]), forbidden);
    await assert.rejects(db.query("update tenant_domains.domains set status='active'"), forbidden);
    await assert.rejects(e.owner('tenant_domain_activate', a.companyId, c.domain_id), code('55000'));
    await assert.rejects(e.dns(a.companyId, c.domain_id, '0'.repeat(64), true), code('PT409'));
    await assert.rejects(e.dns(a.companyId, c.domain_id, null, true), code('PT409'), 'NULL token never passes the stale guard');
    await assert.rejects(e.dns(a.companyId, c.domain_id, c.verification_token, true, users.recruiter), forbidden, 'actor must be the owner');
    await assert.rejects(e.dns(a.companyId, c.domain_id, c.verification_token, true, null), forbidden);
    // Weryfikator nie przestawi domeny innej firmy, podając jej identyfikator z cudzą firmą.
    await assert.rejects(e.dns(b.companyId, c.domain_id, c.verification_token, true), code('P0002'));
    assert.equal(await e.dns(a.companyId, c.domain_id, c.verification_token, false), 'pending');
    assert.equal(await e.dns(a.companyId, c.domain_id, c.verification_token, true), 'verified');
    await assert.rejects(e.owner('tenant_domain_activate', a.companyId, c.domain_id), code('55000'), 'TLS not ready');
    assert.equal(await e.resolve('kariera.firma-a.pl'), null, 'verified is not active');
    await e.tls(a.companyId, c.domain_id, c.verification_token, true);
    assert.equal(await e.owner('tenant_domain_activate', a.companyId, c.domain_id), 'active');
    assert.equal(await e.resolve('kariera.firma-a.pl'), a.companyId);
    assert.equal(await e.resolve('kariera.firma-a.pl', 'authenticated'), a.companyId);
    assert.equal(await e.resolve('KARIERA.firma-a.pl'), null, 'non-canonical host never resolves');
    assert.equal(await e.resolve('kariera.firma-a.pl.'), null);
    assert.equal(await e.resolve('unknown.firma-a.pl'), null);
  });

  await t.test('one host never maps to two companies; the other tenant cannot take a live host', async () => {
    const c = await e.claim(b.companyId, 'kariera.firma-a.pl', 'custom', users.otherOwner);
    assert.equal(c.status, 'pending');
    assert.equal(await e.dns(b.companyId, c.domain_id, c.verification_token, true), 'conflict');
    assert.equal(await e.resolve('kariera.firma-a.pl'), a.companyId);
    await h.asAdmin();
    await assert.rejects(db.query(`insert into tenant_domains.domains(company_id,hostname,kind,status,verification_token,created_by,verified_at,last_verified_at)
      values($1,'kariera.firma-a.pl','custom','verified',tenant_domains.new_token(),$2,now(),now())`, [b.companyId, users.otherOwner]), code('23505'));
    await assert.rejects(e.claim(a.companyId, 'kariera.firma-a.pl'), code('23505'), 'no duplicate open claim in one company');
    await e.owner('tenant_domain_revoke', b.companyId, c.domain_id, users.otherOwner);
  });

  await t.test('revocation is final; reclaiming needs a new token and full verification', async () => {
    const before = (await e.state(a.companyId)).domains.find(d => d.hostname === 'kariera.firma-a.pl');
    assert.equal(await e.owner('tenant_domain_revoke', a.companyId, before.id), 'revoked');
    assert.equal(await e.resolve('kariera.firma-a.pl'), null);
    await assert.rejects(e.owner('tenant_domain_activate', a.companyId, before.id), code('55000'));
    await assert.rejects(e.dns(a.companyId, before.id, before.verification_token, true), code('PT409'));
    await h.asAdmin();
    await assert.rejects(db.query("update tenant_domains.domains set status='active' where id=$1", [before.id]), forbidden);
    // Teraz host może przejąć firma B, ale wyłącznie przez własną weryfikację DNS.
    const c = await e.claim(b.companyId, 'kariera.firma-a.pl', 'custom', users.otherOwner);
    assert.notEqual(c.verification_token, before.verification_token);
    assert.equal(await e.resolve('kariera.firma-a.pl'), null);
    assert.equal(await e.dns(b.companyId, c.domain_id, c.verification_token, true), 'verified');
    await e.tls(b.companyId, c.domain_id, c.verification_token, true);
    await e.owner('tenant_domain_activate', b.companyId, c.domain_id, users.otherOwner);
    assert.equal(await e.resolve('kariera.firma-a.pl'), b.companyId);
    const again = await e.claim(a.companyId, 'kariera.firma-a.pl');
    assert.equal(await e.dns(a.companyId, again.domain_id, again.verification_token, true), 'conflict');
    await e.owner('tenant_domain_revoke', a.companyId, again.domain_id);
  });

  await t.test('dangling domain: a stale verification stops resolving and a failed re-check demotes it', async () => {
    const c = await e.activeDomain(a.companyId, 'praca.firma-a.pl', users.owner);
    assert.equal(await e.resolve('praca.firma-a.pl'), a.companyId);
    await h.asAdmin();
    await db.query("alter table tenant_domains.domains disable trigger domains_guard");
    await db.query("update tenant_domains.domains set last_verified_at = now() - interval '31 days' where id=$1", [c.domain_id]);
    await db.query("alter table tenant_domains.domains enable trigger domains_guard");
    assert.equal(await e.resolve('praca.firma-a.pl'), null, 'stale verification never resolves');
    assert.equal(await e.dns(a.companyId, c.domain_id, c.verification_token, false), 'pending');
    const d = (await e.state(a.companyId)).domains.find(x => x.id === c.domain_id);
    assert.equal(d.status, 'pending');
    assert.equal(d.tls_ready_at, null);
    assert.equal(await e.dns(a.companyId, c.domain_id, c.verification_token, true), 'verified');
    await assert.rejects(e.owner('tenant_domain_activate', a.companyId, c.domain_id), code('55000'), 'TLS must be checked again');
  });

  await t.test('an abandoned (stale) holder never blocks the current DNS owner; a fresh holder does', async () => {
    const c = await e.activeDomain(a.companyId, 'porzucona.firma-a.pl', users.owner);
    const other = await e.claim(b.companyId, 'porzucona.firma-a.pl', 'custom', users.otherOwner);
    assert.equal(await e.dns(b.companyId, other.domain_id, other.verification_token, true), 'conflict', 'fresh holder wins');
    await h.asAdmin();
    await db.query("alter table tenant_domains.domains disable trigger domains_guard");
    await db.query("update tenant_domains.domains set last_verified_at = now() - interval '200 days' where id=$1", [c.domain_id]);
    await db.query("alter table tenant_domains.domains enable trigger domains_guard");
    assert.equal(await e.dns(b.companyId, other.domain_id, other.verification_token, true), 'verified');
    const old = (await e.state(a.companyId)).domains.find(x => x.id === c.domain_id);
    assert.equal(old.status, 'pending');
    assert.equal(old.tls_ready_at, null);
    await h.asAdmin();
    const lapsed = (await db.query("select actor from tenant_domains.events where domain_id=$1 and action='verification_lapsed'", [c.domain_id])).rows;
    assert.equal(lapsed.length, 1);
    const verifiedBy = (await db.query("select actor from tenant_domains.events where domain_id=$1 and action='verified'", [other.domain_id])).rows;
    assert.deepEqual(verifiedBy, [{ actor: users.otherOwner }], 'the clicking owner is recorded');
    await e.owner('tenant_domain_revoke', b.companyId, other.domain_id, users.otherOwner);
    await e.owner('tenant_domain_revoke', a.companyId, c.domain_id);
  });

  await t.test('a fresh verification survives a single failed re-check; TLS failure never drops an active host', async () => {
    const c = await e.activeDomain(b.companyId, 'jobs.firma-b.pl', users.otherOwner);
    assert.equal(await e.dns(b.companyId, c.domain_id, c.verification_token, false), 'active');
    assert.equal(await e.tls(b.companyId, c.domain_id, c.verification_token, false), 'active');
    assert.equal(await e.resolve('jobs.firma-b.pl'), b.companyId);
    assert.equal(await e.owner('tenant_domain_deactivate', b.companyId, c.domain_id, users.otherOwner), 'verified');
    assert.equal(await e.resolve('jobs.firma-b.pl'), null);
  });

  await t.test('expired pending claims are revoked lazily', async () => {
    const c = await e.claim(a.companyId, 'stare.firma-a.pl');
    await h.asAdmin();
    await db.query("alter table tenant_domains.domains disable trigger domains_guard");
    await db.query("update tenant_domains.domains set pending_expires_at = now() - interval '1 minute' where id=$1", [c.domain_id]);
    await db.query("alter table tenant_domains.domains enable trigger domains_guard");
    const d = (await e.state(a.companyId)).domains.find(x => x.id === c.domain_id);
    assert.equal(d.status, 'revoked');
    assert.equal(d.revoke_reason, 'expired');
    assert.equal(d.verification_token, null, 'revoked tokens are not shown');
  });

  await t.test('platform subdomains: reserved labels, uniqueness and quarantine across tenants', async () => {
    await h.asAdmin();
    await db.query("update tenant_domains.settings set subdomain_base='klienci.skillcheck.pl'");
    for (const host of ['www.klienci.skillcheck.pl', 'ab.klienci.skillcheck.pl', 'a.b.klienci.skillcheck.pl', 'xn--80ak6aa92e.klienci.skillcheck.pl']) {
      await assert.rejects(e.claim(a.companyId, host, 'subdomain'), code('22023'), host);
    }
    await assert.rejects(e.claim(a.companyId, 'acme.klienci.skillcheck.pl', 'custom'), code('22023'), 'platform zone is not a custom domain');
    const s = await e.claim(a.companyId, 'acme.klienci.skillcheck.pl', 'subdomain');
    assert.equal(s.status, 'verified');
    await assert.rejects(e.claim(b.companyId, 'acme.klienci.skillcheck.pl', 'subdomain', users.otherOwner), code('23505'));
    await e.tls(a.companyId, s.domain_id, s.verification_token, true);
    await e.owner('tenant_domain_activate', a.companyId, s.domain_id);
    assert.equal(await e.resolve('acme.klienci.skillcheck.pl'), a.companyId);
    await e.owner('tenant_domain_revoke', a.companyId, s.domain_id);
    await assert.rejects(e.claim(b.companyId, 'acme.klienci.skillcheck.pl', 'subdomain', users.otherOwner), code('23505'), 'quarantine');
    const back = await e.claim(a.companyId, 'acme.klienci.skillcheck.pl', 'subdomain');
    assert.notEqual(back.verification_token, s.verification_token);
    await h.asAdmin();
    await db.query("update tenant_domains.settings set subdomain_base=null");
  });

  await t.test('per-company limit and audit trail', async () => {
    const st = await e.state(a.companyId);
    const open = st.domains.filter(d => d.status !== 'revoked').length;
    for (let i = open; i < 5; i += 1) await e.claim(a.companyId, `limit${i}.firma-a.pl`);
    await assert.rejects(e.claim(a.companyId, 'limit-over.firma-a.pl'), code('54000'));
    const events = (await e.state(a.companyId)).events;
    assert.ok(events.length > 0 && events.length <= 50);
    for (const action of ['claimed', 'expired']) assert.ok(events.some(x => x.action === action), action);
    await h.asAdmin();
    const all = (await db.query('select action from tenant_domains.events where company_id=$1', [a.companyId])).rows.map(r => r.action);
    for (const action of ['claimed', 'verified', 'verification_failed', 'tls_ready', 'activated', 'revoked', 'verification_lapsed', 'verification_conflict'])
      assert.ok(all.includes(action), action);
    await assert.rejects(db.query('update tenant_domains.events set action=$1', ['claimed']), forbidden);
    await assert.rejects(db.query('delete from tenant_domains.events'), forbidden);
    await assert.rejects(db.query('delete from tenant_domains.domains'), forbidden);
    // Stan i dziennik firmy B nie zawierają żadnej domeny ani zdarzenia firmy A.
    const aIds = new Set((await e.state(a.companyId)).domains.map(d => d.id));
    const bState = await e.state(b.companyId, users.otherOwner);
    assert.ok(bState.domains.length > 0);
    for (const d of bState.domains) assert.ok(!aIds.has(d.id), d.hostname);
    for (const ev of bState.events) assert.ok(!aIds.has(ev.domain_id));
  });
});
