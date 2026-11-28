create table if not exists public.migrant_score_cache (
  player_id text primary key references public.gift_code_players(player_id) on delete cascade,
  score bigint not null,
  score_date date not null
);

alter table public.migrant_score_cache enable row level security;
grant select, insert, update, delete on table public.migrant_score_cache to service_role;
