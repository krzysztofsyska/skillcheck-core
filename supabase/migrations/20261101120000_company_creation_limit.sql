-- SC-COMPANY-LIMIT-001: at most N companies owned per auth.uid(), N = 1.
-- Abuse guard before FREE/package activation; existing companies are untouched.
--
-- The limit is a private constant function, not a settings table: a new table
-- in public/private would change private.erasure_schema_signature() and force
-- another SC-010 erasure inventory revision. Changing N is a one-line forward
-- migration replacing private.company_creation_limit().
--
-- Apply after M13 (20261021084732): M13 fingerprints installed routines and
-- would refuse a source schema with a changed public.create_company.
--
-- ensure_initial_company is unchanged: it returns an owned or member company
-- first and only then calls create_company under the same per-user lock.
begin;

create function private.company_creation_limit()
returns integer language sql immutable set search_path = '' as $$ select 1 $$;
revoke all on function private.company_creation_limit() from public, anon, authenticated;

create or replace function public.create_company(company_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  current_user_id uuid := (select auth.uid());
  new_company_id uuid;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  -- Same lock key as ensure_initial_company: concurrent calls cannot both pass the count.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(current_user_id::text, 0));
  if (select count(*) from public.companies c where c.owner_id = current_user_id)
      >= private.company_creation_limit() then
    raise exception 'Company limit reached' using errcode = 'PT409',
      detail = format('limit=%s', private.company_creation_limit());
  end if;
  insert into public.companies(name, owner_id)
    values (btrim(company_name), current_user_id) returning id into new_company_id;
  insert into public.company_profiles(company_id) values (new_company_id);
  return new_company_id;
end;
$$;

commit;
