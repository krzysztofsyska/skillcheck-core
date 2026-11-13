// SC-020-D — wspólny fixture white-label: natywny PostgreSQL, pełny łańcuch
// migracji, minimalna emulacja Supabase Storage (tabele buckets/objects z RLS,
// jak w tests/brand-database.test.mjs), dwie syntetyczne firmy A i B,
// rekruter i obserwator w A, użytkownik bez firmy. Tylko dane testowe.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { bootMigrationDatabase } from './sc19-migration-fixture.mjs';
import { setupRankingDatabase, users } from './screening-ranking-fixture.mjs';

export { users };
// Full current chain: R16 since SC-AC-SESSION (#276). SC-020 itself stays outside the inventory.
export const signature = 'e958cb168fc311a1e908b374cfc1bfee6524945b56f00e9639899ad72f75aea8';
export const code = (...codes) => error => codes.includes(error.code);
export const brandConfig = (brandName, overrides = {}) => ({
  brandName,
  colors: { primary: '#1f3a5f', onPrimary: '#ffffff', background: '#ffffff', text: '#1b2433', accent: '#8a4b08' },
  recruiterPanel: { headerStyle: 'primary' },
  candidatePanel: { headline: 'Zadanie rekrutacyjne', intro: '' },
  ...overrides,
});
export const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c6360000200000500017a5eab3f0000000049454e44ae426082', 'hex');

export async function bootWhiteLabel(t) {
  const env = await bootMigrationDatabase(t);
  const { db } = env;
  await db.exec(`
    do $$ begin
      if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
      if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
    end $$;
    create schema storage;
    create table storage.buckets(id text primary key, name text not null, public boolean not null default false,
      file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id),
      name text not null, owner_id text default nullif(current_setting('request.jwt.claim.sub', true), ''),
      metadata jsonb, unique(bucket_id, name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to anon, authenticated;
    grant select, insert, update, delete on storage.objects to authenticated;
  `);
  const h = await setupRankingDatabase(db, { throughMigration: null });
  await h.asAdmin();
  for (const schema of ['branding', 'tenant_domains']) {
    assert.equal((await db.query('select count(*)::int n from pg_namespace where nspname=$1', [schema])).rows[0].n, 1, `${schema} installed`);
  }
  const a = await h.seed(users.owner, 'A');
  const b = await h.seed(users.otherOwner, 'B');
  await h.asAdmin();
  await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter'),($1,$3,'viewer')",
    [a.companyId, users.recruiter, users.viewer]);
  await db.query("update public.companies set name='Firma A' where id=$1", [a.companyId]);
  await db.query("update public.companies set name='Firma B' where id=$1", [b.companyId]);

  const as = user => h.asUser(user);
  const one = async (sql, args = []) => Object.values((await db.query(sql, args)).rows[0] ?? {})[0];
  const ownerOf = { [a.companyId]: users.owner, [b.companyId]: users.otherOwner };
  const verifier = async () => { await db.exec('reset role'); await db.exec('set role tenant_domain_verifier'); };

  /** Owner uploads a PNG into Storage and registers it; returns { assetId, path, bytes }. */
  const registerLogo = async company => {
    await as(ownerOf[company]);
    const path = `${company}/logo/${randomUUID()}.png`;
    await db.query("insert into storage.objects(bucket_id,name,metadata) values('brand-assets',$1,jsonb_build_object('size',$2::int,'mimetype','application/octet-stream'))",
      [path, PNG.length]);
    const sha = createHash('sha256').update(PNG).digest('hex');
    const assetId = await one('select public.brand_register_asset($1,$2,$3,$4,$5,$6)', [company, 'logo', path, 'image/png', PNG.length, sha]);
    return { assetId, path, bytes: PNG };
  };
  /** Owner saves a draft and publishes it; returns the published version id. */
  const publishBrand = async (company, name, logo = null) => {
    await as(ownerOf[company]);
    await one('select public.brand_save_draft($1,$2,$3,$4)', [company, JSON.stringify(brandConfig(name)), logo, null]);
    const state = await one('select public.brand_editor_state($1)', [company]);
    return one('select public.brand_publish_draft($1,$2,$3)', [company, state.draft.id, state.draft.updated_at]);
  };
  const published = async (company, user = ownerOf[company]) => {
    await as(user);
    return (await db.query('select * from public.brand_published($1)', [company])).rows[0] ?? null;
  };
  /** Custom domain through claim -> DNS -> TLS -> activate. */
  const activeDomain = async (company, host) => {
    const owner = ownerOf[company];
    await as(owner);
    const claim = (await db.query('select * from public.tenant_domain_claim($1,$2,$3)', [company, host, 'custom'])).rows[0];
    await verifier();
    assert.equal(await one('select tenant_domains.record_dns_check($1,$2,$3,true,$4)', [company, claim.domain_id, claim.verification_token, owner]), 'verified');
    await one('select tenant_domains.record_tls_check($1,$2,$3,true,$4)', [company, claim.domain_id, claim.verification_token, owner]);
    await as(owner);
    assert.equal(await one('select public.tenant_domain_activate($1,$2)', [company, claim.domain_id]), 'active');
    return claim;
  };
  const resolve = async host => {
    await h.asUser(null, 'anon');
    return one('select public.tenant_domain_resolve($1)', [host]);
  };
  return { ...env, db, h, a, b, as, one, ownerOf, verifier, registerLogo, publishBrand, published, activeDomain, resolve };
}
