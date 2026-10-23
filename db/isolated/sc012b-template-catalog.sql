-- SC-012-B immutable template catalog PROTOTYPE, disposable PostgreSQL ONLY.
-- Must be created after db/prototypes/sc012b-plan-schema.sql.
-- No migration, no client grant and no production activation.
create table private.voice_plan_template_catalog (
  version text primary key check (length(version) between 1 and 128),
  manifest_digest text not null check (manifest_digest ~ '^[a-f0-9]{64}$'),
  active boolean not null default false,
  created_at timestamptz not null default now()
);
alter table private.voice_plan_template_catalog enable row level security;
alter table private.voice_plan_template_catalog force row level security;
-- Close actual inherited ACLs, including roles unknown to this installer.
-- Preserve the owner and do not change defaults or any pre-existing object.
revoke all on private.voice_plan_template_catalog from public cascade;
do $$
declare recipient record;
begin
  for recipient in
    select distinct a.grantee from pg_catalog.pg_class c
      cross join lateral pg_catalog.aclexplode(coalesce(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      where c.oid='private.voice_plan_template_catalog'::pg_catalog.regclass
        and a.grantee<>0 and a.grantee<>c.relowner
  loop
    execute pg_catalog.format('revoke all on table private.voice_plan_template_catalog from %I cascade',
      pg_catalog.pg_get_userbyid(recipient.grantee));
  end loop;
end;
$$;
create trigger voice_plan_template_catalog_immutable
  before update or delete on private.voice_plan_template_catalog
  for each row execute function private.voice_plan_protect_history();
-- Only trusted DB administration may seed a new, independently reviewed version.
