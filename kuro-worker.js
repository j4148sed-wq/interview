// 読み(かな)を調べる辞書(kuromoji)。読み込みが重いため、画面とは別のスレッドで動かす。
// 通常のワーカー(importScripts を使う)として動く。
const KURO_JS = "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/build/kuromoji.js";
const KURO_DIC = "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/";
let tokenizer = null, initP = null;

function init() {
  if (initP) return initP;
  initP = new Promise((resolve, reject) => {
    try { importScripts(KURO_JS); } catch (e) { reject(e); return; }
    self.kuromoji.builder({ dicPath: KURO_DIC }).build((err, t) => { if (err) reject(err); else { tokenizer = t; resolve(); } });
  });
  return initP;
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    await init();
    if (type === "tokenize") {
      const out = e.data.texts.map((t) => tokenizer.tokenize(String(t)).map((x) => ({ surface: x.surface_form, pron: x.pronunciation, reading: x.reading })));
      self.postMessage({ id, type: "done", out });
    } else {
      self.postMessage({ id, type: "done" });
    }
  } catch (err) {
    self.postMessage({ id, type: "error", message: String((err && err.message) || err) });
  }
};
