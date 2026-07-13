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

create table if not exists public.gift_code_players (
  player_id text primary key,
  nickname text not null default '',
  kid integer,
  stove_lv integer,
  active boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.gift_codes (
  code text primary key,
  source text not null default '',
  expires_at timestamptz,
  active boolean not null default true,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.gift_code_redemptions (
  player_id text not null references public.gift_code_players(player_id) on delete cascade,
  code text not null references public.gift_codes(code) on delete cascade,
  status text not null,
  message text not null default '',
  err_code text,
  last_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (player_id, code)
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

drop trigger if exists trg_gift_code_players_updated_at on public.gift_code_players;
create trigger trg_gift_code_players_updated_at
before update on public.gift_code_players
for each row execute procedure public.set_updated_at();

drop trigger if exists trg_gift_codes_updated_at on public.gift_codes;
create trigger trg_gift_codes_updated_at
before update on public.gift_codes
for each row execute procedure public.set_updated_at();

drop trigger if exists trg_gift_code_redemptions_updated_at on public.gift_code_redemptions;
create trigger trg_gift_code_redemptions_updated_at
before update on public.gift_code_redemptions
for each row execute procedure public.set_updated_at();

grant usage on schema public to service_role;

grant select, insert, update, delete on table public.events to service_role;
grant select, insert, update, delete on table public.reminder_subscriptions to service_role;
grant select, insert, update, delete on table public.gift_code_players to service_role;
grant select, insert, update, delete on table public.gift_codes to service_role;
grant select, insert, update, delete on table public.gift_code_redemptions to service_role;
