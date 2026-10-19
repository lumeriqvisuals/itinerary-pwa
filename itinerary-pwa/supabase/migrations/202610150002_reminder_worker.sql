-- Atomic claim primitive for scheduled worker. Apply after initial schema.
create or replace function public.claim_due_reminders(p_limit integer default 50)
returns setof public.reminders
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_limit < 1 or p_limit > 500 then raise exception 'p_limit must be between 1 and 500'; end if;
  return query
  with due as (
    select r.id
    from public.reminders r
    where r.status in ('pending','failed')
      and r.scheduled_at <= now()
      and r.attempts < 5
      and (r.claimed_at is null or r.claimed_at < now() - interval '5 minutes')
    order by r.scheduled_at
    for update skip locked
    limit p_limit
  )
  update public.reminders r
  set status = 'processing', claim_token = gen_random_uuid(), claimed_at = now(), attempts = r.attempts + 1
  from due
  where r.id = due.id
  returning r.*;
end;
$$;
revoke all on function public.claim_due_reminders(integer) from public, anon, authenticated;
grant execute on function public.claim_due_reminders(integer) to service_role;

-- Do not allow users to change ownership or processing internals through client-side updates.
drop policy if exists "reminders_update_own" on public.reminders;
create policy "reminders_update_own" on public.reminders for update to authenticated
using (user_id = auth.uid())
with check (
  user_id = auth.uid()
  and status in ('pending','cancelled')
);

-- Clients can read their notification history, but cannot create forged delivery rows.
