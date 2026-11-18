-- ステップ7: 氏名(漢字+カタカナ)が一致した人に、招待コードをアプリ内で通知する
-- Supabase の SQL Editor に貼り付けて「Run」し、「Success」と出ることを確認してください(1回だけ実行)。
-- ※ ステップ3・4・6のSQLを実行済みであることが前提です。

-------------------------------------------------------------------------------
-- 1) 氏名の正規化(全角/半角・空白の違いを吸収して比較する)
-------------------------------------------------------------------------------
create or replace function public.norm_name(t text) returns text
language sql immutable as $$
  select regexp_replace(normalize(coalesce(t, ''), NFKC), '\s', '', 'g');
$$;

-------------------------------------------------------------------------------
-- 2) 招待コードの送り先(責任者が登録する)
-------------------------------------------------------------------------------
create table if not exists public.invite_targets (
  id             uuid primary key default gen_random_uuid(),
  family_kanji   text not null check (char_length(family_kanji) between 1 and 40),
  given_kanji    text not null check (char_length(given_kanji)  between 1 and 40),
  family_kana    text not null check (char_length(family_kana)  between 1 and 40),
  given_kana     text not null check (char_length(given_kana)   between 1 and 40),
  code_id        uuid not null references public.invite_codes (id) on delete cascade,
  note           text,
  matched_user_id uuid references auth.users (id) on delete set null,  -- 氏名が一致したアカウント
  matched_at     timestamptz,
  seen_at        timestamptz,                                          -- 本人がアプリ内の通知を確認した日時
  created_at     timestamptz not null default now()
);
create index if not exists invite_targets_match_idx on public.invite_targets (matched_user_id);
-- ポリシーを作らない = アプリ(API)から直接は誰も読み書きできない。下の関数だけが操作する。
alter table public.invite_targets enable row level security;

-------------------------------------------------------------------------------
-- 3) 本人向け: 氏名が一致した送り先の「ひもづけ」と、届いた招待コードの一覧
-------------------------------------------------------------------------------
create or replace function public.claim_name_invites() returns int
language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_meta jsonb;
  n      int;
begin
  if v_uid is null then return 0; end if;
  select raw_user_meta_data into v_meta from auth.users where id = v_uid;
  if coalesce(v_meta ->> 'family_kanji', '') = '' or coalesce(v_meta ->> 'given_kanji', '') = ''
     or coalesce(v_meta ->> 'family_kana', '') = '' or coalesce(v_meta ->> 'given_kana', '') = '' then
    return 0;   -- 氏名が未登録のアカウントは対象外
  end if;

  update public.invite_targets t
     set matched_user_id = v_uid, matched_at = now()
   where t.matched_user_id is null
     and public.norm_name(t.family_kanji) = public.norm_name(v_meta ->> 'family_kanji')
     and public.norm_name(t.given_kanji)  = public.norm_name(v_meta ->> 'given_kanji')
     and public.norm_name(t.family_kana)  = public.norm_name(v_meta ->> 'family_kana')
     and public.norm_name(t.given_kana)   = public.norm_name(v_meta ->> 'given_kana');
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.claim_name_invites() from public, anon;
grant execute on function public.claim_name_invites() to authenticated;

-- 届いている(まだ使っていない)招待コード。有効なコードだけ返す
create or replace function public.my_invite_notices()
returns table (target_id uuid, code text, pack_name text, matched_at timestamptz, seen_at timestamptz)
language sql stable security definer set search_path = public as $$
  select t.id, c.code, p.name, t.matched_at, t.seen_at
  from public.invite_targets t
  join public.invite_codes c on c.id = t.code_id
  join public.packs p on p.id = c.pack_id
  where t.matched_user_id = (select auth.uid())
    and c.active and (c.expires_at is null or c.expires_at > now())
    and not exists (select 1 from public.invite_redemptions r
                    where r.code_id = c.id and r.user_id = (select auth.uid()))
  order by t.matched_at desc;
$$;
revoke all on function public.my_invite_notices() from public, anon;
grant execute on function public.my_invite_notices() to authenticated;

create or replace function public.mark_invite_notices_seen() returns void
language sql security definer set search_path = public as $$
  update public.invite_targets set seen_at = now()
  where matched_user_id = (select auth.uid()) and seen_at is null;
$$;
revoke all on function public.mark_invite_notices_seen() from public, anon;
grant execute on function public.mark_invite_notices_seen() to authenticated;

-------------------------------------------------------------------------------
-- 4) 責任者向け(責任者以外が呼ぶとエラー)
-------------------------------------------------------------------------------
create or replace function public.admin_list_codes()
returns table (id uuid, code text, pack_name text, active boolean, max_uses int, used bigint, expires_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return query
    select c.id, c.code, p.name, c.active, c.max_uses,
           (select count(*) from public.invite_redemptions r where r.code_id = c.id),
           c.expires_at
    from public.invite_codes c join public.packs p on p.id = c.pack_id
    order by c.created_at desc;
end $$;
revoke all on function public.admin_list_codes() from public, anon;
grant execute on function public.admin_list_codes() to authenticated;

create or replace function public.admin_list_targets()
returns table (id uuid, family_kanji text, given_kanji text, family_kana text, given_kana text,
               code_id uuid, code text, pack_name text, matched_email text,
               matched_at timestamptz, seen_at timestamptz, redeemed boolean, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return query
    select t.id, t.family_kanji, t.given_kanji, t.family_kana, t.given_kana,
           t.code_id, c.code, p.name, u.email::text, t.matched_at, t.seen_at,
           exists (select 1 from public.invite_redemptions r where r.code_id = t.code_id and r.user_id = t.matched_user_id),
           t.created_at
    from public.invite_targets t
    join public.invite_codes c on c.id = t.code_id
    join public.packs p on p.id = c.pack_id
    left join auth.users u on u.id = t.matched_user_id
    order by t.created_at desc, t.family_kana, t.given_kana;
end $$;
revoke all on function public.admin_list_targets() from public, anon;
grant execute on function public.admin_list_targets() to authenticated;

-- 送り先の追加。p_rows は [{"family_kanji":"..","given_kanji":"..","family_kana":"..","given_kana":"..","code_id":".."}, ...]
-- 同じ氏名・同じコードの組み合わせが既にあれば、スキップする。追加した件数を返す
create or replace function public.admin_add_targets(p_rows jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare
  r jsonb; n int := 0; v_code uuid;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'bad_request';
  end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_code := (r ->> 'code_id')::uuid;
    if not exists (select 1 from public.invite_targets t
                   where t.code_id = v_code
                     and public.norm_name(t.family_kanji) = public.norm_name(r ->> 'family_kanji')
                     and public.norm_name(t.given_kanji)  = public.norm_name(r ->> 'given_kanji')
                     and public.norm_name(t.family_kana)  = public.norm_name(r ->> 'family_kana')
                     and public.norm_name(t.given_kana)   = public.norm_name(r ->> 'given_kana')) then
      insert into public.invite_targets (family_kanji, given_kanji, family_kana, given_kana, code_id)
      values (btrim(r ->> 'family_kanji'), btrim(r ->> 'given_kanji'),
              btrim(r ->> 'family_kana'),  btrim(r ->> 'given_kana'), v_code);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;
revoke all on function public.admin_add_targets(jsonb) from public, anon;
grant execute on function public.admin_add_targets(jsonb) to authenticated;

create or replace function public.admin_delete_target(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  delete from public.invite_targets where id = p_id;
end $$;
revoke all on function public.admin_delete_target(uuid) from public, anon;
grant execute on function public.admin_delete_target(uuid) to authenticated;

-------------------------------------------------------------------------------
-- 5) アカウント利用状況に、氏名を加える(責任者だけが見られる。パスワードは返さない)
-------------------------------------------------------------------------------
drop function if exists public.admin_user_overview();
create function public.admin_user_overview()
returns table (
  uid uuid, account_email text, joined_at timestamptz, last_login_at timestamptz,
  terms_version text, terms_accepted_at text,
  answer_count bigint, avg_seconds numeric, last_answer_at timestamptz,
  own_questions bigint, imported_questions bigint, packs_used text,
  full_name text, full_name_kana text
)
language sql stable security definer set search_path = public as $$
  select
    u.id, u.email::text, u.created_at, u.last_sign_in_at,
    u.raw_user_meta_data ->> 'terms_version',
    u.raw_user_meta_data ->> 'terms_accepted_at',
    coalesce(a.cnt, 0), a.avg_s, a.last_at,
    coalesce(q.own, 0), coalesce(q.imp, 0), r.packs,
    nullif(btrim(coalesce(u.raw_user_meta_data ->> 'family_kanji', '') || ' ' || coalesce(u.raw_user_meta_data ->> 'given_kanji', '')), ''),
    nullif(btrim(coalesce(u.raw_user_meta_data ->> 'family_kana', '')  || ' ' || coalesce(u.raw_user_meta_data ->> 'given_kana', '')), '')
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
  where public.is_admin()
  order by u.last_sign_in_at desc nulls last;
$$;
revoke all on function public.admin_user_overview() from public, anon;
grant execute on function public.admin_user_overview() to authenticated;
