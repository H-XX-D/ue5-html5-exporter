drop policy if exists "discord instance token can receive realtime" on realtime.messages;
drop policy if exists "discord instance token can send realtime" on realtime.messages;

create policy "discord instance token can receive realtime"
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension in ('broadcast', 'presence')
  and ((select auth.jwt()) ->> 'activity_topic') ~ '^activity:[0-9a-f]{64}$'
  and (select realtime.topic()) = ((select auth.jwt()) ->> 'activity_topic')
);

create policy "discord instance token can send realtime"
on realtime.messages
for insert
to authenticated
with check (
  realtime.messages.extension in ('broadcast', 'presence')
  and ((select auth.jwt()) ->> 'activity_topic') ~ '^activity:[0-9a-f]{64}$'
  and (select realtime.topic()) = ((select auth.jwt()) ->> 'activity_topic')
);
