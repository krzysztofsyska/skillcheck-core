-- Reverts 20261101120000_company_creation_limit.sql (SC-COMPANY-LIMIT-001).
-- Restores the reviewed create_company body from 20260930000100_skillcheck_core.sql
-- (no per-user limit, no advisory lock) and drops the limit constant.
-- CREATE OR REPLACE keeps the owner and ACL of public.create_company. No data changes.
begin;

create or replace function public.create_company(company_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_company_id uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  insert into public.companies(name, owner_id)
    values (btrim(company_name), (select auth.uid())) returning id into new_company_id;
  insert into public.company_profiles(company_id) values (new_company_id);
  return new_company_id;
end;
$$;

drop function private.company_creation_limit();

commit;
