// 標準(デフォルト)の質問データ。owner_id が null のものが「標準」扱いです。
// parent_id が null → トップ階層。parent_id に別の質問の id を入れると「その質問の深掘り」になります。
// 子は、親が流れるまで(ランダムモードでは)絶対に出題されません。
// audio は index.html からの相対パス。MP3 は audio/ フォルダに置いてください。
// MP3 が無い場合は、ブラウザの音声合成が質問文を読み上げるので、動作確認だけならそのまま試せます。
window.DEFAULT_QUESTIONS = [
  { id: "q01", title: "まず、自己紹介をお願いします。",               audio: "audio/q01.mp3", parent_id: null,  sort_order: 10, owner_id: null },
  { id: "q02", title: "学生時代に力を入れたことは何ですか?",         audio: "audio/q02.mp3", parent_id: "q01", sort_order: 11, owner_id: null },
  { id: "q03", title: "あなたの長所と短所を教えてください。",         audio: "audio/q03.mp3", parent_id: "q01", sort_order: 12, owner_id: null },
  { id: "q04", title: "その短所を、どう改善しようとしていますか?",   audio: "audio/q04.mp3", parent_id: "q03", sort_order: 13, owner_id: null },

  { id: "q05", title: "志望動機を教えてください。",                   audio: "audio/q05.mp3", parent_id: null,  sort_order: 20, owner_id: null },
  { id: "q06", title: "なぜ他社ではなく当社なのですか?",             audio: "audio/q06.mp3", parent_id: "q05", sort_order: 21, owner_id: null },

  { id: "q07", title: "入社後にやりたいことは何ですか?",             audio: "audio/q07.mp3", parent_id: null,  sort_order: 30, owner_id: null },
  { id: "q08", title: "最後に、何か質問はありますか?",               audio: "audio/q08.mp3", parent_id: null,  sort_order: 40, owner_id: null }
];
