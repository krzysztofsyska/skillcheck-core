begin;

-- Keep the original submission immutable. Lifecycle metadata is separate and private.
create table private.sales_lead_closures (
  lead_id uuid primary key references public.sales_leads(id) on delete cascade,
  closed_at timestamptz not null default clock_timestamp(),
  closed_by uuid references auth.users(id) on delete set null
);
alter table private.sales_lead_closures enable row level security;
revoke all on private.sales_lead_closures from public, anon, authenticated;
create index sales_lead_closures_closed_at_idx on private.sales_lead_closures(closed_at);

create function public.close_sales_lead(target_lead uuid) returns text
language plpgsql security definer set search_path='' as $$
begin
  -- Same authorization lock as operator grant/revoke: revocation cannot race a close.
  perform pg_advisory_xact_lock(6105,1);
  if not private.is_platform_operator((select auth.uid())) then return 'sales_lead_forbidden'; end if;
  perform 1 from public.sales_leads where id=target_lead for update;
  if not found then return 'sales_lead_not_found'; end if;
  insert into private.sales_lead_closures(lead_id,closed_by)
    values(target_lead,(select auth.uid())) on conflict(lead_id) do nothing;
  return 'ok';
end $$;
revoke all on function public.close_sales_lead(uuid) from public,anon,authenticated;
grant execute on function public.close_sales_lead(uuid) to authenticated;

create function public.list_sales_leads_inbox(result_limit integer default 50)
returns table(id uuid,first_name text,company_name text,email text,phone text,needs text,
  status text,submitted_by uuid,created_at timestamptz,closed_at timestamptz)
language plpgsql security definer set search_path='' as $$
begin
  if not private.is_platform_operator((select auth.uid())) then raise exception 'sales_lead_forbidden'; end if;
  return query select l.id,l.first_name,l.company_name,l.email,l.phone,l.needs,
    l.status,l.submitted_by,l.created_at,c.closed_at
    from public.sales_leads l left join private.sales_lead_closures c on c.lead_id=l.id
    order by l.created_at desc,l.id desc limit greatest(1,least(100,coalesce(result_limit,50)));
end $$;
revoke all on function public.list_sales_leads_inbox(integer) from public,anon,authenticated;
grant execute on function public.list_sales_leads_inbox(integer) to authenticated;

create function private.purge_closed_sales_leads() returns integer
language plpgsql security definer set search_path='' as $$
declare expired uuid[];
begin
  select array_agg(lead_id) into expired from private.sales_lead_closures
    where closed_at <= clock_timestamp()-interval '6 months';
  if expired is null then return 0; end if;
  perform private.purge_sales_leads(expired);
  return cardinality(expired);
end $$;
revoke all on function private.purge_closed_sales_leads() from public,anon,authenticated;

commit;
