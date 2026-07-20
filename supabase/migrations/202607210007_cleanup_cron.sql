create extension if not exists pg_cron with schema extensions;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'guess-word-cleanup-expired-rooms') then
    perform cron.schedule(
      'guess-word-cleanup-expired-rooms',
      '* * * * *',
      $job$select public.cleanup_expired_rooms();$job$
    );
  end if;
exception when undefined_table then
  raise notice 'pg_cron is unavailable; cleanup will run on room API activity';
end $$;
