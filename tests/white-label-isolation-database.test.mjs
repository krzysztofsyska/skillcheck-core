// SC-020-D — izolacja white-label w bazie: audyt uprawnień (schematy branding i
// tenant_domains, funkcje public.brand_* / public.tenant_domain_*, Storage),
// dwie firmy, próby obejścia przez obcą firmę i członków bez uprawnień,
// błędna/odwołana/nieświeża domena, przywracanie marki i domeny oraz
// cykliczna ponowna weryfikacja DNS (rola tenant_domain_verifier).
// Natywny PostgreSQL, pełny łańcuch migracji, dane syntetyczne.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { bootWhiteLabel, brandConfig, code, signature, users } from './helpers/white-label-fixture.mjs';
import { reverifyDueDomains } from '../lib/tenant-domain-reverify.ts';
import { reverifyStoreFromEnv } from '../lib/tenant-domain-network.ts';

const forbidden = code('42501');
const OWNER_RPCS = [
  'public.brand_register_asset(uuid,text,text,text,integer,text)', 'public.brand_save_draft(uuid,jsonb,uuid,uuid)',
  'public.brand_publish_draft(uuid,uuid,timestamp with time zone)', 'public.brand_rollback(uuid,uuid)', 'public.brand_editor_state(uuid)',
  'public.tenant_domain_claim(uuid,text,text)', 'public.tenant_domain_activate(uuid,uuid)', 'public.tenant_domain_deactivate(uuid,uuid)',
  'public.tenant_domain_revoke(uuid,uuid)', 'public.tenant_domain_state(uuid)',
];
const MEMBER_RPCS = ['public.brand_published(uuid)', 'public.brand_asset(uuid,uuid)'];
const VERIFIER_FUNCTIONS = [
  'tenant_domains.verifier_target(uuid,uuid)', 'tenant_domains.record_dns_check(uuid,uuid,text,boolean,uuid)',
  'tenant_domains.record_tls_check(uuid,uuid,text,boolean,uuid)', 'tenant_domains.reverify_due(integer)',
  'tenant_domains.record_scheduled_dns_check(uuid,uuid,text,boolean)',
];

test('SC-020-D white-label isolation: grants, cross-tenant access, domains, rollback, scheduled re-verification', async t => {
  const e = await bootWhiteLabel(t);
  const { db, h, a, b } = e;
  const rows = async (sql, args = []) => (await db.query(sql, args)).rows;

  await t.test('grant/RLS audit: every white-label object is reachable only through the reviewed functions', async () => {
    await h.asAdmin();
    assert.equal((await rows('select private.erasure_schema_signature() v'))[0].v, signature, 'SC-010 inventory signature unchanged');
    // Tables: RLS on, no privileges for API roles, schemas invisible to them.
    const tables = await rows(`select n.nspname, c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('branding','tenant_domains') and c.relkind in ('r','p','v','m') order by 1,2`);
    assert.ok(tables.length >= 6);
    for (const table of tables) {
      assert.equal(table.relrowsecurity, true, `${table.nspname}.${table.relname} has RLS`);
      for (const role of ['public', 'anon', 'authenticated', 'tenant_domain_verifier']) {
        const grantee = role === 'public' ? 'anon' : role;
        assert.equal((await rows(`select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') p`,
          [grantee, `${table.nspname}.${table.relname}`]))[0].p, false, `${role} on ${table.nspname}.${table.relname}`);
      }
    }
    for (const role of ['anon', 'authenticated']) {
      for (const schema of ['branding', 'tenant_domains']) {
        assert.equal((await rows("select has_schema_privilege($1,$2,'USAGE') u", [role, schema]))[0].u, false, `${role} usage ${schema}`);
      }
    }
    assert.equal((await rows("select has_schema_privilege('tenant_domain_verifier','branding','USAGE') u"))[0].u, false);
    // Functions inside the two schemas: nobody but the verifier (and only its five) may execute anything.
    const internal = await rows(`select p.oid::regprocedure::text fn from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname in ('branding','tenant_domains')`);
    for (const { fn } of internal) {
      for (const role of ['anon', 'authenticated']) {
        assert.equal((await rows("select has_function_privilege($1,$2,'EXECUTE') x", [role, fn]))[0].x, false, `${role} ${fn}`);
      }
      assert.equal((await rows("select has_function_privilege('tenant_domain_verifier',$1,'EXECUTE') x", [fn]))[0].x,
        VERIFIER_FUNCTIONS.includes(fn), `verifier ${fn}`);
    }
    for (const fn of VERIFIER_FUNCTIONS) assert.ok(internal.some(row => row.fn === fn), `${fn} exists`);
    // The public entry points: exact allow-list per role, all SECURITY DEFINER with an empty search_path.
    const entry = await rows(`select p.oid::regprocedure::text fn, p.prosecdef, p.proconfig from pg_proc p
      where p.pronamespace='public'::regnamespace and (p.proname like 'brand\\_%' or p.proname like 'tenant\\_domain\\_%')`);
    const expected = [...OWNER_RPCS, ...MEMBER_RPCS, 'public.tenant_domain_resolve(text)'].map(fn => fn.replace(/^public\./, '')).sort();
    assert.deepEqual(entry.map(row => row.fn.replace(/^public\./, '')).sort(), expected, 'no unreviewed white-label entry point');
    for (const row of entry) {
      assert.equal(row.prosecdef, true, `${row.fn} is security definer`);
      assert.ok(row.proconfig?.includes('search_path=""'), `${row.fn} pins search_path`);
      const fn = row.fn.startsWith('public.') ? row.fn : `public.${row.fn}`;
      const anon = (await rows("select has_function_privilege('anon',$1,'EXECUTE') x", [fn]))[0].x;
      const auth = (await rows("select has_function_privilege('authenticated',$1,'EXECUTE') x", [fn]))[0].x;
      const verifier = (await rows("select has_function_privilege('tenant_domain_verifier',$1,'EXECUTE') x", [fn]))[0].x;
      assert.equal(anon, fn === 'public.tenant_domain_resolve(text)', `anon ${fn}`);
      assert.equal(auth, true, `authenticated ${fn}`);
      assert.equal(verifier, false, `verifier ${fn}`);
    }
    const verifierRole = (await rows("select rolcanlogin, rolbypassrls, rolsuper, rolinherit from pg_roles where rolname='tenant_domain_verifier'"))[0];
    assert.deepEqual(verifierRole, { rolcanlogin: false, rolbypassrls: false, rolsuper: false, rolinherit: false }, 'no login was created');
    // Storage: private bucket, only SELECT and INSERT policies (no overwrite, no delete), both scoped by company.
    const policies = await rows("select policyname, cmd, roles::text[] roles from pg_policies where schemaname='storage' and tablename='objects' order by 1");
    assert.deepEqual(policies, [
      { policyname: 'sc020_brand_assets_insert', cmd: 'INSERT', roles: ['authenticated'] },
      { policyname: 'sc020_brand_assets_read', cmd: 'SELECT', roles: ['authenticated'] },
    ]);
    assert.equal((await rows("select public from storage.buckets where id='brand-assets'"))[0].public, false);
  });

  let logoA, logoB, v1, v2;
  await t.test('a published brand is readable only by members of its own company', async () => {
    logoA = await e.registerLogo(a.companyId);
    logoB = await e.registerLogo(b.companyId);
    v1 = await e.publishBrand(a.companyId, 'Alfa Jeden', logoA.assetId);
    v2 = await e.publishBrand(a.companyId, 'Alfa Dwa', logoA.assetId);
    await e.publishBrand(b.companyId, 'Beta', logoB.assetId);
    for (const user of [users.owner, users.recruiter, users.viewer]) {
      assert.equal((await e.published(a.companyId, user)).config.brandName, 'Alfa Dwa', user);
    }
    for (const user of [users.otherOwner, users.outsider]) {
      await e.as(user);
      await assert.rejects(db.query('select * from public.brand_published($1)', [a.companyId]), forbidden, user);
      await assert.rejects(db.query('select * from public.brand_asset($1,$2)', [a.companyId, logoA.assetId]), forbidden, user);
    }
    // B's owner asking for A's asset under B's own company id gets nothing (assets are bound to their company).
    await e.as(users.otherOwner);
    assert.equal((await rows('select * from public.brand_asset($1,$2)', [b.companyId, logoA.assetId])).length, 0);
    assert.equal((await rows('select * from public.brand_asset($1,$2)', [b.companyId, logoB.assetId])).length, 1);
    // A member of A reading A's asset through B's id: forbidden.
    await e.as(users.recruiter);
    await assert.rejects(db.query('select * from public.brand_asset($1,$2)', [b.companyId, logoB.assetId]), forbidden);
    assert.equal((await rows('select count(*)::int n from storage.objects where name like $1', [`${b.companyId}/%`]))[0].n, 0);
    await h.asUser(null, 'anon');
    for (const fn of ['brand_published($1)', 'brand_editor_state($1)', 'tenant_domain_state($1)']) {
      await assert.rejects(db.query(`select public.${fn}`, [a.companyId]), forbidden, `anon ${fn}`);
    }
  });

  await t.test('no edit by another company, a recruiter, a viewer or an outsider', async () => {
    const domainA = await e.activeDomain(a.companyId, 'kariera.firma-a.pl');
    await e.as(users.owner);
    const stateA = await e.one('select public.brand_editor_state($1)', [a.companyId]);
    const versionA = stateA.versions.find(v => v.id === v1).id;
    const calls = [
      ['select public.brand_save_draft($1,$2,null,null)', [a.companyId, JSON.stringify(brandConfig('Przejęta'))]],
      ['select public.brand_publish_draft($1,$2,now())', [a.companyId, randomUUID()]],
      ['select public.brand_rollback($1,$2)', [a.companyId, versionA]],
      ['select public.brand_editor_state($1)', [a.companyId]],
      ['select public.brand_register_asset($1,$2,$3,$4,$5,$6)', [a.companyId, 'logo', logoA.path, 'image/png', logoA.bytes.length, 'c'.repeat(64)]],
      ['select * from public.tenant_domain_claim($1,$2,$3)', [a.companyId, 'jobs.firma-a.pl', 'custom']],
      ['select public.tenant_domain_deactivate($1,$2)', [a.companyId, domainA.domain_id]],
      ['select public.tenant_domain_revoke($1,$2)', [a.companyId, domainA.domain_id]],
      ['select public.tenant_domain_activate($1,$2)', [a.companyId, domainA.domain_id]],
      ['select public.tenant_domain_state($1)', [a.companyId]],
    ];
    for (const user of [users.otherOwner, users.recruiter, users.viewer, users.outsider]) {
      for (const [sql, args] of calls) {
        await e.as(user);
        await assert.rejects(db.query(sql, args), forbidden, `${user}: ${sql}`);
      }
    }
    // Nothing changed for A.
    assert.equal((await e.published(a.companyId)).config.brandName, 'Alfa Dwa');
    assert.equal(await e.resolve('kariera.firma-a.pl'), a.companyId);
    // The wrong domain: A's owner naming B's domain, under either company id.
    const domainB = await e.activeDomain(b.companyId, 'jobs.firma-b.pl');
    await e.as(users.owner);
    await assert.rejects(db.query('select public.tenant_domain_revoke($1,$2)', [a.companyId, domainB.domain_id]), code('P0002'));
    await assert.rejects(db.query('select public.tenant_domain_revoke($1,$2)', [b.companyId, domainB.domain_id]), forbidden);
    // A host that already belongs to B cannot be claimed and verified by A.
    await e.as(users.owner);
    const steal = (await rows('select * from public.tenant_domain_claim($1,$2,$3)', [a.companyId, 'jobs.firma-b.pl', 'custom']))[0];
    await e.verifier();
    assert.equal(await e.one('select tenant_domains.record_dns_check($1,$2,$3,true,$4)', [a.companyId, steal.domain_id, steal.verification_token, users.owner]), 'conflict');
    assert.equal(await e.resolve('jobs.firma-b.pl'), b.companyId);
    // The verifier cannot act on behalf of another company's owner.
    await assert.rejects(db.query('select tenant_domains.record_dns_check($1,$2,$3,true,$4)',
      [b.companyId, domainB.domain_id, domainB.verification_token, users.owner]), forbidden);
  });

  await t.test('rollback: brand returns to an earlier version; a domain switched off stops resolving and comes back', async () => {
    await e.as(users.owner);
    await e.one('select public.brand_rollback($1,$2)', [a.companyId, v1]);
    const now = await e.published(a.companyId);
    assert.equal(now.config.brandName, 'Alfa Jeden');
    assert.notEqual(now.version_id, v1, 'rollback is a new published version, history stays');
    assert.notEqual(now.version_id, v2);
    const state = await e.one('select public.brand_editor_state($1)', [a.companyId]);
    assert.ok(state.events.some(ev => ev.action === 'rolled_back' && ev.actor === users.owner));
    assert.equal(state.versions.filter(v => v.status === 'published').length, 1, 'exactly one published version');
    assert.equal((await e.published(b.companyId)).config.brandName, 'Beta', 'B untouched');
    await h.asAdmin();
    await assert.rejects(db.query("update branding.versions set config='{}'::jsonb where id=$1", [v2]), error => /immutable|42501|55000|P0001/.test(`${error.code} ${error.message}`));

    await e.as(users.owner);
    const domain = (await e.one('select public.tenant_domain_state($1)', [a.companyId])).domains.find(d => d.hostname === 'kariera.firma-a.pl');
    await e.as(users.owner);
    await e.one('select public.tenant_domain_deactivate($1,$2)', [a.companyId, domain.id]);
    assert.equal(await e.resolve('kariera.firma-a.pl'), null, 'switched off');
    await e.as(users.owner);
    assert.equal(await e.one('select public.tenant_domain_activate($1,$2)', [a.companyId, domain.id]), 'active');
    assert.equal(await e.resolve('kariera.firma-a.pl'), a.companyId, 'switched back on');
    await e.as(users.owner);
    const events = (await e.one('select public.tenant_domain_state($1)', [a.companyId])).events.filter(ev => ev.domain_id === domain.id).map(ev => ev.action);
    for (const action of ['claimed', 'verified', 'tls_ready', 'activated', 'deactivated']) assert.ok(events.includes(action), action);
  });

  await t.test('scheduled re-verification: only due custom domains, renew or lapse, never verify, actor recorded as automatic', async () => {
    await h.asAdmin();
    const domainOf = async host => (await rows('select * from tenant_domains.domains where hostname=$1 and status <> $2', [host, 'revoked']))[0];
    const a1 = await domainOf('kariera.firma-a.pl');
    const b1 = await domainOf('jobs.firma-b.pl');
    // A: due (25 of 30 days), B: fresh (not due).
    await db.query("update tenant_domains.domains set last_verified_at = clock_timestamp() - interval '25 days' where id=$1", [a1.id]);
    // API roles cannot list or record.
    for (const role of ['anon', 'authenticated']) {
      await h.asUser(users.owner, role);
      await assert.rejects(db.query('select * from tenant_domains.reverify_due(10)'), forbidden, role);
      await assert.rejects(db.query('select tenant_domains.record_scheduled_dns_check($1,$2,$3,true)', [a.companyId, a1.id, a1.verification_token]), forbidden, role);
    }
    await e.verifier();
    const due = await rows('select * from tenant_domains.reverify_due(10)');
    assert.deepEqual(due.map(d => d.hostname), ['kariera.firma-a.pl'], 'only the due custom domain; the pending stolen claim and fresh B are not listed');
    assert.deepEqual(Object.keys(due[0]).sort(), ['company_id', 'domain_id', 'hostname', 'verification_token']);
    assert.equal((await rows('select * from tenant_domains.reverify_due(0)')).length, 0);
    // Wrong token or wrong company: refused.
    await assert.rejects(db.query('select tenant_domains.record_scheduled_dns_check($1,$2,$3,true)', [a.companyId, a1.id, 'f'.repeat(64)]), code('PT409'));
    await assert.rejects(db.query('select tenant_domains.record_scheduled_dns_check($1,$2,$3,true)', [b.companyId, a1.id, a1.verification_token]), code('P0002'));
    // A pending claim is never verified by the scheduler.
    await h.asAdmin();
    const pending = (await rows("select * from tenant_domains.domains where status='pending' limit 1"))[0];
    assert.ok(pending, 'the conflicting claim stays pending');
    await e.verifier();
    assert.equal(await e.one('select tenant_domains.record_scheduled_dns_check($1,$2,$3,true)', [pending.company_id, pending.id, pending.verification_token]), 'skipped');

    // Through the real store (role switch over a loopback connection) and a fake DNS resolver.
    await h.asAdmin();
    const url = e.databaseUrl(e.name);
    const store = reverifyStoreFromEnv({ TENANT_DOMAIN_VERIFIER_DATABASE_URL: url });
    const record = token => [[`skillcheck-domain-verification=${token}`]];
    const on = { VERCEL_ENV: 'preview', TENANT_DOMAIN_REVERIFY_ENABLED: 'true' };
    // Fail closed when not configured.
    assert.deepEqual(await reverifyDueDomains({ store, dns: { resolveTxt: async () => record(a1.verification_token) }, env: { VERCEL_ENV: 'preview' } }), { status: 'unconfigured' });
    assert.deepEqual(await reverifyDueDomains({ store, dns: { resolveTxt: async () => [] }, env: { ...on, VERCEL_ENV: 'production' } }), { status: 'unconfigured' });
    assert.deepEqual(await reverifyDueDomains({ store: reverifyStoreFromEnv({}), dns: { resolveTxt: async () => [] }, env: on }), { status: 'unconfigured' });
    // Resolver outage: nothing written.
    const outage = await reverifyDueDomains({ store, dns: { resolveTxt: async () => { throw Object.assign(new Error('x'), { code: 'ETIMEOUT' }); } }, env: on });
    assert.equal(outage.unavailable, 1);
    assert.equal(outage.renewed + outage.failed + outage.lapsed, 0);
    // Record present: renewed, no longer due, event by "automatic" (actor null).
    const renewed = await reverifyDueDomains({ store, dns: { resolveTxt: async () => record(a1.verification_token) }, env: on });
    assert.equal(renewed.renewed, 1);
    await h.asAdmin();
    const after = await domainOf('kariera.firma-a.pl');
    assert.ok(new Date(after.last_verified_at) > new Date(Date.now() - 60_000));
    assert.equal(after.status, 'active');
    const last = (await rows('select action, actor from tenant_domains.events where domain_id=$1 order by id desc limit 1', [a1.id]))[0];
    assert.deepEqual(last, { action: 'reverified', actor: null });
    await e.verifier();
    assert.equal((await rows('select * from tenant_domains.reverify_due(10)')).length, 0);
    // Record gone after the deadline: the domain lapses to pending and stops resolving; B is untouched.
    await h.asAdmin();
    await db.query("update tenant_domains.domains set last_verified_at = clock_timestamp() - interval '31 days' where id=$1", [a1.id]);
    assert.equal(await e.resolve('kariera.firma-a.pl'), null, 'a stale domain never resolves, even before the job runs');
    await h.asAdmin();
    const lapsed = await reverifyDueDomains({ store, dns: { resolveTxt: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); } }, env: on });
    assert.equal(lapsed.lapsed, 1);
    await h.asAdmin();
    assert.equal((await domainOf('kariera.firma-a.pl')).status, 'pending');
    assert.equal(await e.resolve('jobs.firma-b.pl'), b.companyId);
    await e.as(users.owner);
    const history = (await e.one('select public.tenant_domain_state($1)', [a.companyId])).events.filter(ev => ev.domain_id === a1.id);
    assert.deepEqual(history.slice(0, 2).map(ev => [ev.action, ev.by_owner]), [['verification_lapsed', false], ['verification_failed', false]]);
  });

  await t.test('revoked domain: never resolves again; a new claim needs a new token and a new verification', async () => {
    await e.as(users.otherOwner);
    const state = await e.one('select public.tenant_domain_state($1)', [b.companyId]);
    const domain = state.domains.find(d => d.hostname === 'jobs.firma-b.pl' && d.status === 'active');
    assert.equal(await e.one('select public.tenant_domain_revoke($1,$2)', [b.companyId, domain.id]), 'revoked');
    assert.equal(await e.resolve('jobs.firma-b.pl'), null);
    await e.as(users.otherOwner);
    await assert.rejects(db.query('select public.tenant_domain_activate($1,$2)', [b.companyId, domain.id]), error => error.code !== undefined);
    const again = (await rows('select * from public.tenant_domain_claim($1,$2,$3)', [b.companyId, 'jobs.firma-b.pl', 'custom']))[0];
    assert.notEqual(again.verification_token, domain.verification_token);
    assert.equal(await e.resolve('jobs.firma-b.pl'), null, 'still nothing until verified, TLS-ready and activated');
    await e.verifier();
    await assert.rejects(db.query('select tenant_domains.record_dns_check($1,$2,$3,true,$4)',
      [b.companyId, domain.id, domain.verification_token, users.otherOwner]), code('PT409'), 'the old token is dead');
  });
});
