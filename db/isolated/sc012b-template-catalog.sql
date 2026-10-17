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
revoke all on private.voice_plan_template_catalog from public,anon,authenticated;
create trigger voice_plan_template_catalog_immutable
  before update or delete on private.voice_plan_template_catalog
  for each row execute function private.voice_plan_protect_history();
-- Only trusted DB administration may seed a new, independently reviewed version.
