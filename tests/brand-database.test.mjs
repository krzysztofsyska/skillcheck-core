// SC-020-A — konfiguracja marki: izolacja firm, uprawnienia, walidacja,
// publikacja i przywracanie. Natywny PostgreSQL 16/17, pełny łańcuch migracji,
// dwie syntetyczne firmy. Storage Supabase jest emulowany minimalnie (tabele
// buckets/objects z RLS), aby sprawdzić polityki z migracji.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { bootMigrationDatabase } from './helpers/sc19-migration-fixture.mjs';
import { setupRankingDatabase, users } from './helpers/screening-ranking-fixture.mjs';

const migration = '20261109190000_sc020_brand_configuration.sql';
// Full current chain: R16 since SC-AC-SESSION (#276). SC-020 itself stays outside the inventory.
const signature = 'e958cb168fc311a1e908b374cfc1bfee6524945b56f00e9639899ad72f75aea8';
const code = (...codes) => error => codes.includes(error.code);
const config = (overrides = {}) => ({
  brandName: 'Acme Rekrutacja',
  colors: { primary: '#1f3a5f', onPrimary: '#ffffff', background: '#ffffff', text: '#1b2433', accent: '#8a4b08' },
  recruiterPanel: { headerStyle: 'primary' },
  candidatePanel: { headline: 'Zadanie rekrutacyjne', intro: '' },
  ...overrides,
});

async function boot(t) {
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
  assert.equal((await db.query("select count(*)::int n from pg_namespace where nspname='branding'")).rows[0].n, 1,
    `${migration} must be part of the checked-in chain`);
  const a = await h.seed(users.owner, 'A');
  const b = await h.seed(users.otherOwner, 'B');
  await h.asAdmin();
  await db.query("insert into public.company_members(company_id,user_id,role) values($1,$2,'recruiter'),($1,$3,'viewer')",
    [a.companyId, users.recruiter, users.viewer]);
  const rpc = async (name, args) => (await db.query(`select * from public.${name}(${args.map((_, i) => `$${i + 1}`).join(',')})`, args)).rows;
  const one = async (name, args) => Object.values((await rpc(name, args))[0])[0];
  const upload = async (companyId, kind = 'logo', ext = 'png', size = 120, path, mimetype = 'application/octet-stream', client = db) => {
    path ??= `${companyId}/${kind}/${randomUUID()}.${ext}`;
    await client.query("insert into storage.objects(bucket_id,name,metadata) values('brand-assets',$1,jsonb_build_object('size',$2::int,'mimetype',$3::text))", [path, size, mimetype]);
    return path;
  };
  const mime = { png: 'image/png', svg: 'image/svg+xml', ico: 'image/x-icon', webp: 'image/webp' };
  const register = async (companyId, kind = 'logo', ext = 'png', size = 120) => {
    const path = await upload(companyId, kind, ext, size);
    return one('brand_register_asset', [companyId, kind, path, mime[ext], size, createHash('sha256').update(path).digest('hex')]);
  };
  const draft = async (companyId, cfg = config(), logo = null, favicon = null) =>
    one('brand_save_draft', [companyId, JSON.stringify(cfg), logo, favicon]);
  const state = async companyId => one('brand_editor_state', [companyId]);
  const publish = async companyId => {
    const s = await state(companyId);
    return one('brand_publish_draft', [companyId, s.draft.id, s.draft.updated_at]);
  };
  return { ...env, db, h, a, b, rpc, one, upload, register, draft, state, publish };
}

test('SC-020-A brand configuration: isolation, permissions, validation, publish and rollback', async t => {
  const e = await boot(t);
  const { db, h, a, b } = e;

  await t.test('installs outside the SC-010 inventory: signature unchanged, schema hidden from API roles', async () => {
    await h.asAdmin();
    assert.equal((await db.query('select private.erasure_schema_signature() v')).rows[0].v, signature);
    const bucket = (await db.query("select public, file_size_limit, allowed_mime_types from storage.buckets where id='brand-assets'")).rows[0];
    assert.deepEqual(bucket, { public: false, file_size_limit: '524288', allowed_mime_types: ['application/octet-stream'] });
    for (const role of ['anon', 'authenticated']) {
      assert.equal((await db.query("select has_schema_privilege($1,'branding','USAGE') v", [role])).rows[0].v, false);
      for (const fn of ['brand_save_draft(uuid,jsonb,uuid,uuid)', 'brand_published(uuid)', 'brand_rollback(uuid,uuid)']) {
        assert.equal((await db.query('select has_function_privilege($1,$2,\'EXECUTE\') v', [role, `public.${fn}`])).rows[0].v, role === 'authenticated');
      }
    }
    await h.asUser(users.owner);
    await assert.rejects(db.query('select * from branding.versions'), code('42501'));
    await assert.rejects(db.query('select * from branding.assets'), code('42501'));
    await assert.rejects(db.query('select * from branding.events'), code('42501'));
  });

  let logoA, faviconA;
  await t.test('owner uploads and registers assets; storage folder and kind are bound to the company', async () => {
    await h.asUser(users.owner);
    logoA = await e.register(a.companyId, 'logo', 'svg');
    faviconA = await e.register(a.companyId, 'favicon', 'ico', 900);
    // Wrong company folder, wrong kind folder, mismatched size/mime, ICO as logo, oversized favicon.
    const path = await e.upload(a.companyId, 'logo', 'png', 100);
    for (const args of [
      [a.companyId, 'favicon', path, 'image/png', 100],
      [a.companyId, 'logo', path, 'image/svg+xml', 100],
      [a.companyId, 'logo', path, 'image/png', 101],
      [a.companyId, 'logo', path.replace(a.companyId, b.companyId), 'image/png', 100],
      [a.companyId, 'logo', `${a.companyId}/logo/../${randomUUID()}.png`, 'image/png', 100],
    ]) await assert.rejects(e.one('brand_register_asset', [...args, 'a'.repeat(64)]), code('22023'));
    const ico = await e.upload(a.companyId, 'logo', 'ico', 50);
    await assert.rejects(e.one('brand_register_asset', [a.companyId, 'logo', ico, 'image/x-icon', 50, 'a'.repeat(64)]), code('22023'));
    const big = await e.upload(a.companyId, 'favicon', 'png', 131073);
    await assert.rejects(e.one('brand_register_asset', [a.companyId, 'favicon', big, 'image/png', 131073, 'a'.repeat(64)]), code('22023'));
    // Storage must hold the object as the non-renderable type, never as an image/SVG.
    const typed = await e.upload(a.companyId, 'logo', 'svg', 80, undefined, 'image/svg+xml');
    await assert.rejects(e.one('brand_register_asset', [a.companyId, 'logo', typed, 'image/svg+xml', 80, 'a'.repeat(64)]), code('22023'));
    // An object that does not exist in storage cannot be registered.
    await assert.rejects(e.one('brand_register_asset', [a.companyId, 'logo', `${a.companyId}/logo/${randomUUID()}.png`, 'image/png', 100, 'a'.repeat(64)]), code('22023'));
    // The same object twice is refused.
    await e.one('brand_register_asset', [a.companyId, 'logo', path, 'image/png', 100, 'b'.repeat(64)]);
    await assert.rejects(e.one('brand_register_asset', [a.companyId, 'logo', path, 'image/png', 100, 'b'.repeat(64)]), code('22023'));
  });

  await t.test('storage policies: only the owner writes into their own folder; only members read it', async () => {
    await h.asUser(users.owner);
    await assert.rejects(e.upload(b.companyId), code('42501'), 'owner A cannot write into B');
    await assert.rejects(e.upload(a.companyId, 'logo', 'png', 1, `${a.companyId}/other/${randomUUID()}.png`), code('42501'));
    await assert.rejects(e.upload(a.companyId, 'logo', 'png', 1, `${a.companyId}/logo/x.png`), code('42501'));
    await assert.rejects(db.query("insert into storage.objects(bucket_id,name) values('other',$1)", [`${a.companyId}/logo/${randomUUID()}.png`]), code('42501', '23503'));
    for (const actor of [users.recruiter, users.viewer]) {
      await h.asUser(actor);
      await assert.rejects(e.upload(a.companyId), code('42501'), 'members other than the owner cannot upload');
      assert.ok((await db.query("select count(*)::int n from storage.objects where bucket_id='brand-assets'")).rows[0].n > 0, 'members read their company assets');
    }
    await h.asUser(users.owner);
    assert.equal((await db.query("update storage.objects set metadata='{}' where bucket_id='brand-assets'")).rowCount, 0, 'no overwrite');
    assert.equal((await db.query("delete from storage.objects where bucket_id='brand-assets'")).rowCount, 0, 'no delete');
    await h.asUser(users.otherOwner);
    assert.equal((await db.query("select count(*)::int n from storage.objects where name like $1", [`${a.companyId}/%`])).rows[0].n, 0, 'B cannot list A objects');
    await assert.rejects(e.register(a.companyId), code('42501'));
    await h.asUser(users.outsider);
    assert.equal((await db.query("select count(*)::int n from storage.objects")).rows[0].n, 0);
    await h.asUser(null, 'anon');
    await assert.rejects(db.query('select * from storage.objects'), code('42501'));
  });

  await t.test('draft validation: shape, hex colours, contrast, assets of the right kind and company', async () => {
    await h.asUser(users.owner);
    const bad = [
      { ...config(), extra: true },
      config({ brandName: '' }),
      config({ brandName: 'x'.repeat(81) }),
      config({ brandName: '<script>' }),
      config({ colors: { ...config().colors, primary: 'red' } }),
      config({ colors: { ...config().colors, primary: '#FFF' } }),
      config({ colors: { ...config().colors, text: '#eeeeee' } }),
      config({ colors: { ...config().colors, onPrimary: '#2a4a70' } }),
      config({ colors: { ...config().colors, accent: '#fefefe' } }),
      config({ recruiterPanel: { headerStyle: 'dark' } }),
      config({ candidatePanel: { headline: 'x', intro: 'y'.repeat(601) } }),
      config({ candidatePanel: { headline: 'x' } }),
      config({ brandName: '🚀'.repeat(81) }),
      config({ brandName: 'Acme\u0085' }),
      config({ colors: { ...config().colors, primary: '#888888', onPrimary: '#000000' } }),
    ];
    for (const cfg of bad) await assert.rejects(e.draft(a.companyId, cfg), code('22023'), JSON.stringify(cfg));
    // Same rule as lib/brand-config.ts: 80 code points is the limit, not 80 UTF-16 units.
    await e.draft(a.companyId, config({ brandName: '🚀'.repeat(80) }));
    await assert.rejects(e.draft(a.companyId, config(), faviconA), code('22023'), 'favicon used as logo');
    await h.asUser(users.otherOwner);
    const logoB = await e.register(b.companyId);
    await h.asUser(users.owner);
    await assert.rejects(e.draft(a.companyId, config(), logoB), code('22023'), 'asset of another company');
  });

  let v1, v2;
  await t.test('owner saves, previews and publishes; members read only the published version', async () => {
    await h.asUser(users.owner);
    const draftId = await e.draft(a.companyId, config(), logoA, faviconA);
    assert.equal(await e.draft(a.companyId, config({ brandName: 'Acme' }), logoA, faviconA), draftId, 'one draft per company');
    await h.asUser(users.recruiter);
    assert.deepEqual(await e.rpc('brand_published', [a.companyId]), [], 'draft is not visible before publish');
    await h.asUser(users.owner);
    const s = await e.state(a.companyId);
    await assert.rejects(e.one('brand_publish_draft', [a.companyId, s.draft.id, '2000-01-01T00:00:00Z']), code('PT409'), 'stale preview');
    v1 = await e.publish(a.companyId);
    assert.equal(v1, draftId);
    for (const actor of [users.owner, users.recruiter, users.viewer]) {
      await h.asUser(actor);
      const [published] = await e.rpc('brand_published', [a.companyId]);
      assert.equal(published.version_id, v1);
      assert.equal(published.version_no, 1);
      assert.equal(published.config.brandName, 'Acme');
      assert.equal(published.logo_asset_id, logoA);
      const [asset] = await e.rpc('brand_asset', [a.companyId, logoA]);
      assert.equal(asset.mime, 'image/svg+xml');
    }
    await h.asUser(users.owner);
    await e.draft(a.companyId, config({ brandName: 'Acme v2', recruiterPanel: { headerStyle: 'light' } }), null, null);
    v2 = await e.publish(a.companyId);
    const [current] = await e.rpc('brand_published', [a.companyId]);
    assert.equal(current.version_no, 2);
    assert.equal(current.logo_asset_id, null);
  });

  await t.test('non-owners cannot edit, publish, roll back, register or read the editor state', async () => {
    for (const actor of [users.recruiter, users.viewer, users.otherOwner, users.outsider]) {
      await h.asUser(actor);
      await assert.rejects(e.draft(a.companyId), code('42501'));
      await assert.rejects(e.one('brand_publish_draft', [a.companyId, v2, new Date().toISOString()]), code('42501'));
      await assert.rejects(e.one('brand_rollback', [a.companyId, v1]), code('42501'));
      await assert.rejects(e.state(a.companyId), code('42501'));
      await assert.rejects(e.one('brand_register_asset', [a.companyId, 'logo', `${a.companyId}/logo/${randomUUID()}.png`, 'image/png', 1, 'a'.repeat(64)]), code('42501'));
    }
    for (const actor of [users.otherOwner, users.outsider]) {
      await h.asUser(actor);
      await assert.rejects(e.rpc('brand_published', [a.companyId]), code('42501'), 'other tenants cannot read A');
      await assert.rejects(e.rpc('brand_asset', [a.companyId, logoA]), code('42501'));
    }
    await h.asUser(users.otherOwner);
    assert.deepEqual(await e.rpc('brand_asset', [b.companyId, logoA]), [], 'A asset is not reachable through B');
    await h.asUser(null, 'anon');
    await assert.rejects(e.rpc('brand_published', [a.companyId]), code('42501'));
    await h.asUser(null);
    await assert.rejects(e.rpc('brand_published', [a.companyId]), code('42501'));
  });

  await t.test('rollback to any earlier published version creates a new version with full history', async () => {
    await h.asUser(users.owner);
    await assert.rejects(e.one('brand_rollback', [a.companyId, v2]), code('22023'), 'current version is not a rollback target');
    await assert.rejects(e.one('brand_rollback', [b.companyId, v1]), code('42501'));
    await h.asUser(users.otherOwner);
    await e.draft(b.companyId, config({ brandName: 'Beta' }));
    const vb = await e.publish(b.companyId);
    await h.asUser(users.owner);
    await assert.rejects(e.one('brand_rollback', [a.companyId, vb]), code('22023'), 'B version cannot be restored into A');
    const v3 = await e.one('brand_rollback', [a.companyId, v1]);
    const [current] = await e.rpc('brand_published', [a.companyId]);
    assert.equal(current.version_id, v3);
    assert.equal(current.version_no, 3);
    assert.equal(current.config.brandName, 'Acme');
    assert.equal(current.logo_asset_id, logoA);
    const s = await e.state(a.companyId);
    assert.deepEqual(s.versions.map(v => [v.version_no, v.status, v.rolled_back_from]),
      [[3, 'published', v1], [2, 'superseded', null], [1, 'superseded', null]]);
    assert.ok(s.versions.every(v => v.published_by === users.owner && v.published_at));
    assert.deepEqual([...new Set(s.events.map(x => x.action))].sort(), ['asset_registered', 'draft_saved', 'published', 'rolled_back']);
    assert.ok(s.events.every(x => x.actor === users.owner));
    // Rolling back to v2 again works too (any earlier published version).
    await e.one('brand_rollback', [a.companyId, v2]);
    assert.equal((await e.rpc('brand_published', [a.companyId]))[0].config.brandName, 'Acme v2');
    // B is untouched by everything A did.
    await h.asUser(users.otherOwner);
    const sb = await e.state(b.companyId);
    assert.deepEqual(sb.versions.map(v => v.config.brandName), ['Beta']);
    assert.ok(sb.events.every(x => x.actor === users.otherOwner));
    assert.ok(!JSON.stringify(sb).includes(a.companyId));
  });

  await t.test('limits: 50 registered assets and 60 stored objects per company', async () => {
    const owner = randomUUID();
    await h.asAdmin();
    await db.query('insert into auth.users values($1)', [owner]);
    await h.asUser(owner);
    const c = (await db.query('select public.create_company($1) id', ['Tenant C'])).rows[0].id;
    for (let i = 0; i < 50; i++) await e.register(c, 'favicon', 'png', 10);
    await assert.rejects(e.register(c, 'favicon', 'png', 10), code('54000'));
    for (let i = 51; i < 60; i++) await e.upload(c, 'favicon', 'png', 10);
    await assert.rejects(e.upload(c, 'favicon', 'png', 10), code('42501'), 'storage quota per company');
    await h.asUser(users.otherOwner);
    assert.equal((await db.query('select private.brand_storage_quota_ok($1) v', [`${a.companyId}/logo/${randomUUID()}.png`])).rows[0].v, false,
      'the quota helper reveals nothing about another company');
    await h.asUser(users.owner);
    await e.upload(a.companyId, 'logo', 'png', 10);
  });

  await t.test('concurrent publish and rollback get distinct, contiguous version numbers', async () => {
    const asOwner = async () => {
      const client = await e.connect();
      await client.query("set role authenticated");
      await client.query("select set_config('request.jwt.claim.sub',$1,false)", [users.otherOwner]);
      return client;
    };
    const [one, two] = [await asOwner(), await asOwner()];
    await h.asUser(users.otherOwner);
    const before = (await e.state(b.companyId)).versions;
    const first = before.at(-1).id;
    await e.draft(b.companyId, config({ brandName: 'Beta 2' }));
    const s = await e.state(b.companyId);
    await e.one('brand_publish_draft', [b.companyId, s.draft.id, s.draft.updated_at]);
    await e.draft(b.companyId, config({ brandName: 'Beta 3' }));
    const s3 = await e.state(b.companyId);
    await one.query('begin');
    await one.query('select public.brand_publish_draft($1,$2,$3)', [b.companyId, s3.draft.id, s3.draft.updated_at]);
    const racing = two.query('select public.brand_rollback($1,$2)', [b.companyId, first]);
    await new Promise(resolve => setTimeout(resolve, 200));
    await one.query('commit');
    await racing;
    const after = (await e.state(b.companyId)).versions;
    const numbers = after.map(v => v.version_no).sort((x, y) => x - y);
    assert.deepEqual(numbers, Array.from({ length: numbers.length }, (_, i) => i + 1));
    assert.equal(after.filter(v => v.status === 'published').length, 1);
    assert.equal(after.find(v => v.status === 'published').rolled_back_from, first, 'the later transaction wins');
  });

  await t.test('history is immutable even for the table owner path', async () => {
    await h.asAdmin();
    await assert.rejects(db.query("update branding.versions set config='{}' where status='superseded'"), code('42501'));
    await assert.rejects(db.query("update branding.versions set config='{}' where status='published'"), code('42501'));
    await assert.rejects(db.query('delete from branding.versions'), code('42501'));
    await assert.rejects(db.query('update branding.assets set kind=kind'), code('42501'));
    await assert.rejects(db.query('delete from branding.events'), code('42501'));
    // Future company purge path: only the company named in the transaction-local setting.
    await db.query('begin');
    await db.query("select set_config('branding.purge_company',$1,true)", [b.companyId]);
    await assert.rejects(db.query('delete from branding.events where company_id=$1', [a.companyId]), code('42501'));
    await db.query('rollback');
    await db.query('begin');
    await db.query("select set_config('branding.purge_company',$1,true)", [b.companyId]);
    for (const table of ['events', 'versions', 'assets']) await db.query(`delete from branding.${table} where company_id=$1`, [b.companyId]);
    await db.query('rollback');
    assert.ok((await db.query('select count(*)::int n from branding.versions where company_id=$1', [b.companyId])).rows[0].n > 0);
    assert.equal((await db.query('select private.erasure_schema_signature() v')).rows[0].v, signature);
  });
});
