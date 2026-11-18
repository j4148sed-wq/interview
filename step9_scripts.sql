-- ステップ9: 暗記する回答の「原稿」を、アカウントに保存する(本人だけが読み書きできる)
-- Supabase の SQL Editor に貼り付けて「Run」し、「Success」と出ることを確認してください(1回だけ実行)。

create table if not exists public.question_scripts (
  user_id     uuid not null references auth.users (id) on delete cascade default auth.uid(),
  question_id text not null check (char_length(question_id) between 1 and 64),   -- 標準の質問("q01"など)か、自分の質問のid
  script      text not null check (char_length(script) between 1 and 3000),
  updated_at  timestamptz not null default now(),
  primary key (user_id, question_id)
);

-- 本人だけが、自分の原稿を読み書きできる(責任者用の画面や関数からは、読めない)
alter table public.question_scripts enable row level security;
grant select, insert, update, delete on public.question_scripts to authenticated;

drop policy if exists "qs_select_own" on public.question_scripts;
create policy "qs_select_own" on public.question_scripts for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists "qs_insert_own" on public.question_scripts;
create policy "qs_insert_own" on public.question_scripts for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists "qs_update_own" on public.question_scripts;
create policy "qs_update_own" on public.question_scripts for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "qs_delete_own" on public.question_scripts;
create policy "qs_delete_own" on public.question_scripts for delete to authenticated
  using ((select auth.uid()) = user_id);

-- 1人あたり200件まで(無制限に保存されないように)
create or replace function public.limit_question_scripts() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.question_scripts where user_id = new.user_id) >= 200 then
    raise exception 'script limit reached';
  end if;
  return new;
end $$;
drop trigger if exists question_scripts_limit on public.question_scripts;
create trigger question_scripts_limit before insert on public.question_scripts
  for each row execute function public.limit_question_scripts();

-- 更新日時を自動で更新
create or replace function public.touch_question_scripts() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists question_scripts_touch on public.question_scripts;
create trigger question_scripts_touch before update on public.question_scripts
  for each row execute function public.touch_question_scripts();
