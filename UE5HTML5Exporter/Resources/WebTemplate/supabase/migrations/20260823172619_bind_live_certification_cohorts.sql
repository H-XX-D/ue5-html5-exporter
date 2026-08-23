-- Require both authenticated clients to poll during the same short, server-bound
-- certification cohort. This prevents a recent check-in from a previous operator
-- run from satisfying a new two-client proof.
create or replace function public.check_in_discord_activity_certification_v2(
  p_instance_key text,
  p_player_key text,
  p_challenge_key text,
  p_participant_count integer,
  p_proxy_authenticated boolean
)
returns table(
  status text,
  authenticated_clients bigint,
  participant_count integer,
  all_proxy_authenticated boolean,
  checked_at timestamptz,
  expires_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
begin
  delete from public.discord_activity_live_certification_checkins as stale
  where stale.checked_at < now() - interval '24 hours';

  insert into public.discord_activity_live_certification_checkins as checkin (
    instance_key,
    player_key,
    challenge_key,
    participant_count,
    proxy_authenticated,
    checked_at
  ) values (
    p_instance_key,
    p_player_key,
    p_challenge_key,
    p_participant_count,
    p_proxy_authenticated,
    now()
  )
  on conflict (instance_key, player_key) do update
  set challenge_key = excluded.challenge_key,
      participant_count = excluded.participant_count,
      proxy_authenticated = excluded.proxy_authenticated,
      checked_at = excluded.checked_at;

  return query
  with active as (
    select *
    from public.discord_activity_live_certification_checkins as checkin
    where checkin.instance_key = p_instance_key
      and checkin.challenge_key = p_challenge_key
      and checkin.checked_at >= now() - interval '10 seconds'
  ), aggregate as (
    select
      count(distinct active.player_key) as clients,
      coalesce(max(active.participant_count), 0) as participants,
      coalesce(bool_and(active.proxy_authenticated), false) as proxy_verified,
      max(active.checked_at) as latest
    from active
  )
  select
    case when aggregate.clients >= 2 and aggregate.participants >= 2 then 'passed' else 'waiting' end,
    aggregate.clients,
    aggregate.participants,
    aggregate.proxy_verified,
    aggregate.latest,
    aggregate.latest + interval '10 seconds'
  from aggregate;
end;
$$;

revoke all on function public.check_in_discord_activity_certification_v2(text, text, text, integer, boolean)
from public, anon, authenticated;
grant execute on function public.check_in_discord_activity_certification_v2(text, text, text, integer, boolean)
to service_role;
