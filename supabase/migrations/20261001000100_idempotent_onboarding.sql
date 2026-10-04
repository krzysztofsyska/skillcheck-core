begin;

-- Serialize onboarding for the same user so double submissions create one firm.
-- Explicit create_company remains available for future multi-company flows.
create function public.ensure_initial_company(company_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  current_user_id uuid := (select auth.uid());
  existing_company_id uuid;
begin
  if current_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(current_user_id::text, 0));
  select c.id into existing_company_id
    from public.companies c
    where c.owner_id = current_user_id or exists (
      select 1 from public.company_members m
      where m.company_id = c.id and m.user_id = current_user_id
    )
    order by c.created_at, c.id limit 1;
  if existing_company_id is not null then
    return existing_company_id;
  end if;
  return public.create_company(company_name);
end;
$$;

revoke all on function public.ensure_initial_company(text) from public, anon, authenticated;
grant execute on function public.ensure_initial_company(text) to authenticated;

commit;
