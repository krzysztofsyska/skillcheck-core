begin;
do $$ begin if exists(select 1 from exercise_ai.recruitment_settings where generation_requests<>'{}'::jsonb) then
 raise exception 'Generation reservations require forward fix; never refund uncertain calls' using errcode='55000';end if;end $$;
drop function public.finish_exercise_ai_generation(uuid,uuid,uuid,text,jsonb,jsonb,text);
drop function public.reserve_exercise_ai_generation(uuid,uuid,uuid,timestamptz,timestamptz,text);
alter table exercise_ai.recruitment_settings drop column generation_requests;
commit;
