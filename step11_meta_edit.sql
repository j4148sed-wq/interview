-- ステップ11: 目標時間・タグの端末間の引き継ぎ / 自分の質問の編集
-- Supabase の SQL Editor に貼り付けて実行します(何度実行しても安全です)。
-- 先に schema.sql / step4 / step6 を実行しておいてください。

-------------------------------------------------------------------------------
-- 1) 質問ごとの目標時間・タグ(自分の分だけ読み書きできる)
-------------------------------------------------------------------------------
create table if not exists public.question_meta (
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  question_id    text not null check (char_length(question_id) between 1 and 64),
  target_seconds int check (target_seconds between 1 and 600),
  tags           text[] not null default '{}'
                 check (cardinality(tags) <= 5 and array_to_string(tags, '') !~ '[\n\r]'),
  updated_at     timestamptz not null default now(),
  primary key (user_id, question_id)
);
alter table public.question_meta enable row level security;

drop policy if exists "qm_select_own" on public.question_meta;
create policy "qm_select_own" on public.question_meta for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists "qm_insert_own" on public.question_meta;
create policy "qm_insert_own" on public.question_meta for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists "qm_update_own" on public.question_meta;
create policy "qm_update_own" on public.question_meta for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "qm_delete_own" on public.question_meta;
create policy "qm_delete_own" on public.question_meta for delete to authenticated
  using ((select auth.uid()) = user_id);

-- 1人あたり500件まで
create or replace function public.limit_question_meta() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.question_meta where user_id = new.user_id) >= 500 then
    raise exception 'meta limit reached';
  end if;
  return new;
end $$;
drop trigger if exists question_meta_limit on public.question_meta;
create trigger question_meta_limit before insert on public.question_meta
  for each row execute function public.limit_question_meta();

create or replace function public.touch_question_meta() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
drop trigger if exists question_meta_touch on public.question_meta;
create trigger question_meta_touch before update on public.question_meta
  for each row execute function public.touch_question_meta();

-- メンテナンス中は、責任者以外は書き込めない(step10 を実行済みの場合のみ)
do $$ begin
  if to_regprocedure('public.maintenance_on()') is not null then
    drop policy if exists "maint_ins" on public.question_meta;
    create policy "maint_ins" on public.question_meta as restrictive for insert to authenticated
      with check (not public.maintenance_on() or public.is_admin());
    drop policy if exists "maint_upd" on public.question_meta;
    create policy "maint_upd" on public.question_meta as restrictive for update to authenticated
      using (not public.maintenance_on() or public.is_admin())
      with check (not public.maintenance_on() or public.is_admin());
  end if;
end $$;

-------------------------------------------------------------------------------
-- 2) 自分の質問の編集(質問文・親の質問・音声の差し替え)
--    update を直接は許可せず、この関数だけが更新できる。
--    招待コード由来の質問(限定音声)は、編集できない。
-------------------------------------------------------------------------------
-- 引数を増やしたため、古い版(4引数)は消す
drop function if exists public.update_my_question(uuid, text, text, text);
create or replace function public.update_my_question(
  p_id uuid, p_title text, p_parent text, p_audio_path text default null, p_remove_audio boolean default false
) returns text   -- 差し替え・削除する前の音声ファイルのパス(Storageから消すために返す)。変更なしなら null
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_row public.user_questions;
  v_title text := btrim(coalesce(p_title, ''));
  v_parent text := nullif(btrim(coalesce(p_parent, '')), '');
begin
  if v_uid is null then raise exception 'forbidden'; end if;
  if to_regprocedure('public.maintenance_on()') is not null then
    if public.maintenance_on() and not public.is_admin() then raise exception 'maintenance'; end if;
  end if;
  select * into v_row from public.user_questions where id = p_id and user_id = v_uid;
  if not found then raise exception 'not_found'; end if;
  if v_row.audio_bucket is distinct from 'question-audio' then raise exception 'not_editable'; end if;
  if char_length(v_title) not between 1 and 200 then raise exception 'bad_title'; end if;
  if p_audio_path is not null and p_audio_path not like v_uid::text || '/%' then raise exception 'bad_audio'; end if;

  if v_parent is not null then
    if v_parent = p_id::text then raise exception 'bad_parent'; end if;
    -- 自分の深掘り質問を親にすると、輪になってしまうため禁止
    if exists (
      with recursive d as (
        select id::text as id from public.user_questions where user_id = v_uid and parent_id = p_id::text
        union
        select q.id::text from public.user_questions q join d on q.parent_id = d.id where q.user_id = v_uid
      ) select 1 from d where d.id = v_parent
    ) then raise exception 'bad_parent'; end if;
  end if;

  -- 音声なし(質問文を自動音声で読み上げる質問)にもできる
  update public.user_questions
     set title = v_title, parent_id = v_parent,
         audio_path = case when p_audio_path is not null then p_audio_path when coalesce(p_remove_audio, false) then null else audio_path end
   where id = p_id and user_id = v_uid;
  return case when p_audio_path is not null and p_audio_path is distinct from v_row.audio_path then v_row.audio_path
              when p_audio_path is null and coalesce(p_remove_audio, false) then v_row.audio_path end;
end $$;
revoke all on function public.update_my_question(uuid, text, text, text, boolean) from public, anon;
grant execute on function public.update_my_question(uuid, text, text, text, boolean) to authenticated;
