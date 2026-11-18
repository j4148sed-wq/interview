(() => {
  "use strict";

  /* ========== 設定・保存 ========== */
  const LS_HISTORY = "si_history_v1";
  const LS_SETTINGS = "si_settings_v1";
  // 利用規約を改定したら、この日付を変える(terms.html の制定日と合わせる)。
  // 変えると、既存ユーザーにも次回ログイン時に再同意が求められます。
  const TERMS_VERSION = "2026-11-18.2";
  const BUCKET = "question-audio";          // Supabase Storage のバケット名
  const MAX_FILE = 10 * 1024 * 1024;        // 音声ファイルの上限 10MB
  const MAX_QUESTIONS = 100;                // 1人あたりの自作質問の上限(DB側にも同じ制限あり)
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const loadJSON = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  };
  const saveJSON = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.warn("保存に失敗", e); }
  };

  // Supabase(config.js が未設定、または読み込めない場合は null → 端末内保存のみで動作)
  const CFG = window.APP_CONFIG || {};
  const sb = window.supabase && CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && !CFG.SUPABASE_URL.includes("YOUR_")
    ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY)
    : null;

  let noticeTimer;
  function notify(msg) {
    const el = $("#notice");
    el.textContent = msg;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (el.textContent = ""), 4000);
  }

  const state = {
    settings: { mode: "random", timerBase: "end", showTitle: true, recordAnswers: false, source: "default", sttModel: "Xenova/whisper-small", ...loadJSON(LS_SETTINGS, {}) },
    local: loadJSON(LS_HISTORY, []),   // この端末に保存した記録
    history: [],                       // 画面に表示する記録(ログイン中=アカウント / 未ログイン=端末)
    user: null,
    authReady: false,                  // ログイン状態の確認が終わったか
    userQuestions: [],                 // 自分で追加した質問
    justFinished: false,               // 全質問が終わって、記録ページに移動した直後か
    saving: false,                     // 記録の保存中
    forceTitle: false,                 // 音声が再生できなかった時は、設定に関係なく質問文を表示する
    isAdmin: false,                    // 責任者か
    redemptions: [],                   // 使用済みの招待コード
    scripts: new Map(),                // 原稿(質問id → 文章)
    scriptFor: null,                   // 原稿を編集中の質問
    notices: [],                       // 氏名の一致で届いた、未使用の招待コード
    adminCodes: [],                    // 責任者画面: 招待コード一覧
    adminTargets: [],                  // 責任者画面: 招待コードの送り先
    adminPacks: [],                    // 責任者画面: 質問セット
    packQs: [],                        // 責任者画面: 選んだセットの質問
    adminRows: [],                     // 責任者画面の一覧
    unlocked: false,                   // 音声要素の「再生許可」済みか(iOS対策)
    phase: "idle",          // idle | playing | answering | done
    current: null,
    stack: [],              // 深掘り待ちの質問リストの積み重ね
    askedTop: new Set(),    // 出題済みのトップ階層の質問
    order: [],              // 順番モード用
    seqIndex: 0,
    startTime: 0,
    tick: null,
    token: 0                // 再生のたびに増やし、古い再生の完了通知を無視する
  };

  state.history = state.local;

  /* ========== 質問データ ========== */
  const defaults = () => window.DEFAULT_QUESTIONS.slice();            // 標準の質問(リポジトリ内)
  const getQuestions = () => defaults().concat(state.userQuestions);  // 標準 + 自分の質問
  const bySort = (a, b) => a.sort_order - b.sort_order;
  const childrenOf = (id, pool = getQuestions()) => pool.filter((q) => q.parent_id === id).sort(bySort);
  const flatten = (parentId = null, depth = 0, pool = getQuestions()) =>
    childrenOf(parentId, pool).flatMap((q) => [{ ...q, depth }, ...flatten(q.id, depth + 1, pool)]);

  // 出題に使う質問の集まり。標準の質問と、招待コードの質問は、同時には出題しない。
  //   source = "default"  : 標準の質問 + 自分で追加した質問(招待コードの質問は含めない)
  //   source = コードのID : その招待コードで取り込んだ質問だけ
  function activeSource() {
    const s = state.settings.source;
    return s && s !== "default" && state.userQuestions.some((q) => q.source_code_id === s) ? s : "default";
  }
  function playPool() {
    const src = activeSource();
    const list = src === "default"
      ? defaults().concat(state.userQuestions.filter((q) => !q.imported))
      : state.userQuestions.filter((q) => q.source_code_id === src);
    const ids = new Set(list.map((q) => q.id));
    // 親が集まりの外にある質問は、トップ階層として扱う
    return list.map((q) => (q.parent_id && !ids.has(q.parent_id) ? { ...q, parent_id: null } : q));
  }

  // 「自分の質問」の表示用。親が標準の質問(または無し)のものがルートになる
  function flattenMine() {
    const mine = state.userQuestions;
    const ids = new Set(mine.map((q) => q.id));
    const defTitle = new Map(defaults().map((q) => [q.id, q.title]));
    const walk = (pid, depth) => mine.filter((q) => q.parent_id === pid).sort(bySort)
      .flatMap((q) => [{ ...q, depth }, ...walk(q.id, depth + 1)]);
    return mine.filter((q) => !ids.has(q.parent_id)).sort(bySort)
      .flatMap((q) => [{ ...q, depth: 0, parentLabel: defTitle.get(q.parent_id) || "" }, ...walk(q.id, 1)]);
  }
  const descendantIds = (id) => state.userQuestions.filter((q) => q.parent_id === id)
    .flatMap((q) => [q.id, ...descendantIds(q.id)]);

  /* ========== 出題ロジック ========== */
  function pickRandom() {
    // 1) 深掘り中なら、その子の中からランダム
    while (state.stack.length && state.stack[state.stack.length - 1].length === 0) state.stack.pop();
    let q;
    if (state.stack.length) {
      const list = state.stack[state.stack.length - 1];
      q = list.splice(Math.floor(Math.random() * list.length), 1)[0];
    } else {
      // 2) 深掘りが終わったらトップ階層からランダム(全部出し終えたら null を返して終了)
      const pool = childrenOf(null, playPool()).filter((t) => !state.askedTop.has(t.id));
      if (!pool.length) return null;
      q = pool[Math.floor(Math.random() * pool.length)];
      state.askedTop.add(q.id);
    }
    // 3) この質問に子がいれば、次はその子たちから出す
    const kids = childrenOf(q.id, playPool());
    if (kids.length) state.stack.push([...kids]);
    return q;
  }

  function nextQuestion() {
    if (state.settings.mode === "random") return pickRandom();
    if (state.settings.mode === "sequential") return state.order[state.seqIndex++] ?? null;
    return null; // pick モードは一覧から選ぶ
  }

  // この後に出す質問が、まだ残っているか
  function hasMore() {
    if (state.settings.mode === "sequential") return state.seqIndex < state.order.length;
    if (state.settings.mode === "random") {
      if (state.stack.some((l) => l.length)) return true;
      return childrenOf(null, playPool()).some((t) => !state.askedTop.has(t.id));
    }
    return false;
  }

  function resetSession() {
    state.stack = [];
    state.askedTop.clear();
    state.order = flatten(null, 0, playPool());
    state.seqIndex = 0;
  }

  /* ========== 再生 ========== */
  const audio = new Audio();
  audio.preload = "auto";

  // iOS Safari は、最初のタップの中で音声要素を一度再生しておかないと、後からの自動再生を拒否することがある
  const SILENT_WAV = "data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";

  // 自作質問の音声は非公開バケットにあるので、再生のたびに期限付きURLを発行する(使い回しあり)
  const urlCache = new Map();
  async function resolveAudioUrl(q) {
    if (q.audio) return q.audio;                       // 標準の質問: リポジトリ内のファイル
    if (!q.audio_path || !sb) return null;
    const bucket = q.audio_bucket || BUCKET;
    const key = bucket + "/" + q.audio_path;
    const hit = urlCache.get(key);
    if (hit && hit.exp > Date.now()) return hit.url;
    const { data, error } = await sb.storage.from(bucket).createSignedUrl(q.audio_path, 3600);
    if (error || !data) { console.warn(error); return null; }
    urlCache.set(key, { url: data.signedUrl, exp: Date.now() + 3000 * 1000 });
    return data.signedUrl;
  }

  function stopAudio() {
    state.token++;
    audio.onended = null;
    audio.onerror = null;
    audio.onplaying = null;
    audio.pause();
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  }

  // MP3 が無い/再生できない時の代替(質問文の読み上げ)
  let speechUnlocked = false;
  // 端末内蔵の日本語の声を優先する(Chrome の「Google 日本語」などネット経由の声は、読み上げが止まることがある)
  const jaVoice = () => {
    try {
      const v = speechSynthesis.getVoices().filter((x) => /^ja/i.test(x.lang));
      return v.find((x) => x.lang === "ja-JP" && x.localService) || v.find((x) => x.localService)
        || v.find((x) => x.lang === "ja-JP") || v[0] || null;
    } catch { return null; }
  };
  const voiceInfo = () => {
    try {
      const v = speechSynthesis.getVoices();
      return `声${v.length}件・日本語${v.filter((x) => /^ja/i.test(x.lang)).length}件`;
    } catch { return "声の情報なし"; }
  };
  let keepUtt = null;   // 読み上げ中のデータを保持する。Chrome は、参照が無くなると、読み上げが途中で止まることがある

  // iPhone の Safari は、ボタンを押した瞬間に一度だけ読み上げを許可しないと、後からの読み上げが無音になる
  function unlockSpeech() {
    if (speechUnlocked || !("speechSynthesis" in window)) return;
    speechUnlocked = true;
    try {
      speechSynthesis.getVoices();                    // 声の一覧の読み込みを始めておく(Chrome は、非同期で読み込む)
      speechSynthesis.onvoiceschanged = () => {};
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      u.lang = "ja-JP";
      speechSynthesis.speak(u);
    } catch (e) { console.warn(e); }
  }

  // onSilent: 2.5秒たっても読み上げが始まらない時に呼ばれる(音量・消音スイッチ・日本語音声の案内用)
  function speak(text, done, onSilent) {
    let called = false, started = false, wd, sw;
    const once = () => { if (called) return; called = true; clearTimeout(wd); clearTimeout(sw); done(); };
    // 読み上げが始まらない/終わりの通知が来ない端末でも止まらないよう、時間で打ち切る
    wd = setTimeout(once, Math.max(3000, text.length * 400 + 2000));
    if (!("speechSynthesis" in window)) { if (onSilent) onSilent(); setTimeout(once, 1500); return; }
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ja-JP";
      u.volume = 1; u.rate = 1; u.pitch = 1;
      const v = jaVoice();
      if (v) u.voice = v;
      keepUtt = u;
      u.onstart = () => { started = true; };
      u.onend = once;
      u.onerror = once;
      speechSynthesis.cancel();                       // 残っている読み上げを消す。直後の speak は iPhone で無視されることがあるので、少し待つ
      setTimeout(() => {
        try { speechSynthesis.resume(); } catch (e) { /* 非対応の環境では、何もしない */ }   // Chrome で、停止状態から始まることがあるため
        try { speechSynthesis.speak(u); } catch (e) { once(); }
      }, 80);
      sw = setTimeout(() => { if (!started && onSilent) onSilent(); }, 2500);
    } catch (e) { console.warn(e); setTimeout(once, 1500); }
  }

  // iPhone などでは、タップした瞬間に音声の再生を解禁しておく必要がある
  function unlockAll() {
    unlockSpeech();
    if (!state.unlocked) {
      state.unlocked = true;
      audio.src = SILENT_WAV;
      audio.play().catch(() => {});
    }
  }

  function play(q) {
    stopAudio();
    discardAnswerRec();   // 「もう一度聞く」の時は、そこまでの録音を捨てて録り直す
    const token = state.token;
    let fellBack = false, watch = null;
    state.current = q;
    state.forceTitle = false;
    setPhase("playing");

    const finish = () => {
      clearTimeout(watch);
      if (token !== state.token) return;
      setPhase("answering");
      startAnswerRec(token);
      if (state.settings.timerBase === "end") startTimer();
    };
    // 音声を再生できなかった時: 質問文を表示して読み上げ、止まらずに回答へ進む
    const fallback = (why) => {
      if (fellBack || token !== state.token) return;
      fellBack = true;
      clearTimeout(watch);
      console.warn("音声の再生に失敗:", why, audio.error);
      audio.onended = null; audio.onerror = null; audio.onplaying = null;
      state.forceTitle = true;
      $("#qtitle").textContent = q.title;
      $("#status").textContent = why ? `音声を再生できませんでした(${why})。質問文を読み上げます…` : "質問文を読み上げています…";
      speak(q.title, finish, () => {
        if (token === state.token && state.phase === "playing") {
          $("#status").textContent = `読み上げが始まりません(${voiceInfo()})。端末の音量・消音スイッチ・日本語の音声を確認してください`;
        }
      });
    };

    resetTimer();
    if (state.settings.timerBase === "start") startTimer();

    unlockAll();
    // 録音する設定なら、マイクの許可が決まってから質問を流す(許可の確認中に質問が始まらないように)
    let micWait = Promise.resolve(true);
    if (state.settings.recordAnswers) {
      micWait = ensureMic();
      if (!(ans.stream && ans.stream.active) && !ans.denied) $("#status").textContent = "マイクの許可を待っています…";
    }

    micWait.then(() => {
      if (token !== state.token) return null;
      return resolveAudioUrl(q);
    }).then((url) => {
      if (token !== state.token) return;
      if (!url) { fallback(q.audio || q.audio_path ? "音声のURLを取得できません" : null); return; }   // 音声ファイルが無い質問は、初めから自動音声
      audio.onended = finish;
      audio.onerror = () => fallback("ファイルが無い、または形式に未対応");
      audio.onplaying = () => {
        clearTimeout(watch);
        const d = audio.duration;   // 終了の通知が来ない場合に備えて、長さ+3秒で次へ進む
        if (isFinite(d) && d > 0) watch = setTimeout(finish, (d + 3) * 1000);
      };
      audio.src = url;
      watch = setTimeout(() => fallback("読み込みの時間切れ"), 10000);
      audio.play().catch((e) => fallback(e && e.name === "NotAllowedError" ? "再生が許可されませんでした" : "再生を開始できません"));
    }).catch((e) => fallback("音声のURLを取得できません"));
  }

  /* ========== 回答の録音と聞き返し(録音はこの端末のメモリだけ。サーバーには送らない) ========== */
  const ans = { stream: null, micP: null, denied: false, recorder: null, chunks: [], mime: "", startP: null, items: [] };
  const micSupported = () => !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

  function ensureMic() {
    if (!$("#review")) return Promise.resolve(false);
    if (ans.stream && ans.stream.active) return Promise.resolve(true);
    if (ans.denied) return Promise.resolve(false);
    if (ans.micP) return ans.micP;
    if (!micSupported()) {
      ans.denied = true;
      notify("この環境では録音できないため、録音せずに続けます");
      return Promise.resolve(false);
    }
    ans.micP = navigator.mediaDevices.getUserMedia({ audio: true })
      .then((s) => { ans.stream = s; return true; })
      .catch((err) => {
        console.warn(err);
        ans.denied = true;
        notify("マイクを使えなかったため、録音せずに続けます(ブラウザのマイク許可を確認してください)");
        return false;
      })
      .finally(() => { ans.micP = null; });
    return ans.micP;
  }

  function releaseMic() {
    if (ans.stream) ans.stream.getTracks().forEach((t) => t.stop());   // スマホの録音中表示を消す
    ans.stream = null;
  }

  // 回答の録音を始める(質問の再生が終わって「回答してください」になった時)
  function startAnswerRec(token) {
    discardAnswerRec();
    if (!state.settings.recordAnswers) return;
    ans.startP = ensureMic().then((ok) => {
      if (!ok || token !== state.token || state.phase !== "answering") return;
      const mime = pickRecMime();
      const r = new MediaRecorder(ans.stream, mime ? { mimeType: mime } : undefined);
      ans.chunks = []; ans.mime = mime; ans.recorder = r;
      r.ondataavailable = (ev) => { if (ev.data && ev.data.size) ans.chunks.push(ev.data); };
      r.start();
    }).catch((e) => console.warn("録音を開始できません", e));
  }

  // 録音を止めて、音声データ(Blob)を返す。録っていなければ null
  async function stopAnswerRec() {
    try { await ans.startP; } catch (_) {}
    const r = ans.recorder;
    ans.recorder = null;
    if (!r || r.state === "inactive") return null;
    return new Promise((resolve) => {
      let done = false;
      const fin = () => {
        if (done) return; done = true;
        const blob = new Blob(ans.chunks, { type: r.mimeType || ans.mime || "audio/mp4" });
        ans.chunks = [];
        resolve(blob.size ? blob : null);
      };
      r.onstop = fin;
      setTimeout(fin, 2000);
      try { r.stop(); } catch (_) { fin(); }
    });
  }

  // 録音中のものを、保存せずに捨てる
  function discardAnswerRec() {
    const r = ans.recorder;
    ans.recorder = null; ans.startP = null; ans.chunks = [];
    if (r) {
      r.ondataavailable = null; r.onstop = null;
      try { if (r.state !== "inactive") r.stop(); } catch (_) {}
    }
  }

  // 録音データを、すべて消す(再生用のURLも解放する)
  function clearAnswerData() {
    discardAnswerRec();
    releaseMic();
    ans.items.forEach((it) => URL.revokeObjectURL(it.url));
    ans.items = [];
    ans.denied = false;
  }

  const reviewOpen = () => !$("#review").hidden;
  const beforeUnload = (e) => { e.preventDefault(); e.returnValue = ""; };

  function openReview() {
    if (!ans.items.length || !$("#review")) return;
    const list = $("#reviewList");
    list.textContent = "";
    ans.items.forEach((it, i) => {
      const li = document.createElement("li");
      const t = document.createElement("p"); t.className = "rt"; t.textContent = `${i + 1}. ${it.title}`;
      const s = document.createElement("p"); s.className = "rs"; s.textContent = `回答時間 ${fmt(it.seconds)}`;
      const au = document.createElement("audio");
      au.controls = true; au.preload = "metadata"; au.setAttribute("playsinline", ""); au.src = it.url;
      li.append(t, s, au);
      li.append(buildCheckBox(it));
      list.append(li);
    });
    $("#reviewConfirm").hidden = true;
    setReviewInert(false);
    $("#review").hidden = false;
    document.body.style.overflow = "hidden";
    document.querySelector("header.top").inert = true;
    document.querySelector("main").inert = true;
    window.addEventListener("beforeunload", beforeUnload);
    $("#reviewClose").focus();
  }

  const setReviewInert = (v) => { $("#review > .review-box").inert = v; };
  const pauseReviewAudio = () => $("#reviewList").querySelectorAll("audio").forEach((a) => a.pause());

  function closeReviewAndDelete() {
    stt.gen++;                 // 実行中の照合の結果は、捨てる
    pauseReviewAudio();
    $("#reviewList").querySelectorAll("audio").forEach((a) => { a.removeAttribute("src"); a.load(); });
    $("#reviewList").textContent = "";
    clearAnswerData();
    $("#review").hidden = true;
    $("#reviewConfirm").hidden = true;
    document.body.style.overflow = "";
    document.querySelector("header.top").inert = false;
    document.querySelector("main").inert = false;
    window.removeEventListener("beforeunload", beforeUnload);
  }

  function bindReviewUI() {
    // 閉じる → 確認を出す(まだ消さない)
    $("#reviewClose").onclick = () => {
      pauseReviewAudio();
      setReviewInert(true);
      $("#reviewConfirm").hidden = false;
      $("#reviewCancel").focus();
    };
    // キャンセル → 消さずに、聞き返しの画面へ戻る
    $("#reviewCancel").onclick = () => {
      $("#reviewConfirm").hidden = true;
      setReviewInert(false);
      $("#reviewClose").focus();
    };
    // 削除して閉じる → ここで初めて削除して閉じる
    $("#reviewDelete").onclick = closeReviewAndDelete;
    // 1つ再生したら、ほかは止める
    $("#reviewList").addEventListener("play", (e) => {
      $("#reviewList").querySelectorAll("audio").forEach((a) => { if (a !== e.target) a.pause(); });
    }, true);
    // Esc では閉じない。Tab キーの移動は、前面の画面の中だけにする
    document.addEventListener("keydown", (e) => {
      if (!reviewOpen()) return;
      if (e.key === "Escape") { e.preventDefault(); return; }
      if (e.key !== "Tab") return;
      const root = $("#reviewConfirm").hidden ? $("#review > .review-box") : $("#reviewConfirm");
      const f = [...root.querySelectorAll("button, audio[controls]")].filter((x) => !x.disabled);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (!root.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }

  /* ========== 原稿(アカウントに保存) ========== */
  async function loadScripts() {
    state.scripts = new Map();
    if (state.user && sb) {
      const { data, error } = await sb.from("question_scripts").select("question_id,script").limit(300);
      if (error) console.warn(error);
      else (data || []).forEach((r) => state.scripts.set(r.question_id, r.script));
    }
    renderList();
  }

  function openScript(qid) {
    const q = getQuestions().find((x) => x.id === qid);
    if (!q || !$("#scriptDlg")) return;
    state.scriptFor = qid;
    $("#scriptTitle").textContent = `原稿: ${q.title}`;
    $("#scriptText").value = state.scripts.get(qid) || "";
    $("#scriptDel").hidden = !state.scripts.has(qid);
    $("#scriptMsg").textContent = "";
    updateScriptCount();
    $("#scriptDlg").hidden = false;
    document.body.style.overflow = "hidden";
    document.querySelector("header.top").inert = true;
    document.querySelector("main").inert = true;
    $("#scriptText").focus();
  }
  function closeScript() {
    $("#scriptDlg").hidden = true;
    state.scriptFor = null;
    if ($("#review").hidden) document.body.style.overflow = "";
    document.querySelector("header.top").inert = false;
    document.querySelector("main").inert = false;
  }
  const updateScriptCount = () => { $("#scriptCount").textContent = `${[...$("#scriptText").value].length} / 3000文字`; };

  function bindScriptUI() {
    if (!$("#scriptDlg")) return;
    $("#scriptText").oninput = updateScriptCount;
    $("#scriptClose").onclick = closeScript;
    $("#scriptDlg").addEventListener("keydown", (e) => { if (e.key === "Escape") closeScript(); });
    $("#scriptSave").onclick = async () => {
      const qid = state.scriptFor, text = $("#scriptText").value.trim();
      if (!qid || !sb || !state.user) return;
      if (!text) { $("#scriptMsg").textContent = "原稿を入力してください。(消す場合は「原稿を削除」)"; return; }
      $("#scriptSave").disabled = true;
      const { error } = await sb.from("question_scripts")
        .upsert({ user_id: state.user.id, question_id: qid, script: text }, { onConflict: "user_id,question_id" });
      $("#scriptSave").disabled = false;
      if (error) { console.warn(error); $("#scriptMsg").textContent = "保存に失敗しました。(Supabaseで step9 のSQLを実行済みか確認してください)"; return; }
      state.scripts.set(qid, text); renderList(); closeScript(); notify("原稿を保存しました");
    };
    $("#scriptDel").onclick = async () => {
      const qid = state.scriptFor;
      if (!qid || !sb || !confirm("この原稿を削除します。よろしいですか?")) return;
      const { error } = await sb.from("question_scripts").delete().eq("question_id", qid);
      if (error) { console.warn(error); $("#scriptMsg").textContent = "削除に失敗しました。"; return; }
      state.scripts.delete(qid); renderList(); closeScript(); notify("原稿を削除しました");
    };
  }

  /* ========== 原稿との照合(AIの文字起こしは、すべてこの端末の中で行う) ========== */
  const STT_LIB = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1";
  const KURO_JS = "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/build/kuromoji.js";
  const KURO_DIC = "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/";
  const stt = { pipe: null, model: "", busy: false, kuro: null, gen: 0 };

  async function getTranscriber(say) {
    const model = state.settings.sttModel || "Xenova/whisper-small";
    if (stt.pipe && stt.model === model) return stt.pipe;
    const key = "si_stt_ready_" + model;
    let ready = false;
    try { ready = localStorage.getItem(key) === "1"; } catch (_) {}
    const size = model.endsWith("small") ? "約250MB" : "約80MB";
    if (!ready && !confirm(`初回は、AIのモデル(${size})をダウンロードします。Wi-Fi での利用をおすすめします。音声はこの端末の外に送られません。続けますか?`)) {
      const e = new Error("cancel"); e.cancel = true; throw e;
    }
    say("AIの部品を読み込んでいます…");
    const { pipeline, env } = await import(STT_LIB);
    env.allowLocalModels = false;
    const files = new Map();
    stt.pipe = await pipeline("automatic-speech-recognition", model, {
      device: "wasm", dtype: "q8",
      progress_callback: (p) => {
        if (p.status === "progress" && p.file) {
          files.set(p.file, p);
          let l = 0, t = 0; files.forEach((f) => { l += f.loaded || 0; t += f.total || 0; });
          if (t) say(`AIのモデルをダウンロード中… ${(l / 1048576).toFixed(0)} / ${(t / 1048576).toFixed(0)} MB`);
        }
      }
    });
    stt.model = model;
    try { localStorage.setItem(key, "1"); } catch (_) {}
    return stt.pipe;
  }

  // 読み(かな)を調べる辞書。読み込めなかった時は null を返し、文字どおりの比較に切り替える
  function loadKuromoji() {
    if (stt.kuro) return stt.kuro;
    stt.kuro = new Promise((resolve) => {
      const fail = () => { stt.kuro = null; resolve(null); };
      const s = document.createElement("script");
      s.src = KURO_JS;
      s.onload = () => {
        try { window.kuromoji.builder({ dicPath: KURO_DIC }).build((err, tk) => (err ? fail() : resolve(tk))); }
        catch (_) { fail(); }
      };
      s.onerror = fail;
      document.head.append(s);
    });
    return stt.kuro;
  }

  async function decode16k(b) {
    const buf = await b.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const decoded = await new Promise((res, rej) => ctx.decodeAudioData(buf.slice(0), res, rej));
    if (ctx.close) ctx.close();
    const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
    const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
    return (await off.startRendering()).getChannelData(0);
  }

  // 音量をそろえ、前後の無音を取り除く(無音が長いと、話していない定型文が出やすいため)
  function preprocessAudio(data) {
    let peak = 0; for (let i = 0; i < data.length; i++) { const v = Math.abs(data[i]); if (v > peak) peak = v; }
    if (peak < 1e-4) return data;
    const gain = Math.min(0.9 / peak, 30), win = 800, rms = [];
    for (let i = 0; i + win <= data.length; i += win) { let s = 0; for (let j = i; j < i + win; j++) s += data[j] * data[j]; rms.push(Math.sqrt(s / win) * gain); }
    const th = 0.02;
    const first = rms.findIndex((v) => v > th); let last = rms.length - 1; while (last > 0 && rms[last] <= th) last--;
    if (first < 0) return data;
    const s0 = Math.max(0, (first - 6) * win), s1 = Math.min(data.length, (last + 7) * win);
    const out = new Float32Array(s1 - s0);
    for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, data[s0 + i] * gain));
    return out;
  }

  const OUTRO = /(ご視聴|チャンネル登録|次回の動画|また次回|お会いしましょう|ありがとうございました|おやすみなさい|字幕)/;
  const nk = (s) => String(s || "").normalize("NFKC").replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/[\s、。,.!?「」『』()・…\-〜~]/g, "");
  function cleanOutro(chunks, script) {
    const keep = chunks.slice(), sn = nk(script);
    while (keep.length > 1) {
      const tx = (keep[keep.length - 1].text || "").trim();
      if (OUTRO.test(tx) && !sn.includes(nk(tx))) keep.pop(); else break;
    }
    return keep.map((c) => c.text).join("").trim();
  }

  // 文章を「表記 + 読み」の並びにする(辞書が無い時は、1文字ずつ)
  function toKanaTokens(tk, text) {
    if (!tk) return [...String(text)].map((ch) => ({ surface: ch, kana: nk(ch) }));
    return tk.tokenize(String(text)).map((t) => {
      const r = t.pronunciation && t.pronunciation !== "*" ? t.pronunciation : (t.reading && t.reading !== "*" ? t.reading : t.surface_form);
      return { surface: t.surface_form, kana: nk(r) };
    });
  }

  // 原稿の読みが、話した内容の読みに「順番どおりに」含まれているかを数える(LCS)
  function compareReadings(script, spoken, tk) {
    const st = toKanaTokens(tk, script), sp = toKanaTokens(tk, spoken);
    const a = [], owner = [];
    st.forEach((t, ti) => [...t.kana].forEach((ch) => { a.push(ch); owner.push(ti); }));
    const b = sp.flatMap((t) => [...t.kana]);
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const hit = new Array(n).fill(false);
    let i = 0, j = 0;
    while (i < n && j < m) { if (a[i] === b[j]) { hit[i] = true; i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++; }
    const bad = new Set(); hit.forEach((h, k) => { if (!h) bad.add(owner[k]); });
    const html = st.map((t, ti) => (bad.has(ti) ? `<span class="miss">${esc(t.surface)}</span>` : esc(t.surface))).join("");
    return { pct: n ? Math.round((dp[0][0] / n) * 100) : 0, matched: dp[0][0], total: n, html };
  }

  function buildCheckBox(it) {
    const box = document.createElement("div"); box.className = "chk";
    const script = state.scripts.get(it.qid);
    if (!script) {
      const p = document.createElement("p"); p.className = "rmsg";
      p.textContent = "原稿が未登録です。(質問一覧の「原稿」から登録すると、照合できます)";
      box.append(p); return box;
    }
    const btn = document.createElement("button"); btn.type = "button"; btn.className = "ghost chk-btn";
    btn.textContent = "原稿と照合する(AIで文字起こし)";
    const msg = document.createElement("p"); msg.className = "rmsg";
    const res = document.createElement("div");
    btn.onclick = () => runCheck(it, script, btn, msg, res);
    box.append(btn, msg, res);
    if (it.result) res.innerHTML = it.result;
    return box;
  }

  async function runCheck(it, script, btn, msg, res) {
    if (stt.busy) { msg.textContent = "ほかの照合を実行中です。終わってから押してください。"; return; }
    const gen = stt.gen;
    const alive = () => gen === stt.gen;
    const say = (t) => { if (alive()) msg.textContent = t; };
    stt.busy = true;
    document.querySelectorAll("#reviewList .chk-btn").forEach((b) => (b.disabled = true));
    res.textContent = "";
    try {
      const pipe = await getTranscriber(say);
      say("読みを調べる辞書を読み込んでいます…");
      const tk = await loadKuromoji();
      say("音声を読み込んでいます…");
      const data = preprocessAudio(await decode16k(it.blob));
      say("文字に起こしています…(端末によっては、数十秒かかります)");
      await new Promise((r) => setTimeout(r, 30));
      const out = await pipe(data, { language: "japanese", task: "transcribe", chunk_length_s: 30, stride_length_s: 5, return_timestamps: true });
      const chunks = Array.isArray(out.chunks) && out.chunks.length ? out.chunks : [{ text: out.text || "" }];
      const text = cleanOutro(chunks, script);
      const cmp = compareReadings(script, text, tk);
      if (!alive()) return;
      it.result = `
        <p class="score">原稿との一致: ${cmp.pct}%</p>
        <p class="out-label">原稿(読みが合わなかった言葉は赤)</p><div class="out">${cmp.html}</div>
        <p class="out-label">AIが聞き取った文章</p><div class="out">${esc(text || "(認識できませんでした)")}</div>
        <p class="rmsg">${tk ? "同じ読みの言葉(例: 専攻/先行)は、一致として数えています。" : "読みの辞書を読み込めなかったため、文字どおりに比べました。"}聞き取りの誤りもあるため、目安として見てください。</p>`;
      res.innerHTML = it.result; msg.textContent = "";
    } catch (e) {
      if (!alive()) return;
      if (e.cancel) msg.textContent = "キャンセルしました。";
      else { console.error(e); msg.textContent = "照合に失敗しました: " + (e.message || e); }
    } finally {
      stt.busy = false;
      document.querySelectorAll("#reviewList .chk-btn").forEach((b) => (b.disabled = false));
    }
  }

  /* ========== タイマー ========== */
  const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
  function updateTimer() { $("#timer").textContent = fmt((performance.now() - state.startTime) / 1000); }
  function startTimer() {
    clearInterval(state.tick);
    state.startTime = performance.now();
    state.tick = setInterval(updateTimer, 100);
    updateTimer();
  }
  function resetTimer() {
    clearInterval(state.tick);
    state.startTime = 0;
    $("#timer").textContent = "0:00.0";
  }
  // 計測中なら経過秒を返し、計測していなければ null
  function stopTimer() {
    clearInterval(state.tick);
    const sec = state.startTime ? (performance.now() - state.startTime) / 1000 : null;
    state.startTime = 0;
    return sec;
  }

  /* ========== 画面の状態 ========== */
  function setPhase(phase) {
    state.phase = phase;
    const q = state.current;
    const status = $("#status");
    const next = $("#nextBtn");
    const title = $("#qtitle");

    title.textContent = q && (state.settings.showTitle || state.forceTitle) && phase !== "done" ? q.title : "";
    $("#replayBtn").hidden = !(q && (phase === "playing" || phase === "answering"));
    next.classList.toggle("next", phase === "answered");

    if (phase === "idle") {
      status.textContent = state.settings.mode === "pick"
        ? "「質問一覧」から出題する質問を選んでください"
        : "スタートを押すと最初の質問が流れます";
      next.textContent = state.settings.mode === "pick" ? "質問を選ぶ" : "スタート";
    } else if (phase === "playing") {
      status.textContent = "質問を再生中…";
      next.textContent = "スキップして次へ";
    } else if (phase === "answering") {
      status.textContent = "回答してください";
      next.textContent = "回答終了";
    } else if (phase === "answered") {
      status.textContent = "回答時間を記録しました";
      next.textContent = state.settings.mode === "pick" ? "質問一覧へ戻る" : "次の質問へ";
    } else if (phase === "done") {
      status.textContent = "すべての質問が終了しました";
      next.textContent = "もう一度はじめる";
    }
  }

  function switchTab(name) {
    // 未ログイン・未同意の間は、アカウント画面しか開けない
    if (document.body.classList.contains("locked") && name !== "account") name = "account";
    if (name === "admin" && !state.isAdmin) name = "account";
    if (name !== "history") state.justFinished = false;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
    if (name === "history") renderHistory();
    if (name === "admin") loadAdmin();
  }

  /* ========== ボタン操作 ========== */
  function advance() {
    if (state.settings.mode === "pick") {
      stopAudio(); resetTimer();
      state.current = null;
      setPhase("idle");
      switchTab("list");
      return;
    }
    const q = nextQuestion();
    if (!q) {
      // 開始時に質問が無い場合は、その場で終了表示。出題の途中で尽きた場合は、記録ページへ移る
      if (state.phase === "idle" || state.phase === "done") {
        stopAudio(); resetTimer();
        state.current = null;
        setPhase("done");
      } else {
        finishSession();
      }
      return;
    }
    play(q);
  }

  // 全ての質問が終わった: 練習画面を「終了」にして、記録ページへ移動する
  function finishSession() {
    stopAudio(); resetTimer();
    state.current = null;
    state.justFinished = true;
    setPhase("done");
    switchTab("history");
    discardAnswerRec(); releaseMic();
    openReview();          // 録音があれば、聞き返しの画面を(閉じられない形で)出す
  }

  async function onNext() {
    if (state.saving) return;
    if (state.phase === "idle" || state.phase === "done") {
      state.justFinished = false;
      clearAnswerData();
      if (state.settings.recordAnswers) {
        unlockAll();                       // マイク許可の確認を待つ間に、タップの効力が切れないよう先に解禁
        state.saving = true;
        try { await ensureMic(); } finally { state.saving = false; }
      }
      resetSession();
      advance();
      return;
    }
    if (state.phase === "playing") {      // 質問の再生中 → 記録せずスキップ
      advance();
      return;
    }
    if (state.phase === "answering") {    // 回答終了 → 時間を止めて記録(自動では次へ進まない)
      const sec = stopTimer();
      const cur = state.current;
      state.saving = true;
      try {
        const blob = await stopAnswerRec();
        if (blob && cur && sec !== null) {
          ans.items.push({ qid: cur.id, title: cur.title, seconds: sec, blob, url: URL.createObjectURL(blob) });
        }
        if (sec !== null && cur) {
          $("#timer").textContent = fmt(sec);
          await saveAnswer(cur, sec);
        }
      } finally { state.saving = false; }
      // これが最後の質問だった場合は、保存したあと、自動で記録ページへ移る
      if (state.settings.mode !== "pick" && !hasMore()) { finishSession(); return; }
      setPhase("answered");
      if (state.settings.mode === "pick") { releaseMic(); openReview(); }   // 1問ずつ出題する時は、その場で聞き返す
      return;
    }
    advance();                            // answered → 次の質問へ
  }

  async function saveAnswer(q, seconds) {
    const rec = {
      question_id: q.id,
      title: q.title,
      seconds: Math.round(seconds * 10) / 10,
      mode: state.settings.mode,
      created_at: new Date().toISOString()
    };
    if (state.user && sb) {
      const { error } = await sb.from("answers").insert(rec);
      if (!error) {
        state.history.push(rec);
        notify("記録をアカウントに保存しました");
        return;
      }
      console.warn("保存に失敗", error);
      notify("通信に失敗したため、この端末に保存しました(アカウントタブから後で移せます)");
      state.local.push(rec);
      saveJSON(LS_HISTORY, state.local);
      renderAccount();
      return;
    }
    state.local.push(rec);
    state.history = state.local;
    saveJSON(LS_HISTORY, state.local);
  }

  /* ========== 質問一覧 ========== */
  const rowHtml = (q) => `
    <li style="--d:${q.depth}">
      <span class="t">${esc(q.title)}${q.parentLabel ? `<small class="sub">「${esc(q.parentLabel)}」の深掘り</small>` : ""}</span>
      ${q.imported ? '<span class="badge own">限定</span>' : ""}
      <button class="scr" data-scr="${esc(q.id)}" aria-label="原稿を入力・編集">原稿${state.scripts.has(q.id) ? " ✓" : ""}</button>
      <button class="play" data-id="${esc(q.id)}" aria-label="この質問を出題">▶</button>
      ${q.owner_id ? `<button class="del" data-del="${esc(q.id)}">削除</button>` : ""}
    </li>`;

  function renderList() {
    $("#list").innerHTML = flatten(null, 0, defaults()).map(rowHtml).join("");
    const mine = flattenMine();
    $("#myList").innerHTML = mine.length
      ? mine.map(rowHtml).join("")
      : `<li class="empty">まだありません。下のフォームから追加できます。</li>`;
  }

  function renderParentOptions() {
    const sel = $("#qParent");
    const keep = sel.value;
    sel.innerHTML = `<option value="">(なし)独立した質問</option>` +
      flatten().map((q) => `<option value="${esc(q.id)}">${"　".repeat(q.depth)}${esc(q.title)}</option>`).join("");
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "";
  }

  const listMsg = (t) => { $("#addMsg").textContent = t; };

  // 自分の質問をSupabaseから読み込む
  async function refreshQuestions() {
    if (!(state.user && sb)) {
      state.userQuestions = [];
    } else {
      const { data, error } = await sb.from("user_questions")
        .select("id,user_id,title,audio_path,audio_bucket,parent_id,source_code_id,created_at")
        .order("created_at", { ascending: true })
        .limit(MAX_QUESTIONS);
      if (error) {
        console.warn(error);
        listMsg("自分の質問の読み込みに失敗しました。(Supabaseで step4・step6 のSQLを実行済みか確認してください)");
        state.userQuestions = [];
      } else {
        const known = new Set([...defaults().map((q) => q.id), ...data.map((r) => r.id)]);
        state.userQuestions = data.map((r, i) => ({
          id: r.id, title: r.title, audio: null, audio_path: r.audio_path,
          audio_bucket: r.audio_bucket, imported: r.audio_bucket === "pack-audio", source_code_id: r.source_code_id || null,
          parent_id: r.parent_id && known.has(r.parent_id) ? r.parent_id : null, // 親が見つからなければトップ階層に
          sort_order: 1000 + i, owner_id: r.user_id
        }));
      }
    }
    renderList();
    renderParentOptions();
    renderSourceOptions();
  }

  const MIME_BY_EXT = { mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", webm: "audio/webm", aac: "audio/aac" };

  async function addQuestion(e) {
    e.preventDefault();
    if (!sb || !state.user) return;
    const title = $("#qTitle").value.trim();
    const parent = $("#qParent").value || null;
    const recorded = rec.blob;                                  // 録音があれば、そちらを優先
    const file = recorded ? null : $("#qFile").files[0];
    const source = recorded || file;

    let ext, contentType;
    if (recorded) {
      contentType = recorded.type.split(";")[0] || "audio/webm";   // "audio/webm;codecs=opus" → "audio/webm"
      ext = contentType.includes("mp4") ? "m4a" : contentType.includes("ogg") ? "ogg" : "webm";
    } else if (file) {
      ext = ((file.name.split(".").pop() || "mp3").toLowerCase().replace(/[^a-z0-9]/g, "")) || "mp3";
      if (!(file.type.startsWith("audio/") || MIME_BY_EXT[ext])) return listMsg("音声ファイル(MP3など)を選んでください。");
      contentType = file.type.startsWith("audio/") ? file.type : MIME_BY_EXT[ext];
    }

    if (!title) return listMsg("質問文を入力してください。");
    if (!source) return listMsg("音声ファイルを選ぶか、録音してください。");
    if (source.size > MAX_FILE) return listMsg("ファイルが大きすぎます(10MBまで)。");
    if (state.userQuestions.length >= MAX_QUESTIONS) return listMsg(`追加できる質問は${MAX_QUESTIONS}件までです。`);

    const btn = $("#addBtn");
    btn.disabled = true;
    listMsg("アップロード中…");
    try {
      const uid = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
      const path = `${state.user.id}/${uid}.${ext}`;

      const up = await sb.storage.from(BUCKET).upload(path, source, { contentType, upsert: false });
      if (up.error) { console.warn(up.error); return listMsg(`アップロードに失敗しました: ${up.error.message}`); }

      const ins = await sb.from("user_questions").insert({ title, audio_path: path, parent_id: parent });
      if (ins.error) {
        console.warn(ins.error);
        await sb.storage.from(BUCKET).remove([path]); // 登録に失敗したら、アップロードしたファイルも消す
        return listMsg(`登録に失敗しました: ${ins.error.message}`);
      }
      $("#addForm").reset();
      discardRecording();
      listMsg("質問を追加しました。");
      await refreshQuestions();
    } finally {
      btn.disabled = false;
    }
  }

  async function deleteQuestion(id) {
    const q = state.userQuestions.find((x) => x.id === id);
    if (!q || !sb) return;
    const ids = [id, ...descendantIds(id)];
    const n = ids.length - 1;
    const text = n ? `「${q.title}」と、その深掘り質問${n}件を削除します。よろしいですか?` : `「${q.title}」を削除します。よろしいですか?`;
    if (!confirm(text)) return;
    const paths = state.userQuestions.filter((x) => ids.includes(x.id) && x.audio_bucket !== "pack-audio").map((x) => x.audio_path);
    const { error } = await sb.from("user_questions").delete().in("id", ids);
    if (error) { listMsg(`削除に失敗しました: ${error.message}`); return; }
    sb.from("question_scripts").delete().in("question_id", ids).then(() => {}, () => {});   // 原稿も消す(失敗しても続行)
    ids.forEach((x) => state.scripts.delete(x));
    if (paths.length) {   // 招待コード由来の質問は、共有の音声なので Storage からは消さない
      const rm = await sb.storage.from(BUCKET).remove(paths);
      if (rm.error) console.warn(rm.error);
    }
    listMsg("削除しました。");
    await refreshQuestions();
  }

  /* ========== 記録 ========== */
  function renderHistory() {
    $("#doneNote").hidden = !state.justFinished;
    $("#historySource").textContent = state.user
      ? "保存先: アカウント(どの端末からでも見られます)"
      : "保存先: この端末のみ(ログインすると、アカウントに保存できます)";
    const h = state.history;
    if (!h.length) {
      $("#stats").innerHTML = `<li class="empty">まだ記録がありません。練習すると回答時間がここに残ります。</li>`;
      $("#recent").innerHTML = "";
      return;
    }
    const agg = new Map();
    h.forEach((r) => {
      const a = agg.get(r.question_id) || { title: r.title, n: 0, sum: 0 };
      a.n++; a.sum += r.seconds;
      agg.set(r.question_id, a);
    });
    $("#stats").innerHTML = [...agg.values()].map((a) =>
      `<li><span class="t">${esc(a.title)}</span><span class="num">平均 ${fmt(a.sum / a.n)}(${a.n}回)</span></li>`).join("");
    $("#recent").innerHTML = h.slice(-30).reverse().map((r) => {
      const d = new Date(r.created_at);
      const when = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      return `<li><span class="t">${esc(r.title)}</span><span class="num">${fmt(r.seconds)}<small>${when}</small></span></li>`;
    }).join("");
  }

  /* ========== マイク録音 ========== */
  const REC_MAX_SEC = 180; // 録音の最大時間(秒)
  const rec = { recorder: null, stream: null, chunks: [], blob: null, url: null, startAt: 0, tick: null };

  // 再生できる範囲が広い mp4(AAC)を優先し、無ければ webm / ogg
  const pickRecMime = () => ["audio/mp4", "audio/mp4;codecs=mp4a.40.2", "audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]
    .find((t) => MediaRecorder.isTypeSupported(t)) || "";

  function renderRecUI(mode) { // idle | recording | done
    $("#recStart").hidden = mode !== "idle";
    $("#recStopWrap").hidden = mode !== "recording";
    $("#recDone").hidden = mode !== "done";
    if (mode !== "recording") $("#recTime").textContent = "0:00.0";
  }

  async function startRecording() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      return listMsg("この環境では録音できません。https のページ(公開後のURL)か、PC の localhost で開いてください。");
    }
    discardRecording();
    // 練習中の質問が再生されていたら止める(スピーカーの音を拾わないように)
    if (state.phase === "playing" || state.phase === "answering") {
      stopAudio(); resetTimer(); state.current = null; setPhase("idle");
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.warn(err);
      return listMsg("マイクを使えませんでした。ブラウザのマイク許可を確認してください。");
    }
    const mime = pickRecMime();
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    rec.stream = stream; rec.recorder = recorder; rec.chunks = [];

    recorder.ondataavailable = (ev) => { if (ev.data.size) rec.chunks.push(ev.data); };
    recorder.onstop = () => {
      clearInterval(rec.tick);
      stream.getTracks().forEach((t) => t.stop()); // マイクを解放する(スマホの録音中表示を消す)
      rec.blob = new Blob(rec.chunks, { type: recorder.mimeType || mime || "audio/webm" });
      rec.url = URL.createObjectURL(rec.blob);
      $("#recPreview").src = rec.url;
      renderRecUI("done");
    };
    recorder.start();
    rec.startAt = performance.now();
    rec.tick = setInterval(() => {
      const sec = (performance.now() - rec.startAt) / 1000;
      $("#recTime").textContent = fmt(sec);
      if (sec >= REC_MAX_SEC) stopRecording();
    }, 200);
    $("#qFile").value = "";   // ファイル選択と録音は、どちらか一方
    listMsg("");
    renderRecUI("recording");
  }

  function stopRecording() {
    if (rec.recorder && rec.recorder.state === "recording") rec.recorder.stop();
  }

  function discardRecording() {
    if (rec.recorder && rec.recorder.state === "recording") {
      rec.recorder.onstop = null;
      rec.recorder.stop();
      rec.stream?.getTracks().forEach((t) => t.stop());
    }
    clearInterval(rec.tick);
    if (rec.url) URL.revokeObjectURL(rec.url);
    rec.blob = null; rec.url = null; rec.chunks = [];
    $("#recPreview").removeAttribute("src");
    renderRecUI("idle");
  }

  /* ========== 招待コードの履歴・責任者画面 ========== */
  function fmtDate(iso, withTime = false) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    const date = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    return withTime ? `${date} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : date;
  }

  // 「出題する質問」の選択肢(標準 / 取り込んだ招待コードごと)
  function renderSourceOptions() {
    const sel = $("#source");
    if (!sel) return;
    const packs = new Map();
    state.userQuestions.forEach((q) => { if (q.source_code_id) packs.set(q.source_code_id, 0); });
    state.redemptions.forEach((r) => { if (packs.has(r.code_id)) packs.set(r.code_id, r.pack_name); });
    let n = 0;
    sel.innerHTML = `<option value="default">標準の質問(自分で追加した質問を含む)</option>` +
      [...packs].map(([id, name]) => `<option value="${esc(id)}">${esc(name || "招待コードの質問 " + (++n))}(招待コード)</option>`).join("");
    sel.value = activeSource();
    sel.closest("label").hidden = packs.size === 0;   // 招待コードを使っていなければ、選択欄は出さない
  }

  async function loadRedemptions() {
    if (!(state.user && sb)) { state.redemptions = []; renderRedemptions(); return; }
    const { data, error } = await sb.from("invite_redemptions")
      .select("code_id,pack_name,question_count,created_at").order("created_at", { ascending: false });
    if (error) console.warn(error);
    state.redemptions = error ? [] : data;
    renderRedemptions();
    renderSourceOptions();
  }

  function renderRedemptions() {
    $("#redeemedList").innerHTML = state.redemptions.length
      ? state.redemptions.map((r) => `
        <li><span class="t">${esc(r.pack_name)}<small class="sub">${r.question_count}件の質問</small></span>
        <span class="num">${fmtDate(r.created_at)}</span></li>`).join("")
      : `<li class="empty">まだ使用していません。</li>`;
  }

  // 責任者かどうかを確認する(責任者でなければ「責任者」タブは出ない)
  async function refreshAdmin() {
    state.isAdmin = false;
    if (state.user && sb) {
      const { data, error } = await sb.rpc("is_admin");
      state.isAdmin = !error && data === true;
    }
    renderAccount();
  }

  async function loadAdmin() {
    if (!(sb && state.isAdmin)) return;
    $("#adminMsg").textContent = "読み込み中…";
    const { data, error } = await sb.rpc("admin_user_overview");
    if (error) { console.warn(error); $("#adminMsg").textContent = "読み込みに失敗しました。"; return; }
    state.adminRows = data || [];
    $("#adminMsg").textContent = "";
    renderAdmin();
    await loadTargets();
    await loadPacks();
  }

  /* ----- 質問セット・音声ファイル・招待コードの管理(責任者) ----- */
  const PACK_BUCKET = "pack-audio";
  const PACK_ERR = { duplicate_code: "このコードはすでにあります。別のコードにしてください。", bad_code: "コードは、英数字・ハイフン・アンダーバーの4〜64文字にしてください。", forbidden: "責任者だけが操作できます。" };
  const packMsg = (t) => { $("#packMsg").textContent = t; };
  const rpcErr = (e) => PACK_ERR[(e.message || "").replace(/^.*?(duplicate_code|bad_code|forbidden).*$/, "$1")] || "操作に失敗しました。(Supabaseで step8 のSQLを実行済みか確認してください)";

  async function loadPacks() {
    if (!(sb && state.isAdmin) || !$("#packSel")) return;
    const { data, error } = await sb.rpc("admin_list_packs");
    if (error) { console.warn(error); packMsg("質問セットの読み込みに失敗しました。(Supabaseで step8 のSQLを実行済みか確認してください)"); return; }
    state.adminPacks = data || [];
    const sel = $("#packSel"), keep = sel.value;
    sel.innerHTML = state.adminPacks.length
      ? state.adminPacks.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}(${p.question_count}問)</option>`).join("")
      : `<option value="">まだ質問セットがありません</option>`;
    if (keep && state.adminPacks.some((p) => p.id === keep)) sel.value = keep;
    await loadPackBody();
  }

  async function loadPackBody() {
    const id = $("#packSel").value;
    $("#packBody").hidden = !id;
    if (!id) return;
    const { data, error } = await sb.rpc("admin_list_pack_questions", { p_pack: id });
    if (error) { console.warn(error); packMsg("質問の読み込みに失敗しました。"); return; }
    state.packQs = data || [];
    renderPackBody();
  }

  function renderPackBody() {
    const id = $("#packSel").value;
    // 招待コード
    const codes = state.adminCodes.filter((c) => c.pack_id === id);
    $("#packCodes").innerHTML = codes.length ? codes.map((c) => `
      <li><p class="aemail"><code>${esc(c.code)}</code>${c.active ? "" : "(停止中)"}</p>
        <dl class="adl"><dt>使用</dt><dd>${c.used}人${c.max_uses ? ` / 上限${c.max_uses}人` : "(上限なし)"}</dd>
        <dt>期限</dt><dd>${c.expires_at ? fmtDate(c.expires_at) : "なし"}</dd></dl>
        <button type="button" class="ghost" data-code-toggle="${esc(c.id)}" data-active="${c.active ? "1" : "0"}">${c.active ? "このコードを停止する" : "このコードを再開する"}</button></li>`).join("")
      : `<li class="empty">このセットの招待コードは、まだありません。</li>`;

    // 質問(親子の順に並べる)
    const qs = state.packQs, byParent = new Map();
    qs.forEach((q) => { const k = q.parent_pack_id || ""; (byParent.get(k) || byParent.set(k, []).get(k)).push(q); });
    const defTitle = new Map(defaults().map((d) => [d.id, d.title]));
    const rows = [];
    const walk = (pid, depth) => (byParent.get(pid) || []).forEach((q) => { rows.push({ q, depth }); walk(q.id, depth + 1); });
    walk("", 0);
    $("#packQs").innerHTML = rows.length ? rows.map(({ q, depth }) => `
      <li style="margin-left:${Math.min(depth, 4) * 12}px">
        <p class="aemail">${esc(q.title)}${q.audio_path ? '<span class="badge-ok">音声あり</span>' : '<span class="badge-tts">自動音声</span>'}</p>
        ${q.parent_default_id ? `<p class="tgt-status">標準の質問「${esc(defTitle.get(q.parent_default_id) || q.parent_default_id)}」の深掘り</p>` : ""}
        <button type="button" class="ghost del" data-pq-del="${esc(q.id)}">削除</button></li>`).join("")
      : `<li class="empty">このセットには、まだ質問がありません。</li>`;

    // 深掘りの元(親)の選択肢
    $("#pqParent").innerHTML = `<option value="">なし(最初に出る質問)</option>` +
      (rows.length ? `<optgroup label="このセットの質問">${rows.map(({ q, depth }) => `<option value="p:${esc(q.id)}">${"　".repeat(depth)}${esc(q.title)}</option>`).join("")}</optgroup>` : "") +
      `<optgroup label="標準の質問">${defaults().map((d) => `<option value="d:${esc(d.id)}">${esc(d.title)}</option>`).join("")}</optgroup>`;
  }

  const randomCode = () => {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    const s = [...buf].map((b) => chars[b % chars.length]).join("");
    return s.slice(0, 4) + "-" + s.slice(4);
  };

  function bindPackUI() {
    $("#packSel").onchange = loadPackBody;
    $("#packCreateBtn").onclick = async () => {
      const name = $("#packName").value.trim();
      if (!name) { packMsg("セットの名前を入力してください。"); return; }
      const { data, error } = await sb.rpc("admin_create_pack", { p_name: name, p_description: $("#packDesc").value.trim() });
      if (error) { console.warn(error); packMsg(rpcErr(error)); return; }
      $("#packName").value = ""; $("#packDesc").value = "";
      packMsg(`「${name}」を作りました。質問と招待コードを追加してください。`);
      await loadPacks();
      $("#packSel").value = data; await loadPackBody();
    };

    $("#codeGen").onclick = () => { $("#codeText").value = randomCode(); };
    $("#codeForm").onsubmit = async (e) => {
      e.preventDefault();
      const max = $("#codeMax").value ? parseInt($("#codeMax").value, 10) : null;
      const exp = $("#codeExp").value ? new Date($("#codeExp").value + "T23:59:59+09:00").toISOString() : null;
      const { error } = await sb.rpc("admin_create_code", { p_pack: $("#packSel").value, p_code: $("#codeText").value.trim(), p_max_uses: max, p_expires: exp });
      if (error) { console.warn(error); packMsg(rpcErr(error)); return; }
      packMsg(`招待コード「${$("#codeText").value.trim()}」を発行しました。`);
      $("#codeForm").reset();
      await loadTargets(); renderPackBody();
    };
    $("#packCodes").onclick = async (e) => {
      const b = e.target.closest("button[data-code-toggle]");
      if (!b) return;
      const { error } = await sb.rpc("admin_set_code_active", { p_id: b.dataset.codeToggle, p_active: b.dataset.active !== "1" });
      if (error) { packMsg(rpcErr(error)); return; }
      await loadTargets(); renderPackBody();
    };

    $("#pqForm").onsubmit = async (e) => {
      e.preventDefault();
      const pack = $("#packSel").value, title = $("#pqTitle").value.trim();
      if (!pack || !title) return;
      const file = $("#pqFile").files[0];
      let path = null;
      if (file) {
        const ext = (file.name.split(".").pop() || "").toLowerCase();
        if (!MIME_BY_EXT[ext]) { packMsg("音声ファイルは mp3 / m4a / wav / ogg / aac / webm にしてください。"); return; }
        if (file.size > MAX_FILE) { packMsg("ファイルが大きすぎます(10MBまで)。"); return; }
        const uid = crypto.randomUUID ? crypto.randomUUID() : Date.now() + "-" + Math.random().toString(36).slice(2);
        path = `${pack}/${uid}.${ext}`;
      }
      const pv = $("#pqParent").value;
      const maxSort = state.packQs.reduce((m, q) => Math.max(m, q.sort_order), 0);
      const btn = $("#pqBtn"); btn.disabled = true; packMsg("追加しています…");
      try {
        if (file) {
          const up = await sb.storage.from(PACK_BUCKET).upload(path, file, { contentType: MIME_BY_EXT[path.split(".").pop()], upsert: false });
          if (up.error) { console.warn(up.error); packMsg("音声のアップロードに失敗しました。"); return; }
        }
        const { error } = await sb.rpc("admin_add_pack_question", {
          p_pack: pack, p_title: title, p_audio_path: path,
          p_parent_pack: pv.startsWith("p:") ? pv.slice(2) : null,
          p_parent_default: pv.startsWith("d:") ? pv.slice(2) : null,
          p_sort: maxSort + 10
        });
        if (error) {
          console.warn(error);
          if (path) await sb.storage.from(PACK_BUCKET).remove([path]);   // 登録に失敗したら、アップロードした音声も消す
          packMsg(rpcErr(error)); return;
        }
        $("#pqForm").reset();
        packMsg(`「${title}」を追加しました。${file ? "" : "(音声なし: 自動音声で読み上げられます)"}コードを使用済みの人には、次のログイン時に届きます。`);
        await loadPacks();
      } finally { btn.disabled = false; }
    };

    $("#packQs").onclick = async (e) => {
      const b = e.target.closest("button[data-pq-del]");
      if (!b) return;
      if (!confirm("この質問(と、その深掘り質問)を、セットから削除します。すでに届いた人の「自分の質問」からも消えます。よろしいですか?")) return;
      const { data, error } = await sb.rpc("admin_delete_pack_question", { p_id: b.dataset.pqDel });
      if (error) { console.warn(error); packMsg(rpcErr(error)); return; }
      if (data && data.length) await sb.storage.from(PACK_BUCKET).remove(data);
      packMsg("削除しました。");
      await loadPacks();
    };
  }

  /* ----- 招待コードの送り先(責任者) ----- */
  async function loadTargets() {
    if (!(sb && state.isAdmin)) return;
    const [c, t] = await Promise.all([sb.rpc("admin_list_codes"), sb.rpc("admin_list_targets")]);
    if (c.error || t.error) {
      console.warn(c.error || t.error);
      $("#tgtMsg").textContent = "送り先の読み込みに失敗しました。(Supabaseで step7 のSQLを実行済みか確認してください)";
      return;
    }
    state.adminCodes = c.data || [];
    state.adminTargets = t.data || [];
    const sel = $("#tgtCode"), keep = sel.value;
    sel.innerHTML = state.adminCodes.length
      ? state.adminCodes.map((x) => `<option value="${esc(x.id)}">${esc(x.code)} — ${esc(x.pack_name)}${x.active ? "" : "(停止中)"}</option>`).join("")
      : `<option value="">招待コードがありません(先にSQLで作成してください)</option>`;
    if (keep) sel.value = keep;
    renderTargets();
  }

  function renderTargets() {
    $("#tgtList").innerHTML = state.adminTargets.length ? state.adminTargets.map((t) => {
      const status = !t.matched_at ? "未登録(一致するアカウントなし)"
        : t.redeemed ? `使用済み(${esc(t.matched_email || "")})`
        : t.seen_at ? `通知を確認済み(${esc(t.matched_email || "")}・${fmtDate(t.matched_at)})`
        : `一致して通知中(${esc(t.matched_email || "")}・${fmtDate(t.matched_at)})`;
      return `<li>
        <p class="aemail">${esc(t.family_kanji)} ${esc(t.given_kanji)}<small class="sub">${esc(t.family_kana)} ${esc(t.given_kana)}</small></p>
        <dl class="adl"><dt>招待コード</dt><dd>${esc(t.code)}(${esc(t.pack_name)})</dd>
        <dt>状態</dt><dd class="tgt-status">${status}</dd></dl>
        <button type="button" class="ghost del" data-tgt="${esc(t.id)}">この送り先を削除</button></li>`;
    }).join("") : `<li class="empty">まだ送り先がありません。</li>`;
  }

  async function addTargets(rows) {
    const code_id = $("#tgtCode").value;
    if (!code_id) { $("#tgtMsg").textContent = "送る招待コードを選んでください。"; return false; }
    const { data, error } = await sb.rpc("admin_add_targets", { p_rows: rows.map((r) => ({ ...r, code_id })) });
    if (error) { console.warn(error); $("#tgtMsg").textContent = "追加に失敗しました。"; return false; }
    const skipped = rows.length - data;
    $("#tgtMsg").textContent = `${data}件を追加しました。${skipped ? `(同じ氏名・同じコードの${skipped}件は、すでにあるため追加しませんでした)` : ""}`;
    await loadTargets();
    return true;
  }

  function bindTargetUI() {
    $("#tgtForm").onsubmit = async (e) => {
      e.preventDefault();
      const nm = parseName($("#tgtFamKanji").value, $("#tgtGivKanji").value, $("#tgtFamKana").value, $("#tgtGivKana").value);
      if (nm.error) { $("#tgtMsg").textContent = nm.error; return; }
      if (await addTargets([nm.data])) $("#tgtForm").querySelectorAll(".namegrid input").forEach((i) => (i.value = ""));
    };
    $("#tgtCsvBtn").onclick = async () => {
      const lines = $("#tgtCsv").value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      const rows = [], errs = [];
      lines.forEach((l, i) => {
        const p = l.split(/[,、\t]/);
        const nm = p.length === 4 ? parseName(...p) : { error: "「姓,名,セイ,メイ」の4項目にしてください。" };
        if (nm.error) errs.push(`${i + 1}行目: ${nm.error}`); else rows.push(nm.data);
      });
      if (errs.length) { $("#tgtMsg").textContent = errs.slice(0, 3).join(" / ") + (errs.length > 3 ? ` ほか${errs.length - 3}件` : "") + " — 修正してもう一度押してください。"; return; }
      if (!rows.length) { $("#tgtMsg").textContent = "追加する行がありません。"; return; }
      if (await addTargets(rows)) $("#tgtCsv").value = "";
    };
    $("#tgtList").onclick = async (e) => {
      const b = e.target.closest("button[data-tgt]");
      if (!b || !confirm("この送り先を削除します。よろしいですか?(すでに通知済みの人の表示も消えます)")) return;
      const { error } = await sb.rpc("admin_delete_target", { p_id: b.dataset.tgt });
      $("#tgtMsg").textContent = error ? "削除に失敗しました。" : "削除しました。";
      await loadTargets();
    };
  }

  function renderAdmin() {
    const rows = state.adminRows;
    const now = Date.now(), week = 7 * 86400 * 1000;
    const within = (iso) => iso && now - new Date(iso).getTime() < week;
    $("#adminSummary").innerHTML = [
      ["登録アカウント", rows.length],
      ["7日以内にログイン", rows.filter((r) => within(r.last_login_at)).length],
      ["7日以内に練習", rows.filter((r) => within(r.last_answer_at)).length],
      ["回答の合計回数", rows.reduce((sum, r) => sum + Number(r.answer_count), 0)]
    ].map(([k, v]) => `<div class="stat"><b>${v}</b><span>${k}</span></div>`).join("");

    const q = $("#adminSearch").value.trim().toLowerCase();
    const list = rows.filter((r) => !q || (r.account_email || "").toLowerCase().includes(q)
      || (r.full_name || "").includes(q) || (r.full_name_kana || "").includes(q));
    $("#adminList").innerHTML = list.length ? list.map((r) => `
      <li>
        <p class="aemail">${esc(r.account_email || "(メールなし)")}</p>
        <dl class="adl">
          <dt>お名前</dt><dd>${r.full_name ? `${esc(r.full_name)}(${esc(r.full_name_kana || "")})` : "未登録"}</dd>
          <dt>登録日</dt><dd>${fmtDate(r.joined_at)}</dd>
          <dt>最終ログイン</dt><dd>${fmtDate(r.last_login_at, true)}</dd>
          <dt>規約への同意</dt><dd>${r.terms_version ? `済(版 ${esc(r.terms_version)})` : "未同意"}</dd>
          <dt>回答回数</dt><dd>${r.answer_count}回${r.avg_seconds != null ? `(平均 ${fmt(Number(r.avg_seconds))})` : ""}</dd>
          <dt>最後の練習</dt><dd>${fmtDate(r.last_answer_at, true)}</dd>
          <dt>自分の質問</dt><dd>${r.own_questions}件</dd>
          <dt>招待コード</dt><dd>${r.packs_used ? esc(r.packs_used) : "なし"}</dd>
        </dl>
      </li>`).join("") : `<li class="empty">該当するアカウントがありません。</li>`;
  }

  /* ========== 氏名(漢字 + カタカナ) ========== */
  const normText = (s) => String(s || "").normalize("NFKC").replace(/\s+/g, "");
  const toKatakana = (s) => normText(s).replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  const KANJI_OK = /^[\u3400-\u9FFF\uF900-\uFAFF々〆ヶぁ-んァ-ヶー]{1,20}$/;
  const KANA_OK = /^[ァ-ヶー]{1,30}$/;
  // 4つの入力を検査して、保存する形に整える。問題があれば error を返す
  function parseName(fk, gk, fkana, gkana) {
    const d = { family_kanji: normText(fk), given_kanji: normText(gk), family_kana: toKatakana(fkana), given_kana: toKatakana(gkana) };
    if (!d.family_kanji || !d.given_kanji) return { error: "姓と名を、漢字で入力してください。" };
    if (!KANJI_OK.test(d.family_kanji) || !KANJI_OK.test(d.given_kanji)) return { error: "姓・名は、漢字(20文字以内)で入力してください。" };
    if (!d.family_kana || !d.given_kana) return { error: "セイとメイを、カタカナで入力してください。" };
    if (!KANA_OK.test(d.family_kana) || !KANA_OK.test(d.given_kana)) return { error: "セイ・メイは、カタカナで入力してください。" };
    return { data: d };
  }

  /* ========== 氏名が一致した人への、招待コードの通知 ========== */
  async function loadNotices() {
    state.notices = [];
    if (state.user && sb) {
      try {
        await sb.rpc("claim_name_invites");   // 氏名が送り先と一致していれば、ここでひもづく(ログインのたびに確認)
        const { data, error } = await sb.rpc("my_invite_notices");
        if (error) console.warn(error); else state.notices = data || [];
      } catch (e) { console.warn(e); }
    }
    renderNotices();
  }

  function renderNotices() {
    const unseen = state.notices.filter((n) => !n.seen_at);
    const box = $("#inviteNotice");
    if (!box || !$("#sentBox")) return;     // index.html が古い場合でも止まらないように
    box.hidden = !unseen.length;
    box.innerHTML = unseen.map((n) => `
      <p>招待コードが届きました:「${esc(n.pack_name)}」</p>
      <div class="row"><code>${esc(n.code)}</code>
        <button type="button" class="primary" data-act="use" data-code="${esc(n.code)}">設定で使う</button>
        <button type="button" class="ghost" data-act="later">あとで</button></div>`).join("");
    $("#sentBox").hidden = !state.notices.length;
    $("#sentCodes").innerHTML = state.notices.map((n) => `
      <li><span class="t">「${esc(n.pack_name)}」</span><code>${esc(n.code)}</code>
        <button type="button" class="ghost" data-act="use" data-code="${esc(n.code)}">入力欄に入れる</button></li>`).join("");
  }

  async function markNoticesSeen() {
    state.notices.forEach((n) => { n.seen_at = n.seen_at || new Date().toISOString(); });
    renderNotices();
    if (sb) { try { await sb.rpc("mark_invite_notices_seen"); } catch (e) { console.warn(e); } }
  }

  function onNoticeClick(e) {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    if (btn.dataset.act === "use") {
      switchTab("account");
      $("#inviteCode").value = btn.dataset.code;
      $("#inviteCode").scrollIntoView({ block: "center" });
      $("#inviteCode").focus();
    }
    markNoticesSeen();
  }

  /* ========== ログイン(Supabase) ========== */
  function authError(err) {
    const m = err.message || "";
    if (m.includes("Invalid login credentials")) return "メールアドレスまたはパスワードが違います。";
    if (m.includes("already registered")) return "このメールアドレスは登録済みです。ログインしてください。";
    if (m.includes("Email not confirmed")) return "確認メールのリンクを開いてから、ログインしてください。";
    if (m.includes("at least 6")) return "パスワードは6文字以上にしてください。";
    if (m.toLowerCase().includes("rate limit")) return "短時間に試行しすぎです。少し待ってからやり直してください。";
    if (m.includes("different from the old")) return "現在と同じパスワードは使えません。";
    if (/weak|pwned|easy to guess/i.test(m)) return "このパスワードは推測されやすいため使えません。別のものにしてください。";
    return `エラー: ${m}`;
  }

  const hasAgreed = (u) => u?.user_metadata?.terms_version === TERMS_VERSION;

  // ログイン状態に応じて画面を切り替える(ログイン+規約同意済みの時だけ、アプリ本体を開ける)
  function renderAccount() {
    const ready = !sb || state.authReady;
    const agreed = !!state.user && hasAgreed(state.user);
    const locked = !agreed;

    $("#accountLoading").hidden = ready;
    $("#accountSetup").hidden = !!sb;
    $("#accountOut").hidden = !ready || !sb || !!state.user;
    $("#accountConsent").hidden = !ready || !state.user || agreed;
    $("#accountIn").hidden = !ready || !agreed;
    document.querySelector('.tab[data-tab="admin"]').hidden = !(agreed && state.isAdmin);

    if (agreed) {
      $("#accountEmail").textContent = state.user.email;
      const m = state.user.user_metadata || {};
      if ($("#accountName")) $("#accountName").textContent = m.family_kanji
        ? `${m.family_kanji} ${m.given_kanji}(${m.family_kana} ${m.given_kana})` : "未登録";
      $("#accountCreated").textContent = fmtDate(state.user.created_at);
      const md = state.user.user_metadata || {};
      $("#accountTerms").textContent = md.terms_accepted_at
        ? `${fmtDate(md.terms_accepted_at)} に同意(版 ${md.terms_version})` : "同意済み";
      const n = state.local.length;
      $("#migrateBtn").hidden = n === 0;
      $("#migrateBtn").textContent = `この端末の記録 ${n}件をアカウントに移す`;
    }

    const wasLocked = document.body.classList.contains("locked");
    document.body.classList.toggle("locked", locked);
    if (locked) {
      // ログアウト時などは、再生・計測を止めて初期状態に戻す
      stopAudio(); resetTimer();
      discardRecording();
      clearAnswerData();
      state.current = null;
      setPhase("idle");
      switchTab("account");
    } else if (wasLocked) {
      switchTab("practice");
    }
  }

  // 表示する記録を、ログイン状態に合わせて読み込み直す
  // 使用済みの招待コードのセットに、あとから追加された質問を受け取る
  async function syncPacks() {
    if (!(state.user && sb)) return;
    try {
      const { data, error } = await sb.rpc("sync_my_packs");
      if (error) { console.warn(error); return; }
      if (data?.added) notify(`招待コードのセットに追加された質問${data.added}件を、「自分の質問」に追加しました`);
      else if (data?.pending) notify(`質問の上限(${MAX_QUESTIONS}件)のため、追加された質問${data.pending}件を受け取れていません。不要な質問を削除してください`);
    } catch (e) { console.warn(e); }
  }

  async function refreshHistory() {
    await syncPacks();
    await refreshQuestions();
    await loadScripts();
    await Promise.all([refreshAdmin(), loadRedemptions()]);
    await loadNotices();
    if (state.user && sb) {
      const { data, error } = await sb.from("answers")
        .select("question_id,title,seconds,created_at")
        .order("created_at", { ascending: true })
        .limit(1000);
      if (error) { console.warn(error); notify("記録の読み込みに失敗しました"); state.history = []; }
      else state.history = data.map((r) => ({ ...r, seconds: Number(r.seconds) }));
    } else {
      state.history = state.local;
    }
    renderHistory();
    renderAccount();
  }

  async function initAuth() {
    renderAccount();
    if (!sb) return;
    try {
      const { data } = await sb.auth.getSession();
      state.user = data.session?.user ?? null;
    } catch (e) {
      console.warn(e);
    }
    state.authReady = true;
    sb.auth.onAuthStateChange((_event, session) => {
      const u = session?.user ?? null;
      const sameUser = (u?.id ?? null) === (state.user?.id ?? null);
      state.user = u;
      // コールバック内で直接 Supabase を呼ばない
      setTimeout(sameUser ? renderAccount : refreshHistory, 0);
    });
    await refreshHistory();
  }

  function bindAuthUI() {
    const msg = (t) => { $("#authMsg").textContent = t; };
    const creds = () => ({ email: $("#email").value.trim(), password: $("#password").value });

    $("#authForm").onsubmit = async (e) => {
      e.preventDefault();
      if (!sb) return;
      msg("ログインしています…");
      const { error } = await sb.auth.signInWithPassword(creds());
      msg(error ? authError(error) : "ログインしました。");
      if (!error) $("#password").value = "";
    };

    $("#signupBtn").onclick = async () => {
      if (!sb) return;
      const { email, password } = creds();
      if (!$("#agree").checked) { msg("新規登録には、利用規約への同意が必要です。"); return; }
      if (!email || password.length < 6) { msg("メールアドレスと、6文字以上のパスワードを入力してください。"); return; }
      const nm = parseName($("#famKanji").value, $("#givKanji").value, $("#famKana").value, $("#givKana").value);
      if (nm.error) { msg(nm.error); return; }
      msg("登録しています…");
      const { data, error } = await sb.auth.signUp({
        email, password,
        options: {
          emailRedirectTo: location.origin + location.pathname,
          data: { ...nm.data, terms_version: TERMS_VERSION, terms_accepted_at: new Date().toISOString() }
        }
      });
      if (error) msg(authError(error));
      else if (data.session) msg("登録しました。ログインしています。");
      else msg("確認メールを送信しました。メール内のリンクを開いてから、ログインしてください。");
    };

    $("#agree").onchange = (e) => { $("#signupBtn").disabled = !e.target.checked; };

    // 規約に未同意のユーザー(規約追加前に登録した人・規約改定後)の同意画面
    $("#consentAgree").onchange = (e) => { $("#consentBtn").disabled = !e.target.checked; };
    $("#consentBtn").onclick = async () => {
      if (!sb || !$("#consentAgree").checked) return;
      const { data, error } = await sb.auth.updateUser({
        data: { terms_version: TERMS_VERSION, terms_accepted_at: new Date().toISOString() }
      });
      if (error) { msg("同意の記録に失敗しました。通信状況を確認してください。"); return; }
      state.user = data.user;
      msg("利用規約への同意を記録しました。");
      await refreshHistory();
    };
    $("#consentLogout").onclick = async () => { await sb.auth.signOut(); };

    // パスワード変更(現在のパスワードで本人確認してから変更する)
    $("#pwForm").onsubmit = async (e) => {
      e.preventDefault();
      const pm = (t) => { $("#pwMsg").textContent = t; };
      if (!sb || !state.user) return;
      const cur = $("#pwCur").value, n1 = $("#pwNew").value, n2 = $("#pwNew2").value;
      if (n1.length < 6) return pm("新しいパスワードは6文字以上にしてください。");
      if (n1 !== n2) return pm("新しいパスワード(確認)が一致しません。");
      if (n1 === cur) return pm("現在と同じパスワードは使えません。");
      const btn = $("#pwBtn");
      btn.disabled = true;
      try {
        pm("確認しています…");
        const chk = await sb.auth.signInWithPassword({ email: state.user.email, password: cur });
        if (chk.error) return pm("現在のパスワードが違います。");
        const { error } = await sb.auth.updateUser({ password: n1 });
        if (error) return pm(authError(error));
        $("#pwForm").reset();
        pm("パスワードを変更しました。");
      } finally {
        btn.disabled = false;
      }
    };

    // 招待コードの使用
    const INVITE_ERR = {
      invalid_code: "招待コードが正しくないか、無効になっています。",
      already_redeemed: "このコードは、このアカウントですでに使用済みです。",
      code_exhausted: "このコードは、利用できる人数の上限に達しました。",
      empty_pack: "このコードには、まだ質問が登録されていません。",
      too_many_attempts: "失敗が続いたため、しばらく入力できません。10分ほど待ってからやり直してください。",
      not_authenticated: "ログインし直してください。"
    };
    if ($("#inviteNotice")) $("#inviteNotice").onclick = onNoticeClick;
    if ($("#sentCodes")) $("#sentCodes").onclick = onNoticeClick;
    $("#inviteForm").onsubmit = async (e) => {
      e.preventDefault();
      const im = (t) => { $("#inviteMsg").textContent = t; };
      if (!sb || !state.user) return;
      const code = $("#inviteCode").value.trim();
      if (!code) return im("招待コードを入力してください。");
      if (!confirm("この招待コードを使用します。\n同じコードは、このアカウントでは二度と使えません。よろしいですか?")) return;
      const btn = $("#inviteBtn");
      btn.disabled = true;
      im("確認しています…");
      try {
        const { data, error } = await sb.rpc("redeem_invite_code", { p_code: code });
        if (error) {
          console.warn(error);
          return im("通信に失敗しました。(Supabaseで step6 のSQLを実行済みか確認してください)");
        }
        if (!data?.ok) {
          if (data?.error === "limit") {
            return im(`質問の上限(${data.max}件)を超えるため取り込めません。このセットは${data.needed}件で、あと${data.remaining}件まで追加できます。不要な自作質問を削除してから、もう一度お試しください。`);
          }
          return im(INVITE_ERR[data?.error] || "招待コードを使用できませんでした。");
        }
        $("#inviteForm").reset();
        im(`「${data.pack_name}」の質問${data.count}件を追加しました。「質問一覧」の「自分の質問」から使えます。`);
        await refreshQuestions();
        await loadRedemptions();
        await loadNotices();     // 使ったコードは、届いているコードの一覧から消える
      } finally {
        btn.disabled = false;
      }
    };

    $("#logoutBtn").onclick = async () => {
      await sb.auth.signOut();
      msg("ログアウトしました。");
    };

    $("#migrateBtn").onclick = async () => {
      if (!sb || !state.user || !state.local.length) return;
      const rows = state.local.map((r) => ({
        question_id: r.question_id, title: r.title, seconds: r.seconds,
        mode: r.mode ?? null, created_at: r.created_at
      }));
      const { error } = await sb.from("answers").insert(rows);
      if (error) { msg("移行に失敗しました。通信状況を確認してください。"); return; }
      state.local = [];
      saveJSON(LS_HISTORY, []);
      msg(`${rows.length}件の記録をアカウントに移しました。`);
      await refreshHistory();
    };
  }

  /* ========== 初期化 ========== */
  function init() {
    $("#mode").value = state.settings.mode;
    $("#timerBase").value = state.settings.timerBase;
    $("#showTitle").checked = state.settings.showTitle;

    $("#mode").onchange = (e) => { state.settings.mode = e.target.value; saveJSON(LS_SETTINGS, state.settings); stopAudio(); resetTimer(); clearAnswerData(); state.current = null; setPhase("idle"); };
    if ($("#source")) {
      $("#source").onchange = (e) => {
        state.settings.source = e.target.value; saveJSON(LS_SETTINGS, state.settings);
        stopAudio(); resetTimer(); clearAnswerData(); state.current = null; setPhase("idle");
      };
    }
    $("#timerBase").onchange = (e) => { state.settings.timerBase = e.target.value; saveJSON(LS_SETTINGS, state.settings); };
    // index.html が古いままでも、画面全体が止まらないようにする
    if ($("#recordAnswers") && $("#recHint")) {
    $("#recordAnswers").checked = !!state.settings.recordAnswers;
    $("#recHint").hidden = !state.settings.recordAnswers;
    $("#recordAnswers").onchange = (e) => {
      let on = e.target.checked;
      if (on && !micSupported()) {
        on = false; e.target.checked = false;
        notify("この環境では録音できません。https のページ(公開後のURL)で開いてください");
      }
      state.settings.recordAnswers = on;
      saveJSON(LS_SETTINGS, state.settings);
      $("#recHint").hidden = !on;
      $("#sttModelWrap").hidden = !on;
      if (!on) { discardAnswerRec(); releaseMic(); } else { ans.denied = false; }
    };
    }
    if ($("#sttModel")) {
      $("#sttModel").value = state.settings.sttModel;
      $("#sttModelWrap").hidden = !state.settings.recordAnswers;
      $("#sttModel").onchange = (e) => { state.settings.sttModel = e.target.value; saveJSON(LS_SETTINGS, state.settings); stt.pipe = null; };
    }
    bindScriptUI();
    if ($("#review")) bindReviewUI();
    $("#showTitle").onchange = (e) => { state.settings.showTitle = e.target.checked; saveJSON(LS_SETTINGS, state.settings); setPhase(state.phase); };

    $("#nextBtn").onclick = () => {
      if (state.settings.mode === "pick" && (state.phase === "idle" || state.phase === "done")) return switchTab("list");
      onNext();
    };
    $("#replayBtn").onclick = () => { if (state.current) play(state.current); };

    document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));

    $("#view-list").onclick = (e) => {
      const del = e.target.closest("button.del");
      if (del) { deleteQuestion(del.dataset.del); return; }
      const scr = e.target.closest("button.scr");
      if (scr) { openScript(scr.dataset.scr); return; }
      const btn = e.target.closest("button.play");
      if (!btn) return;
      const q = getQuestions().find((x) => x.id === btn.dataset.id);
      if (!q) return;
      state.settings.mode = "pick";
      $("#mode").value = "pick";
      saveJSON(LS_SETTINGS, state.settings);
      switchTab("practice");
      play(q);
    };
    $("#addForm").onsubmit = addQuestion;
    $("#recStart").onclick = startRecording;
    $("#recStop").onclick = stopRecording;
    $("#recRedo").onclick = discardRecording;
    $("#qFile").onchange = () => { if ($("#qFile").files.length) discardRecording(); }; // ファイルを選んだら録音は破棄

    $("#clearHistory").onclick = async () => {
      const where = state.user ? "アカウントに保存された" : "この端末の";
      if (!confirm(`${where}回答時間の記録をすべて削除します。よろしいですか?`)) return;
      if (state.user && sb) {
        const { error } = await sb.from("answers").delete().eq("user_id", state.user.id);
        if (error) { notify("削除に失敗しました"); return; }
        state.history = [];
      } else {
        state.local = [];
        state.history = state.local;
        saveJSON(LS_HISTORY, []);
      }
      renderHistory();
    };

    bindAuthUI();
    $("#adminReload").onclick = loadAdmin;
    if ($("#tgtForm")) bindTargetUI();
    if ($("#packCard")) bindPackUI();
    $("#adminSearch").oninput = renderAdmin;
    renderList();
    renderParentOptions();
    setPhase("idle");
  }

  try { init(); } catch (e) { console.error("init failed", e); }   // 何かで失敗しても、ログイン処理は必ず動かす
  initAuth();
})();
