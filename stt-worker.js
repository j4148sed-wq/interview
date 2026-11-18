// 原稿との照合に使う、AIの文字起こし(この端末の中で動く)。
// 重い処理を、画面とは別のスレッドで行うため、処理中も画面が固まらない。
const LIBS = [
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1",
  "https://esm.sh/@huggingface/transformers@3.5.1"
];
let pipe = null, loadedModel = "";

async function importLib(say) {
  const errs = [];
  for (const u of LIBS) {
    const host = new URL(u).host;
    say(`AIの部品を読み込んでいます…(${host})`);
    try {
      return await Promise.race([
        import(u),
        new Promise((_, rej) => setTimeout(() => rej(new Error("25秒たっても応答がありません")), 25000))
      ]);
    } catch (e) { errs.push(`${host}: ${e.message || e}`); }
  }
  throw new Error("AIの部品を取得できませんでした(" + errs.join(" / ") + ")");
}

async function load(model, say) {
  if (pipe && loadedModel === model) return;
  const { pipeline, env } = await importLib(say);
  env.allowLocalModels = false;
  say("AIのモデルを準備しています…");
  const files = new Map();
  pipe = await pipeline("automatic-speech-recognition", model, {
    device: "wasm", dtype: "q8",
    progress_callback: (p) => {
      if (p.status === "progress" && p.file) {
        files.set(p.file, p);
        let l = 0, t = 0; files.forEach((f) => { l += f.loaded || 0; t += f.total || 0; });
        if (t) say(`AIのモデルをダウンロード中… ${(l / 1048576).toFixed(0)} / ${(t / 1048576).toFixed(0)} MB`);
      }
    }
  });
  loadedModel = model;
}

self.onmessage = async (e) => {
  const m = e.data, id = m.id;
  const say = (text) => self.postMessage({ id, type: "progress", text });
  try {
    if (m.type === "load") {
      await load(m.model, say);
      self.postMessage({ id, type: "done" });
    } else if (m.type === "run") {
      const out = await pipe(m.audio, { language: "japanese", task: "transcribe", chunk_length_s: 30, stride_length_s: 5, return_timestamps: true });
      self.postMessage({ id, type: "done", text: out.text || "", chunks: Array.isArray(out.chunks) ? out.chunks.map((c) => ({ text: c.text, timestamp: c.timestamp })) : [] });
    }
  } catch (err) {
    self.postMessage({ id, type: "error", message: (err && err.message) || String(err) });
  }
};
