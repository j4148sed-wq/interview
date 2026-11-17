-- ステップ4: ユーザーが追加する質問(音声つき)
-- Supabase の SQL Editor に貼り付けて「Run」してください(ステップ3の schema.sql とは別に、1回だけ実行)。

-- 1) 質問テーブル
create table if not exists public.user_questions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title      text not null check (char_length(title) between 1 and 200),
  audio_path text not null,
  parent_id  text,                                  -- 標準質問の id("q01"など)か、自作質問の uuid。null ならトップ階層
  created_at timestamptz not null default now(),
  check (audio_path like user_id::text || '/%')     -- 自分のフォルダのファイルしか指定できない
);

create index if not exists user_questions_user_idx on public.user_questions (user_id, created_at);

alter table public.user_questions enable row level security;

create policy "uq_select_own" on public.user_questions
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "uq_insert_own" on public.user_questions
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "uq_update_own" on public.user_questions
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "uq_delete_own" on public.user_questions
  for delete to authenticated using ((select auth.uid()) = user_id);

-- 2) 1人あたり100件まで
create or replace function public.limit_user_questions() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.user_questions where user_id = new.user_id) >= 100 then
    raise exception 'question limit reached';
  end if;
  return new;
end $$;

drop trigger if exists user_questions_limit on public.user_questions;
create trigger user_questions_limit before insert on public.user_questions
  for each row execute function public.limit_user_questions();

-- 3) 音声ファイルの保存先(非公開バケット・1ファイル10MBまで・音声形式のみ)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'question-audio', 'question-audio', false, 10485760,
  array['audio/mpeg','audio/mp3','audio/mp4','audio/x-m4a','audio/aac','audio/wav','audio/x-wav','audio/ogg','audio/webm']
)
on conflict (id) do nothing;

-- 4) 自分のフォルダ(<user_id>/...)のファイルだけ読み書きできる
create policy "qa_select_own" on storage.objects
  for select to authenticated
  using (bucket_id = 'question-audio' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "qa_insert_own" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'question-audio' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "qa_delete_own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'question-audio' and (storage.foldername(name))[1] = (select auth.uid())::text);
