(() => {
  "use strict";

  /* ========== 設定・保存 ========== */
  const LS_HISTORY = "si_history_v1";
  const LS_SETTINGS = "si_settings_v1";
  // 利用規約を改定したら、この日付を変える(terms.html の制定日と合わせる)。
  // 変えると、既存ユーザーにも次回ログイン時に再同意が求められます。
  const TERMS_VERSION = "2026-11-17.2";
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
    settings: { mode: "random", timerBase: "end", showTitle: true, ...loadJSON(LS_SETTINGS, {}) },
    local: loadJSON(LS_HISTORY, []),   // この端末に保存した記録
    history: [],                       // 画面に表示する記録(ログイン中=アカウント / 未ログイン=端末)
    user: null,
    authReady: false,                  // ログイン状態の確認が終わったか
    userQuestions: [],                 // 自分で追加した質問
    isAdmin: false,                    // 責任者か
    redemptions: [],                   // 使用済みの招待コード
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
      // 2) 深掘りが終わったらトップ階層からランダム(全部出したらリセット)
      let pool = childrenOf(null).filter((t) => !state.askedTop.has(t.id));
      if (!pool.length) { state.askedTop.clear(); pool = childrenOf(null); }
      q = pool[Math.floor(Math.random() * pool.length)];
      state.askedTop.add(q.id);
    }
    // 3) この質問に子がいれば、次はその子たちから出す
    const kids = childrenOf(q.id);
    if (kids.length) state.stack.push([...kids]);
    return q;
  }

  function nextQuestion() {
    if (state.settings.mode === "random") return pickRandom();
    if (state.settings.mode === "sequential") return state.order[state.seqIndex++] ?? null;
    return null; // pick モードは一覧から選ぶ
  }

  function resetSession() {
    state.stack = [];
    state.askedTop.clear();
    state.order = flatten();
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
    audio.pause();
    if ("speechSynthesis" in window) speechSynthesis.cancel();
  }

  // MP3 が無い/再生できない時の代替(質問文の読み上げ)
  function speak(text, done) {
    if (!("speechSynthesis" in window)) { setTimeout(done, 1500); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP";
    u.onend = done;
    u.onerror = done;
    speechSynthesis.speak(u);
  }

  function play(q) {
    stopAudio();
    const token = state.token;
    let fellBack = false;
    state.current = q;
    setPhase("playing");

    const finish = () => {
      if (token !== state.token) return;
      setPhase("answering");
      if (state.settings.timerBase === "end") startTimer();
    };
    const fallback = () => {
      if (fellBack || token !== state.token) return;
      fellBack = true;
      speak(q.title, finish);
    };

    resetTimer();
    if (state.settings.timerBase === "start") startTimer();

    if (!state.unlocked) {
      state.unlocked = true;
      audio.src = SILENT_WAV;
      audio.play().catch(() => {});
    }

    resolveAudioUrl(q).then((url) => {
      if (token !== state.token) return;
      if (!url) { fallback(); return; }
      audio.onended = finish;
      audio.onerror = fallback;
      audio.src = url;
      audio.play().catch(fallback);
    });
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

    title.textContent = q && state.settings.showTitle && phase !== "done" ? q.title : "";
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
      stopAudio(); resetTimer();
      state.current = null;
      setPhase("done");
      return;
    }
    play(q);
  }

  function onNext() {
    if (state.phase === "idle" || state.phase === "done") {
      resetSession();
      advance();
      return;
    }
    if (state.phase === "playing") {      // 質問の再生中 → 記録せずスキップ
      advance();
      return;
    }
    if (state.phase === "answering") {    // 回答終了 → 時間を止めて記録(自動では進まない)
      const sec = stopTimer();
      if (sec !== null && state.current) {
        saveAnswer(state.current, sec);
        $("#timer").textContent = fmt(sec);
      }
      setPhase("answered");
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
        .select("id,user_id,title,audio_path,audio_bucket,parent_id,created_at")
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
          audio_bucket: r.audio_bucket, imported: r.audio_bucket === "pack-audio",
          parent_id: r.parent_id && known.has(r.parent_id) ? r.parent_id : null, // 親が見つからなければトップ階層に
          sort_order: 1000 + i, owner_id: r.user_id
        }));
      }
    }
    renderList();
    renderParentOptions();
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
    if (paths.length) {   // 招待コード由来の質問は、共有の音声なので Storage からは消さない
      const rm = await sb.storage.from(BUCKET).remove(paths);
      if (rm.error) console.warn(rm.error);
    }
    listMsg("削除しました。");
    await refreshQuestions();
  }

  /* ========== 記録 ========== */
  function renderHistory() {
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

  async function loadRedemptions() {
    if (!(state.user && sb)) { state.redemptions = []; renderRedemptions(); return; }
    const { data, error } = await sb.from("invite_redemptions")
      .select("pack_name,question_count,created_at").order("created_at", { ascending: false });
    if (error) console.warn(error);
    state.redemptions = error ? [] : data;
    renderRedemptions();
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
    const list = rows.filter((r) => !q || (r.account_email || "").toLowerCase().includes(q));
    $("#adminList").innerHTML = list.length ? list.map((r) => `
      <li>
        <p class="aemail">${esc(r.account_email || "(メールなし)")}</p>
        <dl class="adl">
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
      state.current = null;
      setPhase("idle");
      switchTab("account");
    } else if (wasLocked) {
      switchTab("practice");
    }
  }

  // 表示する記録を、ログイン状態に合わせて読み込み直す
  async function refreshHistory() {
    await refreshQuestions();
    await Promise.all([refreshAdmin(), loadRedemptions()]);
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
      msg("登録しています…");
      const { data, error } = await sb.auth.signUp({
        email, password,
        options: {
          emailRedirectTo: location.origin + location.pathname,
          data: { terms_version: TERMS_VERSION, terms_accepted_at: new Date().toISOString() }
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

    $("#mode").onchange = (e) => { state.settings.mode = e.target.value; saveJSON(LS_SETTINGS, state.settings); stopAudio(); resetTimer(); state.current = null; setPhase("idle"); };
    $("#timerBase").onchange = (e) => { state.settings.timerBase = e.target.value; saveJSON(LS_SETTINGS, state.settings); };
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
    $("#adminSearch").oninput = renderAdmin;
    renderList();
    renderParentOptions();
    setPhase("idle");
  }

  init();
  initAuth();
})();
