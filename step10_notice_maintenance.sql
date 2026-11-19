-- ステップ10: 運営からのお知らせ / メンテナンス中の利用制限
-- Supabase の SQL Editor に貼り付けて実行します(何度実行しても安全です)。
-- 先に schema.sql / step4 / step6 を実行しておいてください。

-------------------------------------------------------------------------------
-- 1) アプリの状態(メンテナンス中かどうか)。1行だけ
-------------------------------------------------------------------------------
create table if not exists public.app_status (
  id          int primary key default 1 check (id = 1),
  maintenance boolean not null default false,
  message     text not null default '' check (char_length(message) <= 1000),
  updated_at  timestamptz not null default now()
);
insert into public.app_status (id) values (1) on conflict (id) do nothing;
alter table public.app_status enable row level security;

-- ログイン前の画面でも「メンテナンス中」と出せるよう、誰でも読める(書き込みは、下の関数だけ)
drop policy if exists "app_status_read" on public.app_status;
create policy "app_status_read" on public.app_status for select to anon, authenticated using (true);

create or replace function public.admin_set_maintenance(p_on boolean, p_message text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  update public.app_status
     set maintenance = coalesce(p_on, false), message = left(coalesce(p_message, ''), 1000), updated_at = now()
   where id = 1;
end $$;
revoke all on function public.admin_set_maintenance(boolean, text) from public, anon;
grant execute on function public.admin_set_maintenance(boolean, text) to authenticated;

-------------------------------------------------------------------------------
-- 2) お知らせ
-------------------------------------------------------------------------------
create table if not exists public.announcements (
  id         uuid primary key default gen_random_uuid(),
  title      text not null check (char_length(title) between 1 and 100),
  body       text not null default '' check (char_length(body) <= 2000),
  level      text not null default 'info' check (level in ('info', 'warn')),
  published  boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.announcements enable row level security;

-- ログインしている人は、公開中のお知らせを読める。責任者は、非公開のものも読める
drop policy if exists "ann_read" on public.announcements;
create policy "ann_read" on public.announcements for select to authenticated
  using (published or public.is_admin());

create or replace function public.admin_save_announcement(p_title text, p_body text, p_level text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  insert into public.announcements (title, body, level)
  values (left(btrim(coalesce(p_title, '')), 100), left(coalesce(p_body, ''), 2000), case when p_level = 'warn' then 'warn' else 'info' end)
  returning id into v;
  return v;
end $$;

create or replace function public.admin_set_announcement_published(p_id uuid, p_published boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  update public.announcements set published = coalesce(p_published, false) where id = p_id;
end $$;

create or replace function public.admin_delete_announcement(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  delete from public.announcements where id = p_id;
end $$;

revoke all on function public.admin_save_announcement(text, text, text) from public, anon;
revoke all on function public.admin_set_announcement_published(uuid, boolean) from public, anon;
revoke all on function public.admin_delete_announcement(uuid) from public, anon;
grant execute on function public.admin_save_announcement(text, text, text) to authenticated;
grant execute on function public.admin_set_announcement_published(uuid, boolean) to authenticated;
grant execute on function public.admin_delete_announcement(uuid) to authenticated;

-------------------------------------------------------------------------------
-- 3) メンテナンス中は、データベースへの「追加・更新」も止める(責任者は除く)
--    画面を開いたままの人や、アプリを改造した人でも、書き込めないようにするための鍵
-------------------------------------------------------------------------------
create or replace function public.maintenance_on() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select maintenance from public.app_status where id = 1), false);
$$;
revoke all on function public.maintenance_on() from public, anon;
grant execute on function public.maintenance_on() to authenticated;

drop policy if exists "maint_ins" on public.answers;
create policy "maint_ins" on public.answers as restrictive for insert to authenticated
  with check (not public.maintenance_on() or public.is_admin());
drop policy if exists "maint_ins" on public.user_questions;
create policy "maint_ins" on public.user_questions as restrictive for insert to authenticated
  with check (not public.maintenance_on() or public.is_admin());
drop policy if exists "maint_ins" on public.question_scripts;
create policy "maint_ins" on public.question_scripts as restrictive for insert to authenticated
  with check (not public.maintenance_on() or public.is_admin());
drop policy if exists "maint_upd" on public.question_scripts;
create policy "maint_upd" on public.question_scripts as restrictive for update to authenticated
  using (not public.maintenance_on() or public.is_admin())
  with check (not public.maintenance_on() or public.is_admin());
