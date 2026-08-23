revoke all on public.discord_activity_world_state from service_role;
revoke all on public.discord_activity_player_state from service_role;

grant select, insert, update on public.discord_activity_world_state to service_role;
grant select, insert, update on public.discord_activity_player_state to service_role;
