-- ステップ8: 責任者画面から「質問セット・音声ファイル・招待コード」を管理する / 追加した質問を、使用済みの人にも届ける
-- Supabase の SQL Editor に貼り付けて「Run」し、「Success」と出ることを確認してください(1回だけ実行)。
-- ※ ステップ3・4・6・7のSQLを実行済みであることが前提です。

-------------------------------------------------------------------------------
-- 1) 音声ファイルなしの質問を許可する(その場合は、質問文を自動音声で読み上げる)
-------------------------------------------------------------------------------
alter table public.pack_questions alter column audio_path drop not null;
alter table public.user_questions alter column audio_path drop not null;

-------------------------------------------------------------------------------
-- 2) 「どの限定質問を、誰に届けたか」の記録
-------------------------------------------------------------------------------
alter table public.user_questions
  add column if not exists source_pack_question_id uuid references public.pack_questions (id) on delete cascade;
create index if not exists uq_source_pq_idx on public.user_questions (user_id, source_pack_question_id);

create table if not exists public.pack_deliveries (
  user_id          uuid not null references auth.users (id) on delete cascade,
  pack_question_id uuid not null references public.pack_questions (id) on delete cascade,
  delivered_at     timestamptz not null default now(),
  primary key (user_id, pack_question_id)
);
alter table public.pack_deliveries enable row level security;   -- ポリシーなし = アプリから直接は触れない

-- すでにコードを使った人: 今あるセットの質問は「届け済み」にする(あとで本人が消した質問が、復活しないように)
insert into public.pack_deliveries (user_id, pack_question_id)
select r.user_id, pq.id
from public.invite_redemptions r
join public.invite_codes c on c.id = r.code_id
join public.pack_questions pq on pq.pack_id = c.pack_id
on conflict do nothing;

-- すでに取り込み済みの質問と、元の質問をひもづける(親子関係の引き継ぎと、セットから消した時の連動削除に使う)
update public.user_questions uq
   set source_pack_question_id = (
     select (min(pq.id::text))::uuid
     from public.invite_codes c
     join public.pack_questions pq on pq.pack_id = c.pack_id
     where c.id = uq.source_code_id and pq.title = uq.title and pq.audio_path is not distinct from uq.audio_path
   )
 where uq.audio_bucket = 'pack-audio' and uq.source_code_id is not null and uq.source_pack_question_id is null;

-------------------------------------------------------------------------------
-- 3) セットの質問を、ある人に届ける(まだ届けていない分だけ。上限100件の範囲で)
-------------------------------------------------------------------------------
create or replace function public._deliver_pack(p_uid uuid, p_pack uuid, p_code uuid, p_limit int) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with todo as (
    select pq.* from public.pack_questions pq
    where pq.pack_id = p_pack
      and not exists (select 1 from public.pack_deliveries d where d.user_id = p_uid and d.pack_question_id = pq.id)
    order by pq.sort_order, pq.created_at
    limit greatest(p_limit, 0)
  ),
  m as (
    select t.id as pqid, gen_random_uuid() as new_id, t.title, t.audio_path,
           t.parent_pack_id, t.parent_default_id, t.sort_order, t.created_at as oc
    from todo t
  ),
  ins as (
    insert into public.user_questions
      (id, user_id, title, audio_bucket, audio_path, parent_id, source_code_id, source_pack_question_id, created_at)
    select m.new_id, p_uid, m.title, 'pack-audio', m.audio_path,
           coalesce(
             pm.new_id::text,                                                   -- 今回いっしょに届ける親
             (select uq.id::text from public.user_questions uq                 -- すでに届いている親
               where uq.user_id = p_uid and uq.source_pack_question_id = m.parent_pack_id limit 1),
             m.parent_default_id),                                              -- 標準の質問が親
           p_code, m.pqid,
           now() + (row_number() over (order by m.sort_order, m.oc)) * interval '1 millisecond'
    from m left join m pm on pm.pqid = m.parent_pack_id
    returning source_pack_question_id
  )
  insert into public.pack_deliveries (user_id, pack_question_id)
  select p_uid, source_pack_question_id from ins;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public._deliver_pack(uuid, uuid, uuid, int) from public, anon, authenticated;

-- 招待コードの使用(取り込み部分を _deliver_pack に置き換えた版)
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

  if (select count(*) from public.invite_attempts
      where user_id = v_uid and created_at > now() - interval '10 minutes') >= 10 then
    return jsonb_build_object('ok', false, 'error', 'too_many_attempts');
  end if;

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

  perform public._deliver_pack(v_uid, v_code.pack_id, v_code.id, 100 - v_existing);

  insert into public.invite_redemptions (code_id, user_id, code_text, pack_name, question_count)
  values (v_code.id, v_uid, v_code.code, v_pack_name, v_count);

  return jsonb_build_object('ok', true, 'pack_name', v_pack_name, 'count', v_count);
end $$;
revoke all on function public.redeem_invite_code(text) from public, anon;
grant execute on function public.redeem_invite_code(text) to authenticated;

-- ログイン時にアプリが呼ぶ: 使用済みのコードのセットに、あとから追加された質問を届ける
create or replace function public.sync_my_packs() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  r record; v_added int := 0; v_exist int; v_pending int;
begin
  if v_uid is null then return jsonb_build_object('added', 0, 'pending', 0); end if;
  for r in
    select distinct c.pack_id, c.id as code_id
    from public.invite_redemptions ir join public.invite_codes c on c.id = ir.code_id
    where ir.user_id = v_uid
  loop
    select count(*) into v_exist from public.user_questions where user_id = v_uid;
    v_added := v_added + public._deliver_pack(v_uid, r.pack_id, r.code_id, 100 - v_exist);
  end loop;

  select count(*) into v_pending
  from public.pack_questions pq
  where pq.pack_id in (select c.pack_id from public.invite_redemptions ir join public.invite_codes c on c.id = ir.code_id where ir.user_id = v_uid)
    and not exists (select 1 from public.pack_deliveries d where d.user_id = v_uid and d.pack_question_id = pq.id);
  return jsonb_build_object('added', v_added, 'pending', v_pending);   -- pending = 上限のため届けられなかった件数
end $$;
revoke all on function public.sync_my_packs() from public, anon;
grant execute on function public.sync_my_packs() to authenticated;

-------------------------------------------------------------------------------
-- 4) 責任者が、アプリから音声ファイルをアップロード・削除できるようにする(pack-audio バケット)
-------------------------------------------------------------------------------
drop policy if exists "pa_admin_all" on storage.objects;
create policy "pa_admin_all" on storage.objects
  for all to authenticated
  using (bucket_id = 'pack-audio' and public.is_admin())
  with check (bucket_id = 'pack-audio' and public.is_admin());

-------------------------------------------------------------------------------
-- 5) 責任者向けの操作(責任者以外が呼ぶとエラー)
-------------------------------------------------------------------------------
create or replace function public.admin_list_packs()
returns table (id uuid, name text, description text, question_count bigint, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return query
    select p.id, p.name, p.description,
           (select count(*) from public.pack_questions q where q.pack_id = p.id), p.created_at
    from public.packs p order by p.created_at desc;
end $$;
revoke all on function public.admin_list_packs() from public, anon;
grant execute on function public.admin_list_packs() to authenticated;

create or replace function public.admin_create_pack(p_name text, p_description text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 100 then raise exception 'bad_request'; end if;
  insert into public.packs (name, description) values (btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''))
  returning id into v;
  return v;
end $$;
revoke all on function public.admin_create_pack(text, text) from public, anon;
grant execute on function public.admin_create_pack(text, text) to authenticated;

create or replace function public.admin_list_pack_questions(p_pack uuid)
returns table (id uuid, title text, audio_path text, parent_pack_id uuid, parent_default_id text, sort_order int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return query
    select q.id, q.title, q.audio_path, q.parent_pack_id, q.parent_default_id, q.sort_order
    from public.pack_questions q where q.pack_id = p_pack order by q.sort_order, q.created_at;
end $$;
revoke all on function public.admin_list_pack_questions(uuid) from public, anon;
grant execute on function public.admin_list_pack_questions(uuid) to authenticated;

-- 質問の追加。音声ファイル(p_audio_path)は、先に Storage の pack-audio へ「<セットのID>/ファイル名」でアップロードしておく。null なら自動音声
create or replace function public.admin_add_pack_question(
  p_pack uuid, p_title text, p_audio_path text, p_parent_pack uuid, p_parent_default text, p_sort int
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if char_length(btrim(coalesce(p_title, ''))) not between 1 and 200 then raise exception 'bad_request'; end if;
  if p_audio_path is not null and p_audio_path not like p_pack::text || '/%' then raise exception 'bad_path'; end if;
  if p_parent_pack is not null and not exists (select 1 from public.pack_questions where id = p_parent_pack and pack_id = p_pack) then
    raise exception 'bad_parent';
  end if;
  insert into public.pack_questions (pack_id, title, audio_path, parent_pack_id, parent_default_id, sort_order)
  values (p_pack, btrim(p_title), p_audio_path, p_parent_pack,
          case when p_parent_pack is null then nullif(p_parent_default, '') end, coalesce(p_sort, 0))
  returning id into v;
  return v;
end $$;
revoke all on function public.admin_add_pack_question(uuid, text, text, uuid, text, int) from public, anon;
grant execute on function public.admin_add_pack_question(uuid, text, text, uuid, text, int) to authenticated;

-- 質問の削除(深掘り質問と、すでに届けた人の「自分の質問」からも消える)。消した音声ファイルのパスを返す
create or replace function public.admin_delete_pack_question(p_id uuid) returns text[]
language plpgsql security definer set search_path = public as $$
declare v_paths text[];
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  with recursive d as (
    select id, audio_path from public.pack_questions where id = p_id
    union all
    select q.id, q.audio_path from public.pack_questions q join d on q.parent_pack_id = d.id
  )
  select coalesce(array_agg(audio_path) filter (where audio_path is not null), '{}') into v_paths from d;
  delete from public.pack_questions where id = p_id;
  return v_paths;
end $$;
revoke all on function public.admin_delete_pack_question(uuid) from public, anon;
grant execute on function public.admin_delete_pack_question(uuid) to authenticated;

-- 招待コード
drop function if exists public.admin_list_codes();
create function public.admin_list_codes()
returns table (id uuid, code text, pack_id uuid, pack_name text, active boolean, max_uses int, used bigint, expires_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  return query
    select c.id, c.code, c.pack_id, p.name, c.active, c.max_uses,
           (select count(*) from public.invite_redemptions r where r.code_id = c.id),
           c.expires_at
    from public.invite_codes c join public.packs p on p.id = c.pack_id
    order by c.created_at desc;
end $$;
revoke all on function public.admin_list_codes() from public, anon;
grant execute on function public.admin_list_codes() to authenticated;

create or replace function public.admin_create_code(p_pack uuid, p_code text, p_max_uses int, p_expires timestamptz) returns uuid
language plpgsql security definer set search_path = public as $$
declare v uuid; c text := btrim(coalesce(p_code, ''));
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  if c !~ '^[A-Za-z0-9_-]{4,64}$' then raise exception 'bad_code'; end if;
  if exists (select 1 from public.invite_codes where lower(code) = lower(c)) then raise exception 'duplicate_code'; end if;
  insert into public.invite_codes (code, pack_id, max_uses, expires_at)
  values (c, p_pack, p_max_uses, p_expires) returning id into v;
  return v;
end $$;
revoke all on function public.admin_create_code(uuid, text, int, timestamptz) from public, anon;
grant execute on function public.admin_create_code(uuid, text, int, timestamptz) to authenticated;

create or replace function public.admin_set_code_active(p_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'forbidden'; end if;
  update public.invite_codes set active = p_active where id = p_id;
end $$;
revoke all on function public.admin_set_code_active(uuid, boolean) from public, anon;
grant execute on function public.admin_set_code_active(uuid, boolean) to authenticated;
