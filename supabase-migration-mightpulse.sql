-- Run this once in Supabase Dashboard > SQL Editor before deploying this feature.
alter table public.gift_code_players add column if not exists power bigint;
alter table public.gift_code_players add column if not exists alliance_tag text not null default '';
alter table public.gift_code_players add column if not exists alliance_name text not null default '';

create table if not exists public.alliance_weekly_power_snapshots (
  week_start date not null,
  player_id text not null,
  nickname text not null default '',
  power bigint,
  created_at timestamptz not null default now(),
  primary key (week_start, player_id)
);

create table if not exists public.alliance_weekly_power_reports (
  week_start date primary key,
  sent_at timestamptz not null default now()
);

create table if not exists public.mightpulse_daily_syncs (
  sync_date date primary key,
  completed_at timestamptz not null default now()
);

alter table public.alliance_weekly_power_snapshots enable row level security;
alter table public.alliance_weekly_power_reports enable row level security;
alter table public.mightpulse_daily_syncs enable row level security;

grant select, insert, update, delete on table public.alliance_weekly_power_snapshots to service_role;
grant select, insert, update, delete on table public.alliance_weekly_power_reports to service_role;
grant select, insert, update, delete on table public.mightpulse_daily_syncs to service_role;
