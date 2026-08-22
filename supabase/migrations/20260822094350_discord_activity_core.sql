-- Persist only game-created state. Raw Discord IDs, names, avatars, email,
-- OAuth tokens, entitlements, and billing information are never stored.
create table public.discord_activity_world_state (
  world_id text primary key check (world_id ~ '^[0-9a-f]{64}$'),
  state jsonb not null default '{}'::jsonb,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now()
);

create table public.discord_activity_player_state (
  player_key text primary key check (player_key ~ '^[0-9a-f]{64}$'),
  state jsonb not null default '{}'::jsonb,
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now()
);

-- The keys are HMAC outputs generated only by the Vercel backend. They are
-- opaque and cannot be reversed into a Discord user or Activity instance ID.
grant select, insert, update, delete on public.discord_activity_world_state to service_role;
grant select, insert, update, delete on public.discord_activity_player_state to service_role;
revoke all on public.discord_activity_world_state from anon, authenticated;
revoke all on public.discord_activity_player_state from anon, authenticated;

alter table public.discord_activity_world_state enable row level security;
alter table public.discord_activity_player_state enable row level security;

-- Save revisions in one database statement. This prevents two simultaneous
-- clients from both passing a read-then-write revision check and losing data.
create or replace function public.save_discord_activity_world_state(
  p_world_id text,
  p_state jsonb,
  p_expected_revision bigint default null
)
returns table(revision bigint, updated_at timestamptz, conflict boolean)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_expected_revision is null then
    return query
      insert into public.discord_activity_world_state as world (world_id, state, revision, updated_at)
      values (p_world_id, p_state, 1, now())
      on conflict (world_id) do update
      set state = excluded.state,
          revision = world.revision + 1,
          updated_at = now()
      returning world.revision, world.updated_at, false;
    return;
  end if;

  if p_expected_revision = 0 then
    return query
      insert into public.discord_activity_world_state as world (world_id, state, revision, updated_at)
      values (p_world_id, p_state, 1, now())
      on conflict (world_id) do nothing
      returning world.revision, world.updated_at, false;
  else
    return query
      update public.discord_activity_world_state as world
      set state = p_state,
          revision = world.revision + 1,
          updated_at = now()
      where world.world_id = p_world_id
        and world.revision = p_expected_revision
      returning world.revision, world.updated_at, false;
  end if;

  if found then return; end if;
  return query
    select coalesce(world.revision, 0), world.updated_at, true
    from (select 1) as fallback
    left join public.discord_activity_world_state as world on world.world_id = p_world_id;
end;
$$;

create or replace function public.save_discord_activity_player_state(
  p_player_key text,
  p_state jsonb,
  p_expected_revision bigint default null
)
returns table(revision bigint, updated_at timestamptz, conflict boolean)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_expected_revision is null then
    return query
      insert into public.discord_activity_player_state as player (player_key, state, revision, updated_at)
      values (p_player_key, p_state, 1, now())
      on conflict (player_key) do update
      set state = excluded.state,
          revision = player.revision + 1,
          updated_at = now()
      returning player.revision, player.updated_at, false;
    return;
  end if;

  if p_expected_revision = 0 then
    return query
      insert into public.discord_activity_player_state as player (player_key, state, revision, updated_at)
      values (p_player_key, p_state, 1, now())
      on conflict (player_key) do nothing
      returning player.revision, player.updated_at, false;
  else
    return query
      update public.discord_activity_player_state as player
      set state = p_state,
          revision = player.revision + 1,
          updated_at = now()
      where player.player_key = p_player_key
        and player.revision = p_expected_revision
      returning player.revision, player.updated_at, false;
  end if;

  if found then return; end if;
  return query
    select coalesce(player.revision, 0), player.updated_at, true
    from (select 1) as fallback
    left join public.discord_activity_player_state as player on player.player_key = p_player_key;
end;
$$;

revoke all on function public.save_discord_activity_world_state(text, jsonb, bigint) from public, anon, authenticated;
revoke all on function public.save_discord_activity_player_state(text, jsonb, bigint) from public, anon, authenticated;
grant execute on function public.save_discord_activity_world_state(text, jsonb, bigint) to service_role;
grant execute on function public.save_discord_activity_player_state(text, jsonb, bigint) to service_role;

-- Vercel mints a short-lived JWT only after Discord's HTTP APIs confirm the
-- caller belongs to the exact Activity instance. The claim and topic contain
-- only an opaque HMAC, not Discord's raw Activity instance ID.
create policy "discord instance token can receive realtime"
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension in ('broadcast', 'presence')
  and (auth.jwt() ->> 'activity_topic') ~ '^activity:[0-9a-f]{64}$'
  and (select realtime.topic()) = (auth.jwt() ->> 'activity_topic')
);

create policy "discord instance token can send realtime"
on realtime.messages
for insert
to authenticated
with check (
  realtime.messages.extension in ('broadcast', 'presence')
  and (auth.jwt() ->> 'activity_topic') ~ '^activity:[0-9a-f]{64}$'
  and (select realtime.topic()) = (auth.jwt() ->> 'activity_topic')
);
