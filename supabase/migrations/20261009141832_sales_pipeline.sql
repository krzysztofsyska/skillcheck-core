begin;
-- Original public submission stays immutable; commercial metadata is operator-only.
create table private.sales_pipeline (
 lead_id uuid primary key references public.sales_leads(id) on delete cascade,
 stage text not null default 'new' check(stage in ('new','conversation','offer','won','lost')),
 note text not null default '' check(length(note)<=2000),
 next_contact_on date,
 company_id uuid references public.companies(id) on delete set null,
 version integer not null default 0 check(version>=0),
 updated_at timestamptz not null default clock_timestamp(),
 check(stage not in ('won','lost') or next_contact_on is null)
);
create table private.sales_pipeline_events (
 id bigint generated always as identity primary key,
 lead_id uuid not null references public.sales_leads(id) on delete cascade,
 actor_id uuid references auth.users(id) on delete set null,
 stage text not null, note text not null, next_contact_on date,
 company_id uuid references public.companies(id) on delete set null,
 version integer not null, created_at timestamptz not null default clock_timestamp(),
 unique(lead_id,version)
);
alter table private.sales_pipeline enable row level security;
alter table private.sales_pipeline_events enable row level security;
revoke all on private.sales_pipeline,private.sales_pipeline_events from public,anon,authenticated;
revoke all on sequence private.sales_pipeline_events_id_seq from public,anon,authenticated;
create index sales_pipeline_due_idx on private.sales_pipeline(next_contact_on,lead_id) where stage not in ('won','lost');
create index sales_pipeline_stage_idx on private.sales_pipeline(stage,lead_id);
insert into private.sales_pipeline(lead_id,stage,updated_at)
 select l.id,case when c.lead_id is null then 'new' else 'lost' end,coalesce(c.closed_at,l.created_at)
 from public.sales_leads l left join private.sales_lead_closures c on c.lead_id=l.id;

create function private.initialize_sales_pipeline() returns trigger
language plpgsql security definer set search_path='' as $$
begin insert into private.sales_pipeline(lead_id) values(new.id); return new; end $$;
revoke all on function private.initialize_sales_pipeline() from public,anon,authenticated;
create trigger initialize_sales_pipeline after insert on public.sales_leads
 for each row execute function private.initialize_sales_pipeline();

-- Legacy inbox closure and the new pipeline must share the same lifecycle.
create function private.close_sales_pipeline() returns trigger
language plpgsql security definer set search_path='' as $$
declare p private.sales_pipeline;
begin
 select * into p from private.sales_pipeline where lead_id=new.lead_id for update;
 if p.stage='won' then raise exception 'sales_pipeline_won'; end if;
 if p.stage<>'lost' then
  update private.sales_pipeline set stage='lost',next_contact_on=null,version=version+1,updated_at=clock_timestamp()
    where lead_id=new.lead_id returning * into p;
  insert into private.sales_pipeline_events(lead_id,actor_id,stage,note,next_contact_on,company_id,version)
    values(p.lead_id,new.closed_by,p.stage,p.note,p.next_contact_on,p.company_id,p.version);
 end if;
 return new;
end $$;
revoke all on function private.close_sales_pipeline() from public,anon,authenticated;
create trigger close_sales_pipeline before insert on private.sales_lead_closures
 for each row execute function private.close_sales_pipeline();

create function public.save_sales_pipeline(target_lead uuid,expected_version integer,new_stage text,
 new_note text,next_contact date,linked_company uuid) returns text
language plpgsql security definer set search_path='' as $$
declare p private.sales_pipeline;
begin
 perform pg_advisory_xact_lock(6105,1);
 if not private.is_platform_operator((select auth.uid())) then return 'sales_lead_forbidden'; end if;
 if new_stage is null or new_stage not in ('new','conversation','offer','won','lost')
  or new_note is null or length(new_note)>2000 or expected_version is null or expected_version<0
  or (next_contact is not null and (not isfinite(next_contact) or next_contact<'2000-01-01'::date or next_contact>'2100-12-31'::date))
  or (new_stage in ('won','lost') and next_contact is not null) then return 'invalid'; end if;
 -- Same row lock order as close_sales_lead / purge: lead, then metadata.
 perform 1 from public.sales_leads where id=target_lead for update;
 if not found then return 'not_found'; end if;
 select * into p from private.sales_pipeline where lead_id=target_lead for update;
 if not found then return 'not_found'; end if;
 if p.version<>expected_version then return 'conflict'; end if;
 if p.stage in ('won','lost') then return 'closed'; end if;
 if linked_company is not null then
  perform 1 from public.companies where id=linked_company for key share;
  if not found then return 'company_not_found'; end if;
 end if;
 if new_stage='won' and linked_company is null then return 'company_required'; end if;
 if (p.stage,p.note,p.next_contact_on,p.company_id) is not distinct from (new_stage,btrim(new_note),next_contact,linked_company) then return 'ok'; end if;
 update private.sales_pipeline set stage=new_stage,note=btrim(new_note),next_contact_on=next_contact,
  company_id=linked_company,version=version+1,updated_at=clock_timestamp() where lead_id=target_lead returning * into p;
 insert into private.sales_pipeline_events(lead_id,actor_id,stage,note,next_contact_on,company_id,version)
  values(p.lead_id,(select auth.uid()),p.stage,p.note,p.next_contact_on,p.company_id,p.version);
 if new_stage='lost' then
  insert into private.sales_lead_closures(lead_id,closed_by) values(target_lead,(select auth.uid())) on conflict do nothing;
 end if;
 return 'ok';
end $$;
revoke all on function public.save_sales_pipeline(uuid,integer,text,text,date,uuid) from public,anon,authenticated;
grant execute on function public.save_sales_pipeline(uuid,integer,text,text,date,uuid) to authenticated;

create function public.list_sales_pipeline(stage_filter text default 'all',due_filter text default 'all',
 page_offset integer default 0,target_lead uuid default null)
returns table(id uuid,first_name text,company_name text,email text,phone text,needs text,created_at timestamptz,
 stage text,note text,next_contact_on date,company_id uuid,linked_company_name text,version integer,closed_at timestamptz,total_count bigint)
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock_shared(6105,1);
 if not private.is_platform_operator((select auth.uid())) then raise exception 'sales_lead_forbidden'; end if;
 if stage_filter is null or stage_filter not in ('all','new','conversation','offer','won','lost')
  or due_filter is null or due_filter not in ('all','today','overdue') or page_offset is null or page_offset<0 then raise exception 'invalid'; end if;
 return query select l.id,l.first_name,l.company_name,l.email,l.phone,l.needs,l.created_at,
  p.stage,p.note,p.next_contact_on,p.company_id,c.name,p.version,cl.closed_at,count(*) over()
 from private.sales_pipeline p join public.sales_leads l on l.id=p.lead_id
 left join public.companies c on c.id=p.company_id
 left join private.sales_lead_closures cl on cl.lead_id=p.lead_id
 where (target_lead is null or l.id=target_lead) and (stage_filter='all' or p.stage=stage_filter)
 and (due_filter='all' or (p.stage not in ('won','lost') and
  ((due_filter='today' and p.next_contact_on=(now() at time zone 'Europe/Warsaw')::date)
   or (due_filter='overdue' and p.next_contact_on<(now() at time zone 'Europe/Warsaw')::date))))
 order by l.created_at desc,l.id desc limit 20 offset page_offset;
end $$;
revoke all on function public.list_sales_pipeline(text,text,integer,uuid) from public,anon,authenticated;
grant execute on function public.list_sales_pipeline(text,text,integer,uuid) to authenticated;

create function public.sales_pipeline_history(target_lead uuid,before_version integer default 2147483647)
returns table(version integer,stage text,note text,next_contact_on date,company_id uuid,created_at timestamptz)
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock_shared(6105,1);
 if not private.is_platform_operator((select auth.uid())) then raise exception 'sales_lead_forbidden'; end if;
 return query select e.version,e.stage,e.note,e.next_contact_on,e.company_id,e.created_at
 from private.sales_pipeline_events e where e.lead_id=target_lead and e.version<before_version
 order by e.version desc limit 20;
end $$;
revoke all on function public.sales_pipeline_history(uuid,integer) from public,anon,authenticated;
grant execute on function public.sales_pipeline_history(uuid,integer) to authenticated;

create function public.find_sales_companies(search_text text)
returns table(id uuid,name text)
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock_shared(6105,1);
 if not private.is_platform_operator((select auth.uid())) then raise exception 'sales_lead_forbidden'; end if;
 if search_text is null or length(btrim(search_text))<2 or length(search_text)>100 then return; end if;
 return query select c.id,c.name from public.companies c
 where strpos(lower(c.name),lower(btrim(search_text)))>0 order by c.name,c.id limit 20;
end $$;
revoke all on function public.find_sales_companies(text) from public,anon,authenticated;
grant execute on function public.find_sales_companies(text) to authenticated;
commit;
