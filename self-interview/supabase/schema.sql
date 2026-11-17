-- Supabase の SQL Editor に貼り付けて「Run」してください。

-- 回答時間の記録
create table if not exists public.answers (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  question_id text not null,                       -- 標準質問は "q01" など、自作質問は後のステップで uuid
  title       text not null,                       -- 記録時点の質問文(後で質問を編集しても履歴が崩れない)
  seconds     numeric(7,1) not null check (seconds >= 0),
  mode        text,                                -- random / sequential / pick
  created_at  timestamptz not null default now()
);

create index if not exists answers_user_created_idx on public.answers (user_id, created_at desc);

-- 行レベルセキュリティ: 自分の記録だけ読み書きできる
alter table public.answers enable row level security;

create policy "answers_select_own" on public.answers
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "answers_insert_own" on public.answers
  for insert to authenticated with check ((select auth.uid()) = user_id);

create policy "answers_delete_own" on public.answers
  for delete to authenticated using ((select auth.uid()) = user_id);
