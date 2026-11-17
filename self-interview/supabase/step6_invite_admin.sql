-- ステップ6: 招待コード / 責任者(管理)機能
-- Supabase の SQL Editor に貼り付けて「Run」し、画面に「Success」と出ることを確認してください(1回だけ実行)。
-- ※ ステップ3・4のSQLを実行済みであることが前提です。

-------------------------------------------------------------------------------
-- 1) 責任者
-------------------------------------------------------------------------------
create table if not exists public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  note       text,
  created_at timestamptz not null default now()
);
-- ポリシーを作らない = アプリ(API)からは誰も読み書きできない。追加・削除は SQL Editor / Table Editor で行う。
alter table public.admins enable row level security;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = (select auth.uid()));
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-------------------------------------------------------------------------------
-- 2) 質問セット・招待コード
-------------------------------------------------------------------------------
create table if not exists public.packs (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  created_at  timestamptz not null default now()
);

create table if not exists public.pack_questions (
  id                uuid primary key default gen_random_uuid(),
  pack_id           uuid not null references public.packs (id) on delete cascade,
  title             text not null check (char_length(title) between 1 and 200),
  audio_path        text not null,                                                -- pack-audio バケット内のパス(例 setA/01.mp3)
  parent_pack_id    uuid references public.pack_questions (id) on delete cascade, -- 同じセット内の親質問
  parent_default_id text,                                                         -- 標準質問("q01"など)の深掘りにする場合
  sort_order        int not null default 0,
  created_at        timestamptz not null default now()
);

create table if not exists public.invite_codes (
  id         uuid primary key default gen_random_uuid(),
  code       text not null,
  pack_id    uuid not null references public.packs (id) on delete cascade,
  active     boolean not null default true,
  max_uses   int,                    -- null = 無制限(1アカウントにつき1回は常に守られる)
  expires_at timestamptz,            -- null = 期限なし
  note       text,
  created_at timestamptz not null default now()
);
create unique index if not exists invite_codes_code_uq on public.invite_codes (lower(code));

create table if not exists public.invite_redemptions (
  id             bigint generated always as identity primary key,
  code_id        uuid references public.invite_codes (id) on delete set null,
  user_id        uuid not null references auth.users (id) on delete cascade,
  code_text      text not null,
  pack_name      text not null,
  question_count int not null,
  created_at     timestamptz not null default now(),
  unique (code_id, user_id)          -- 同じコードは、同じアカウントで1回だけ
);

create table if not exists public.invite_attempts (   -- コードの当てずっぽう対策(失敗の記録)
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists invite_attempts_user_idx on public.invite_attempts (user_id, created_at);

alter table public.packs              enable row level security;
alter table public.pack_questions     enable row level security;
alter table public.invite_codes       enable row level security;
alter table public.invite_attempts    enable row level security;
alter table public.invite_redemptions enable row level security;

-- 使用済みコードの履歴だけ、本人が読める(コード本体や質問セットは、アプリからは読めない)
drop policy if exists "redemptions_select_own" on public.invite_redemptions;
create policy "redemptions_select_own" on public.invite_redemptions
  for select to authenticated using ((select auth.uid()) = user_id);

-------------------------------------------------------------------------------
-- 3) user_questions を、招待コード由来の質問に対応させる
-------------------------------------------------------------------------------
alter table public.user_questions
  add column if not exists audio_bucket text not null default 'question-audio'
    check (audio_bucket in ('question-audio', 'pack-audio'));
alter table public.user_questions add column if not exists source_code_id uuid;

-- 以前の「audio_path は自分のフォルダ」制約を外し、バケット別の制約に置き換える
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.user_questions'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%audio_path%'
  loop
    execute format('alter table public.user_questions drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.user_questions drop constraint if exists user_questions_audio_ck;
alter table public.user_questions add constraint user_questions_audio_ck check (
  (audio_bucket = 'question-audio' and audio_path like user_id::text || '/%')
  or audio_bucket = 'pack-audio'
);

-- 利用者が直接 insert できるのは「自分でアップロードした音声」の質問だけ(限定音声の横取りを防ぐ)。
-- 招待コード由来の質問は、下の redeem_invite_code 関数だけが追加できる。update はアプリで使わないので廃止。
drop policy if exists "uq_insert_own" on public.user_questions;
create policy "uq_insert_own" on public.user_questions
  for insert to authenticated
  with check ((select auth.uid()) = user_id and audio_bucket = 'question-audio');
drop policy if exists "uq_update_own" on public.user_questions;

-------------------------------------------------------------------------------
-- 4) 限定音声の保存先(運営者が Storage 画面からアップロードする)
-------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('pack-audio', 'pack-audio', false, 10485760, null)
on conflict (id) do nothing;

-- 招待コードを使って、その音声が自分の質問に入っている人だけが再生できる
drop policy if exists "pa_select_redeemed" on storage.objects;
create policy "pa_select_redeemed" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'pack-audio'
    and exists (
      select 1 from public.user_questions uq
      where uq.user_id = (select auth.uid())
        and uq.audio_bucket = 'pack-audio'
        and uq.audio_path = name
    )
  );

-------------------------------------------------------------------------------
-- 5) 招待コードの使用(質問セットを、そのアカウントに一括で取り込む)
-------------------------------------------------------------------------------
create or replace function public.redeem_invite_code(p_code text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid       uuid := auth.uid();
  v_code      public.invite_codes%rowtype;
  v_pack_name text;
  v_count     int;
  v_existing  int;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', 'not_authenticated');
  end if;

  -- 10分間に10回失敗したら、いったん止める
  if (select count(*) from public.invite_attempts
      where user_id = v_uid and created_at > now() - interval '10 minutes') >= 10 then
    return jsonb_build_object('ok', false, 'error', 'too_many_attempts');
  end if;

  -- コードの行をロックして、同時に使われても利用回数の上限が守られるようにする
  select * into v_code from public.invite_codes
   where lower(code) = lower(btrim(p_code)) for update;

  if not found or not v_code.active or (v_code.expires_at is not null and v_code.expires_at < now()) then
    insert into public.invite_attempts (user_id) values (v_uid);
    return jsonb_build_object('ok', false, 'error', 'invalid_code');
  end if;

  if exists (select 1 from public.invite_redemptions where code_id = v_code.id and user_id = v_uid) then
    return jsonb_build_object('ok', false, 'error', 'already_redeemed');
  end if;

  if v_code.max_uses is not null
     and (select count(*) from public.invite_redemptions where code_id = v_code.id) >= v_code.max_uses then
    return jsonb_build_object('ok', false, 'error', 'code_exhausted');
  end if;

  select name into v_pack_name from public.packs where id = v_code.pack_id;
  select count(*) into v_count from public.pack_questions where pack_id = v_code.pack_id;
  if v_count = 0 then
    return jsonb_build_object('ok', false, 'error', 'empty_pack');
  end if;

  select count(*) into v_existing from public.user_questions where user_id = v_uid;
  if v_existing + v_count > 100 then
    return jsonb_build_object('ok', false, 'error', 'limit',
      'max', 100, 'needed', v_count, 'remaining', greatest(100 - v_existing, 0));
  end if;

  -- 質問を新しいIDで取り込み、セット内の親子関係も新しいIDに付け替える
  with m as (
    select pq.id as old_id, gen_random_uuid() as new_id,
           pq.title, pq.audio_path, pq.parent_pack_id, pq.parent_default_id,
           pq.sort_order, pq.created_at as oc
    from public.pack_questions pq
    where pq.pack_id = v_code.pack_id
  )
  insert into public.user_questions (id, user_id, title, audio_bucket, audio_path, parent_id, source_code_id, created_at)
  select m.new_id, v_uid, m.title, 'pack-audio', m.audio_path,
         coalesce(pm.new_id::text, m.parent_default_id),
         v_code.id,
         now() + (row_number() over (order by m.sort_order, m.oc)) * interval '1 millisecond'
  from m left join m pm on pm.old_id = m.parent_pack_id;

  insert into public.invite_redemptions (code_id, user_id, code_text, pack_name, question_count)
  values (v_code.id, v_uid, v_code.code, v_pack_name, v_count);

  return jsonb_build_object('ok', true, 'pack_name', v_pack_name, 'count', v_count);
end $$;
revoke all on function public.redeem_invite_code(text) from public, anon;
grant execute on function public.redeem_invite_code(text) to authenticated;

-------------------------------------------------------------------------------
-- 6) 責任者向け: アカウント利用状況(パスワード等の認証情報は、一切返さない)
-------------------------------------------------------------------------------
drop function if exists public.admin_user_overview();
create function public.admin_user_overview()
returns table (
  uid uuid, account_email text, joined_at timestamptz, last_login_at timestamptz,
  terms_version text, terms_accepted_at text,
  answer_count bigint, avg_seconds numeric, last_answer_at timestamptz,
  own_questions bigint, imported_questions bigint, packs_used text
)
language sql stable security definer set search_path = public as $$
  select
    u.id, u.email::text, u.created_at, u.last_sign_in_at,
    u.raw_user_meta_data ->> 'terms_version',
    u.raw_user_meta_data ->> 'terms_accepted_at',
    coalesce(a.cnt, 0), a.avg_s, a.last_at,
    coalesce(q.own, 0), coalesce(q.imp, 0), r.packs
  from auth.users u
  left join (
    select user_id, count(*) as cnt, round(avg(seconds), 1) as avg_s, max(created_at) as last_at
    from public.answers group by user_id
  ) a on a.user_id = u.id
  left join (
    select user_id,
           count(*) filter (where audio_bucket = 'question-audio') as own,
           count(*) filter (where audio_bucket = 'pack-audio')     as imp
    from public.user_questions group by user_id
  ) q on q.user_id = u.id
  left join (
    select user_id, string_agg(pack_name, ', ' order by created_at) as packs
    from public.invite_redemptions group by user_id
  ) r on r.user_id = u.id
  where public.is_admin()          -- 責任者以外が呼んでも、0件しか返らない
  order by u.last_sign_in_at desc nulls last;
$$;
revoke all on function public.admin_user_overview() from public, anon;
grant execute on function public.admin_user_overview() to authenticated;
