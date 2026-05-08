create table if not exists public.events (
  key text primary key,
  title text not null,
  description text not null default '',
  info text not null default '',
  next_at timestamptz,
  repeat_hours integer not null default 0,
  remind_minutes_before integer not null default 60,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.reminder_subscriptions (
  user_id text not null,
  event_key text not null references public.events(key) on delete cascade,
  channel_id text not null,
  active boolean not null default true,
  last_notified_occurrence_ms bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, event_key)
);

create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_events_updated_at on public.events;
create trigger trg_events_updated_at
before update on public.events
for each row execute procedure public.set_updated_at();

drop trigger if exists trg_reminders_updated_at on public.reminder_subscriptions;
create trigger trg_reminders_updated_at
before update on public.reminder_subscriptions
for each row execute procedure public.set_updated_at();
