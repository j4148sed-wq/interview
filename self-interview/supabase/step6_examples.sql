-- ステップ6: 運営者が SQL Editor で使う操作集(必要な部分だけ選んで実行してください)

-------------------------------------------------------------------------------
-- A) 責任者の追加 / 削除 / 一覧(メールアドレスで指定。先に本人がアプリで登録済みであること)
-------------------------------------------------------------------------------
insert into public.admins (user_id, note)
select id, '運営者(自分)' from auth.users where email = 'j4148sed@sit.ac.jp'
on conflict do nothing;

-- delete from public.admins where user_id = (select id from auth.users where email = '外す人のメールアドレス');

-- select u.email, a.note, a.created_at from public.admins a join auth.users u on u.id = a.user_id;

-------------------------------------------------------------------------------
-- B) 質問セットと招待コードの登録
--   1. 先に Supabase の Storage → pack-audio バケットに、音声ファイルをアップロードしておく
--      (例: setA フォルダを作って 01.mp3 / 02.mp3 を入れる → audio_path は 'setA/01.mp3')
--   2. 下のブロックの名前・タイトル・パス・コードを書き換えて実行
-------------------------------------------------------------------------------
do $$
declare
  v_pack uuid;
  v_q1   uuid;
begin
  insert into public.packs (name, description) values ('就活セットA', '自己PRと志望動機の質問') returning id into v_pack;

  -- 親の質問
  insert into public.pack_questions (pack_id, title, audio_path, sort_order)
  values (v_pack, '自己PRをお願いします。', 'setA/01.mp3', 10)
  returning id into v_q1;

  -- その深掘り(parent_pack_id に親の id を入れる)
  insert into public.pack_questions (pack_id, title, audio_path, parent_pack_id, sort_order)
  values (v_pack, 'その経験から学んだことは何ですか?', 'setA/02.mp3', v_q1, 11);

  -- 標準質問 q01 の深掘りにしたい場合は、parent_default_id を使う
  insert into public.pack_questions (pack_id, title, audio_path, parent_default_id, sort_order)
  values (v_pack, '自己紹介で、一番伝えたいことは?', 'setA/03.mp3', 'q01', 20);

  -- 招待コード(大文字小文字は区別されない。max_uses=使えるアカウント数、expires_at=期限)
  insert into public.invite_codes (code, pack_id, max_uses, expires_at, note)
  values ('SETA-2026', v_pack, 50, null, '配布用');
end $$;

-------------------------------------------------------------------------------
-- C) コードの停止・上限・期限の変更
-------------------------------------------------------------------------------
-- update public.invite_codes set active = false where lower(code) = 'seta-2026';
-- update public.invite_codes set max_uses = 100 where lower(code) = 'seta-2026';
-- update public.invite_codes set expires_at = '2026-12-31 23:59:59+09' where lower(code) = 'seta-2026';

-------------------------------------------------------------------------------
-- D) コードごとの使用状況
-------------------------------------------------------------------------------
-- select c.code, c.max_uses, count(r.id) as used, c.active
-- from public.invite_codes c left join public.invite_redemptions r on r.code_id = c.id
-- group by c.id order by c.created_at desc;
