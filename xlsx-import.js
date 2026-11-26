/* Excel(.xlsx)の問答集から、質問と原稿を取り出す。
 * ファイルは、この端末の中だけで読み取ります(外部のサービスには送りません)。
 * 外部ライブラリは使わず、ブラウザ標準の DecompressionStream で .xlsx(zip)を開きます。 */
(function () {
  "use strict";

  async function inflateRaw(u8) {
    const ds = new DecompressionStream("deflate-raw");
    const w = ds.writable.getWriter(); w.write(u8); w.close();
    return new Uint8Array(await new Response(ds.readable).arrayBuffer());
  }

  // zip を開き、「ファイル名 → 文字列」を返す関数を返す
  async function openZip(buf) {
    if (typeof DecompressionStream === "undefined") throw new Error("unsupported");
    const u8 = new Uint8Array(buf), dv = new DataView(buf);
    let e = u8.length - 22;
    while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error("notzip");
    const n = dv.getUint16(e + 10, true);
    let p = dv.getUint32(e + 16, true);
    const files = new Map();
    for (let i = 0; i < n; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("notzip");
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      files.set(new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen)), { method, csize, lho });
      p += 46 + nlen + elen + clen;
    }
    return async (name) => {
      const f = files.get(name); if (!f) return null;
      const start = f.lho + 30 + dv.getUint16(f.lho + 26, true) + dv.getUint16(f.lho + 28, true);
      const data = u8.subarray(start, start + f.csize);
      return new TextDecoder().decode(f.method === 0 ? data : await inflateRaw(data));
    };
  }

  const xml = (s) => new DOMParser().parseFromString(s, "application/xml");
  const kids = (el, tag) => [...el.children].filter((c) => c.localName === tag);
  const textOfT = (el) => {            // <t> と <r><t> を連結(ふりがな <rPh> は除く)
    let s = "";
    for (const c of el.children) {
      if (c.localName === "t") s += c.textContent;
      else if (c.localName === "r") kids(c, "t").forEach((t) => { s += t.textContent; });
    }
    return s;
  };

  // 戻り値: [{ name, cells: Map("B5" -> { v, f }) }]  (v=表示される値, f=数式の文字列。数式でなければ null)
  async function readXlsx(buf) {
    const get = await openZip(buf);
    const wbXml = await get("xl/workbook.xml");
    if (!wbXml) throw new Error("notxlsx");
    const rels = xml((await get("xl/_rels/workbook.xml.rels")) || "<r/>");
    const target = {};
    [...rels.getElementsByTagName("Relationship")].forEach((r) => { target[r.getAttribute("Id")] = r.getAttribute("Target"); });
    const sst = [];
    const sx = await get("xl/sharedStrings.xml");
    if (sx) [...xml(sx).getElementsByTagName("si")].forEach((si) => sst.push(textOfT(si)));
    const sheets = [];
    for (const sh of xml(wbXml).getElementsByTagName("sheet")) {
      const rid = sh.getAttribute("r:id") || sh.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
      let t = target[rid]; if (!t) continue;
      t = t.startsWith("/") ? t.slice(1) : "xl/" + t.replace(/^\.\//, "");
      const sxml = await get(t); if (!sxml) continue;
      const cells = new Map();
      for (const c of xml(sxml).getElementsByTagName("c")) {
        const ref = c.getAttribute("r"), type = c.getAttribute("t");
        const fEl = kids(c, "f")[0], vEl = kids(c, "v")[0], isEl = kids(c, "is")[0];
        let v = null;
        if (type === "s" && vEl) v = sst[Number(vEl.textContent)] ?? null;
        else if (type === "inlineStr" && isEl) v = textOfT(isEl);
        else if (vEl) v = vEl.textContent;
        cells.set(ref, { v, f: fEl ? fEl.textContent || "LEN" : null });
      }
      sheets.push({ name: sh.getAttribute("name"), cells });
    }
    return sheets;
  }

  /* 問答集の書式(星さんの「面接問答集」)
   *   B列: 作成用。「質問」の行(文字数の数式なし)のあとに、「回答(原稿)」の行(C列が =LEN(B..))が続く
   *   回答が複数行に分かれているときは、つなげて1つの原稿にする
   *   C列が =SUM(...) の行は、合計の確認用なので、無視する
   *   A列に A,B,C… と書いてある質問は、A を親とし、B,C… をその深掘り質問にする
   * 戻り値: [{ key, title, script, parentKey, sheet, row }] */
  const NOTE_PAREN = /[（(][^）)]*(作成|書くこと|書き始め|触らない|必須)[^）)]*[）)]/g;
  function cleanTitle(raw, strip) {
    let t = String(raw).split(/\r?\n/).filter((l) => !/^\s*※/.test(l)).join(" ");
    if (strip) t = t.replace(NOTE_PAREN, "");
    if (!strip) t = t.replace(/で作成すること(?=[）)])/g, "");      // 区別のために残す注意書きは、「(LETS以外のエピソード)」の形にする
    return t.replace(/\s+/g, " ").trim().slice(0, 200);
  }

  function parseQA(sheets) {
    const items = [];
    sheets.forEach((sh) => {
      const cell = (col, row) => sh.cells.get(col + row) || null;
      const b2 = [cell("B", 2)?.v, cell("B", 3)?.v].join("|");
      if (!/作成用|質問内容/.test(b2)) return;                   // 問答集の書式でないシート(説明のシートなど)は、読まない
      let maxRow = 0; sh.cells.forEach((_, ref) => { maxRow = Math.max(maxRow, Number(ref.replace(/\D/g, ""))); });
      let cur = null, group = null;
      const flush = () => { if (cur && cur.script) items.push(cur); cur = null; };
      for (let r = 4; r <= maxRow; r++) {
        const a = cell("A", r)?.v, b = cell("B", r), c = cell("C", r);
        const text = b && b.v != null ? String(b.v).trim() : "";
        if (!text) continue;
        const fx = c && c.f ? c.f : null;
        if (fx && /^\s*SUM/i.test(fx)) { flush(); group = null; continue; }         // 合計の行
        if (fx) {                                                                  // 回答の行
          if (cur) cur.script = cur.script ? cur.script + text : text;
          continue;
        }
        flush();                                                                   // 質問の行
        const letter = /^[A-Z]$/.test(String(a || "").trim()) ? String(a).trim() : "";
        const it = { raw: text, letter, script: "", sheet: sh.name, row: r, parentKey: null };
        if (letter === "A") group = it;
        else if (letter && group) it.parentKey = group;
        else if (!letter) group = null;
        cur = it;
      }
      flush();
    });
    // 親が「回答のない質問」だった場合は、親を付けない。質問文を整える(同じ質問文が重なる場合は、注意書きを残して区別する)
    const kept = new Set(items);
    items.forEach((it) => { if (it.parentKey && !kept.has(it.parentKey)) it.parentKey = null; });
    const dup = {};
    items.forEach((it) => { if (!it.parentKey) { const k = cleanTitle(it.raw, true); dup[k] = (dup[k] || 0) + 1; } });
    items.forEach((it) => { it.title = cleanTitle(it.raw, it.parentKey ? true : dup[cleanTitle(it.raw, true)] < 2); });
    items.forEach((it, i) => { it.key = i; });
    items.forEach((it) => { it.parent = it.parentKey ? items.indexOf(it.parentKey) : -1; });
    return items.map((it) => ({ key: it.key, title: it.title, script: it.script.trim().slice(0, 3000), parent: it.parent, sheet: it.sheet, row: it.row }));
  }

  window.XlsxImport = { readXlsx, parseQA };
})();
