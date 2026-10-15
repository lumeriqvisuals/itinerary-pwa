-- Daymark itinerary schema. Review in staging before production.
create extension if not exists pgcrypto;

create type public.activity_status as enum ('planned', 'completed', 'cancelled');
create type public.reminder_status as enum ('pending', 'processing', 'submitted', 'failed', 'cancelled');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  timezone text not null default 'UTC',
  notification_preferences jsonb not null default '{"push": true, "in_app": true}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.activities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(trim(title)) between 1 and 140),
  description text,
  location text,
  timezone text not null default 'UTC',
  start_at timestamptz not null,
  end_at timestamptz,
  recurrence_rule text,
  recurrence_until timestamptz,
  recurrence_count integer check (recurrence_count is null or recurrence_count > 0),
  series_id uuid,
  occurrence_key text,
  is_override boolean not null default false,
  status public.activity_status not null default 'planned',
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_at is null or end_at >= start_at),
  unique (user_id, series_id, occurrence_key)
);
create index activities_user_start_idx on public.activities(user_id, start_at);
create index activities_series_idx on public.activities(series_id) where series_id is not null;

create table public.activity_occurrences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  activity_id uuid not null references public.activities(id) on delete cascade,
  occurrence_key text not null,
  start_at timestamptz not null,
  end_at timestamptz,
  timezone text not null default 'UTC',
  status public.activity_status not null default 'planned',
  title_override text,
  description_override text,
  location_override text,
  is_cancelled boolean not null default false,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (activity_id, occurrence_key),
  check (end_at is null or end_at >= start_at)
);
create index occurrences_user_start_idx on public.activity_occurrences(user_id, start_at);

create table public.reminder_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  activity_id uuid not null references public.activities(id) on delete cascade,
  offset_minutes integer not null default 15 check (offset_minutes between -525600 and 525600),
  channels text[] not null default array['in_app','push']::text[],
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (channels <@ array['in_app','push']::text[])
);
create index reminder_rules_activity_idx on public.reminder_rules(activity_id) where enabled;

create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  activity_id uuid not null references public.activities(id) on delete cascade,
  occurrence_id uuid references public.activity_occurrences(id) on delete cascade,
  reminder_rule_id uuid references public.reminder_rules(id) on delete set null,
  offset_minutes integer not null default 15,
  scheduled_at timestamptz not null,
  status public.reminder_status not null default 'pending',
  snoozed_until timestamptz,
  sent_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  claim_token uuid,
  claimed_at timestamptz,
  idempotency_key text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index reminders_due_idx on public.reminders(scheduled_at) where status in ('pending','failed');
create index reminders_user_schedule_idx on public.reminders(user_id, scheduled_at);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  expiration_time timestamptz,
  user_agent text,
  last_success_at timestamptz,
  last_failure_at timestamptz,
  failure_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index push_subscriptions_user_idx on public.push_subscriptions(user_id);

create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  reminder_id uuid not null references public.reminders(id) on delete cascade,
  channel text not null check (channel in ('push','in_app')),
  attempt_number integer not null default 1,
  status text not null check (status in ('queued','submitted','failed','expired')),
  provider_response text,
  error_message text,
  attempted_at timestamptz not null default now(),
  unique (reminder_id, channel, attempt_number)
);
create index notification_deliveries_user_idx on public.notification_deliveries(user_id, attempted_at desc);

create table public.in_app_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  reminder_id uuid references public.reminders(id) on delete set null,
  title text not null,
  body text not null,
  target_url text not null default '/',
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index in_app_notifications_user_unread_idx on public.in_app_notifications(user_id, created_at desc) where read_at is null;

-- Enforce user consistency for child rows beyond RLS.
create or replace function public.ensure_reminder_activity_owner()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if not exists (select 1 from public.activities a where a.id = new.activity_id and a.user_id = new.user_id) then
    raise exception 'Activity owner mismatch';
  end if;
  if new.occurrence_id is not null and not exists (
    select 1 from public.activity_occurrences o
    where o.id = new.occurrence_id and o.user_id = new.user_id and o.activity_id = new.activity_id
  ) then
    raise exception 'Occurrence owner mismatch';
  end if;
  return new;
end;
$$;
create trigger reminders_owner_guard before insert or update on public.reminders
for each row execute function public.ensure_reminder_activity_owner();

create or replace function public.ensure_rule_activity_owner()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  if not exists (select 1 from public.activities a where a.id = new.activity_id and a.user_id = new.user_id) then
    raise exception 'Activity owner mismatch';
  end if;
  return new;
end;
$$;
create trigger reminder_rules_owner_guard before insert or update on public.reminder_rules
for each row execute function public.ensure_rule_activity_owner();

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare tbl text;
begin
  foreach tbl in array array['profiles','activities','activity_occurrences','reminder_rules','reminders','push_subscriptions'] loop
    execute format('create trigger %I_set_updated_at before update on public.%I for each row execute function public.set_updated_at()', tbl, tbl);
  end loop;
end $$;

-- Create a profile on signup. Auth provider metadata is treated as display-only.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name, avatar_url)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'), new.raw_user_meta_data->>'avatar_url')
  on conflict (id) do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

-- Snoozing is atomic and only permitted for the authenticated owner.
create or replace function public.snooze_reminder(p_reminder_id uuid, p_minutes integer default 10)
returns public.reminders language plpgsql security invoker
set search_path = public
as $$
declare updated public.reminders;
begin
  if p_minutes < 1 or p_minutes > 1440 then raise exception 'Snooze must be between 1 and 1440 minutes'; end if;
  update public.reminders
  set scheduled_at = now() + make_interval(mins => p_minutes),
      snoozed_until = now() + make_interval(mins => p_minutes),
      status = 'pending',
      claim_token = null,
      claimed_at = null,
      updated_at = now()
  where id = p_reminder_id and user_id = auth.uid() and status <> 'cancelled'
  returning * into updated;
  if updated.id is null then raise exception 'Reminder not found or not available'; end if;
  return updated;
end;
$$;

-- RLS on every table exposed to the client.
alter table public.profiles enable row level security;
alter table public.activities enable row level security;
alter table public.activity_occurrences enable row level security;
alter table public.reminder_rules enable row level security;
alter table public.reminders enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.in_app_notifications enable row level security;

create policy "profiles_select_own" on public.profiles for select to authenticated using (id = auth.uid());
create policy "profiles_insert_own" on public.profiles for insert to authenticated with check (id = auth.uid());
create policy "profiles_update_own" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "activities_select_own" on public.activities for select to authenticated using (user_id = auth.uid());
create policy "activities_insert_own" on public.activities for insert to authenticated with check (user_id = auth.uid());
create policy "activities_update_own" on public.activities for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "activities_delete_own" on public.activities for delete to authenticated using (user_id = auth.uid());

create policy "occurrences_select_own" on public.activity_occurrences for select to authenticated using (user_id = auth.uid());
create policy "occurrences_insert_own" on public.activity_occurrences for insert to authenticated with check (user_id = auth.uid() and exists(select 1 from public.activities a where a.id = activity_id and a.user_id = auth.uid()));
create policy "occurrences_update_own" on public.activity_occurrences for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid() and exists(select 1 from public.activities a where a.id = activity_id and a.user_id = auth.uid()));
create policy "occurrences_delete_own" on public.activity_occurrences for delete to authenticated using (user_id = auth.uid());

create policy "reminder_rules_select_own" on public.reminder_rules for select to authenticated using (user_id = auth.uid());
create policy "reminder_rules_insert_own" on public.reminder_rules for insert to authenticated with check (user_id = auth.uid() and exists(select 1 from public.activities a where a.id = activity_id and a.user_id = auth.uid()));
create policy "reminder_rules_update_own" on public.reminder_rules for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid() and exists(select 1 from public.activities a where a.id = activity_id and a.user_id = auth.uid()));
create policy "reminder_rules_delete_own" on public.reminder_rules for delete to authenticated using (user_id = auth.uid());

create policy "reminders_select_own" on public.reminders for select to authenticated using (user_id = auth.uid());
create policy "reminders_insert_own" on public.reminders for insert to authenticated with check (user_id = auth.uid() and exists(select 1 from public.activities a where a.id = activity_id and a.user_id = auth.uid()));
create policy "reminders_update_own" on public.reminders for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid() and exists(select 1 from public.activities a where a.id = activity_id and a.user_id = auth.uid()));
create policy "reminders_delete_own" on public.reminders for delete to authenticated using (user_id = auth.uid());

create policy "push_subscriptions_select_own" on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
create policy "push_subscriptions_insert_own" on public.push_subscriptions for insert to authenticated with check (user_id = auth.uid());
create policy "push_subscriptions_update_own" on public.push_subscriptions for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "push_subscriptions_delete_own" on public.push_subscriptions for delete to authenticated using (user_id = auth.uid());

create policy "deliveries_select_own" on public.notification_deliveries for select to authenticated using (user_id = auth.uid());
create policy "in_app_notifications_select_own" on public.in_app_notifications for select to authenticated using (user_id = auth.uid());
create policy "in_app_notifications_update_own" on public.in_app_notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "in_app_notifications_delete_own" on public.in_app_notifications for delete to authenticated using (user_id = auth.uid());

-- No direct client insert/update/delete policies for delivery logs; Edge Functions use service role.
revoke all on function public.snooze_reminder(uuid, integer) from public;
grant execute on function public.snooze_reminder(uuid, integer) to authenticated;
