// 情報源: 要項・配布資料・企画書などを登録して一覧にする。
// AIで「公式事項・タスク・Q&A・節目」に整理したり、前の版との違いをまとめたりできる(AIは手動ルート: プロンプトをコピー→貼り付け)
import { api, esc, APP, recordersText } from "./common.js";

export const CATEGORIES = ["要項・ルール", "案内・配布資料", "企画書・設計書", "参考サイト", "その他"];
const STATUS = { latest: ["最新", "g"], reference: ["参考（前年度）", "y"], old: ["古い版", "gray"] };
const KIND = { date: "日付", money: "お金", rule: "決まり" };
const LIMIT_FILE = 25 * 1024 * 1024;

const mb = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}MB` : n ? `${Math.max(1, Math.round(n / 1e3))}KB` : "—");
const statusTag = (s) => `<span class="tag ${STATUS[s]?.[1] || "gray"}">${STATUS[s]?.[0] || esc(s)}</span>`;
const canEdit = (me, s) => me.isRecorder || s.uploaded_by === me.name;
const catOptions = (sel) => CATEGORIES.map((c) => `<option ${c === sel ? "selected" : ""}>${c}</option>`).join("");
const statusOptions = (sel) => Object.entries(STATUS).map(([k, [l]]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${l}</option>`).join("");

// ---- PDFの文字を画面側で抜き出す(pdf.js)。AIに渡す本文になる ----
let pdfjs = null;
async function loadPdfJs() {
  if (pdfjs) return pdfjs;
  await new Promise((ok, ng) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.onload = ok; s.onerror = () => ng(new Error("PDFを読む部品を読み込めませんでした"));
    document.head.appendChild(s);
  });
  pdfjs = window.pdfjsLib;
  pdfjs.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  return pdfjs;
}
async function pdfText(file, onPage) {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    onPage?.(i, doc.numPages);
    const c = await (await doc.getPage(i)).getTextContent();
    pages.push(`[p.${i}]\n` + c.items.map((x) => x.str + (x.hasEOL ? "\n" : "")).join(""));
  }
  return pages.join("\n\n");
}

// ================= 一覧 =================
const st = { adding: false };

export async function mountSources(box, projectId, me) {
  const { sources, used, limit } = await api(`/api/projects/${projectId}/sources`);
  const pct = Math.min(100, (used / limit) * 100);
  const warn = pct >= 80;
  const groups = CATEGORIES.map((cat) => [cat, sources.filter((s) => s.category === cat)]).filter(([, l]) => l.length);
  const rows = (l) => l.map((s) => `<tr class="clickrow ${s.status === "old" ? "done" : ""}" data-href="#/p/${projectId}/sources/${s.id}">
      <td><b>${esc(s.title)}</b>${s.note ? `<div class="from">${esc(s.note.slice(0, 60))}</div>` : ""}</td>
      <td>${esc(s.year)}</td><td>${statusTag(s.status)}</td>
      <td class="small">${s.file_name ? "📄 " + mb(s.file_size) : s.origin ? "🔗 リンク" : "—"}${s.text_length ? `<br><span class="muted">本文 ${s.text_length.toLocaleString()}字</span>` : ""}</td>
      <td class="small">${[s.facts && `公式事項 ${s.facts}`, s.tasks && `タスク ${s.tasks}`].filter(Boolean).join("<br>") || `<span class="muted">未整理</span>`}</td>
      <td class="small">${esc(s.uploaded_by || "")}<br><span class="muted">${esc((s.created_at || "").slice(0, 10))}</span></td></tr>`).join("");

  box.innerHTML = `
    <div class="row mbar"><b>${sources.length}件</b><span class="grow"></span>
      ${st.adding ? "" : `<button class="btn" id="srcOpen">＋ 情報源を追加</button>`}</div>
    ${st.adding ? addForm() : ""}
    <div class="card meter ${warn ? "warn" : ""}">
      <div class="row"><b>ファイルの保管容量</b><span>${mb(used)} ／ ${limit / 1e9}GB（${pct < 1 ? "1%未満" : pct.toFixed(0) + "%"}）</span></div>
      <div class="bar"><i style="width:${Math.max(pct, 0.5)}%"></i></div>
      <div class="small ${warn ? "late" : "muted"}">${warn ? "⚠ 容量が残り少なくなっています。古い版や不要なファイルを削除してください。" : "無料の範囲で使えます。1ファイル25MBまで。8割を超えたらここでお知らせします。"}</div>
    </div>
    ${groups.map(([cat, l]) => `<h2>${esc(cat)}</h2><table class="srctable">
      <tr><th>タイトル</th><th style="width:60px">年度</th><th style="width:120px">状態</th><th style="width:110px">ファイル</th><th style="width:120px">整理済み</th><th style="width:110px">登録</th></tr>${rows(l)}</table>`).join("")}
    <p class="muted small">「最新」の版を新しく登録すると、同じ分類のそれまでの最新は自動で「古い版」になります（要項・ルール、案内・配布資料）。<br>
    外部への共有が禁止されている資料は、このツールの中だけで扱ってください。</p>`;

  box.onclick = async (e) => {
    const t = e.target;
    try {
      if (t.id === "srcOpen") { st.adding = true; return mountSources(box, projectId, me); }
      if (t.id === "srcCancel") { st.adding = false; return mountSources(box, projectId, me); }
      if (t.id === "srcSave") return save(box, projectId, me);
    } catch (err) { alert(err.message); }
  };
  box.onchange = async (e) => {
    if (e.target.name !== "file") return;
    const f = e.target.files[0], form = box.querySelector("#srcForm"), msg = box.querySelector("#srcMsg");
    if (!f) return;
    if (f.size > LIMIT_FILE) { msg.innerHTML = `<span class="late">25MBを超えているので登録できません（${mb(f.size)}）。圧縮してから選んでください。</span>`; e.target.value = ""; return; }
    if (!form.elements.title.value) form.elements.title.value = f.name.replace(/\.[^.]+$/, "");
    if (f.type === "application/pdf" || /\.pdf$/i.test(f.name)) {
      try {
        const text = await pdfText(f, (i, n) => (msg.textContent = `PDFの文字を読み取り中… ${i}／${n}ページ`));
        form.elements.text.value = text;
        msg.textContent = text.replace(/\[p\.\d+\]|\s/g, "").length < 50
          ? "このPDFは画像だけのようで、文字が読み取れませんでした。必要なら本文欄に要点を貼り付けてください。"
          : `文字を読み取りました（${text.length.toLocaleString()}字）。`;
      } catch (err) { msg.textContent = `文字の読み取りに失敗しました（${err.message}）。ファイルの登録はできます。`; }
    } else if (/^text\/|\.(txt|md|csv)$/i.test(f.type + f.name)) {
      form.elements.text.value = await f.text();
    }
  };
}

function addForm() {
  return `<form class="card srcform" id="srcForm" onsubmit="return false">
    <b>情報源を追加</b>
    <div class="row"><label>分類 <select name="category">${catOptions("企画書・設計書")}</select></label>
      <label>年度 <input name="year" value="${new Date().getFullYear()}" style="width:70px"></label>
      <label>状態 <select name="status">${statusOptions("latest")}</select></label></div>
    <div class="row"><input name="title" class="wide" placeholder="タイトル（例：企画書 v2）"></div>
    <div class="row"><label>ファイル（PDF・画像・文書など／25MBまで・なくてもOK） <input type="file" name="file"></label></div>
    <div class="row"><input name="origin" class="wide" placeholder="出典元（URLや入手先。例：主催者からのメール）"></div>
    <div class="row"><input name="note" class="wide" placeholder="メモ（例：10/20の会議で配布）"></div>
    <details><summary class="small">本文（AIに渡す文字。PDFは自動で入ります）</summary><textarea name="text" rows="6" class="wide"></textarea></details>
    <div id="srcMsg" class="small muted"></div>
    <div class="row"><button class="btn" id="srcSave" type="button">登録</button><button class="btn sub" id="srcCancel" type="button">やめる</button></div>
  </form>`;
}

async function save(box, projectId, me) {
  const form = box.querySelector("#srcForm"), msg = box.querySelector("#srcMsg");
  if (!form.elements.title.value.trim()) return alert("タイトルを入れてください");
  const btn = box.querySelector("#srcSave");
  btn.disabled = true; msg.textContent = "登録中…";
  const res = await fetch(`/api/projects/${projectId}/sources`, { method: "POST", body: new FormData(form) });
  const body = await res.json().catch(() => ({}));
  btn.disabled = false;
  if (!res.ok) { msg.innerHTML = `<span class="late">${esc(body.error || res.statusText)}</span>`; return; }
  st.adding = false;
  location.hash = `#/p/${projectId}/sources/${body.id}`;
}

// ================= 詳細 =================
const dst = { editing: false, panel: null, review: null, diffBase: null, factEdit: null };

export async function renderSourceDetail($app, projectId, id, me) {
  const [d, list, members] = await Promise.all([api(`/api/sources/${id}`), api(`/api/projects/${projectId}/sources`), api("/api/members")]);
  const s = d.source;
  if (dst.id !== id) Object.assign(dst, { id, editing: false, panel: null, review: null, diffBase: null, factEdit: null });
  document.title = s.title;
  const others = list.sources.filter((x) => x.category === s.category && x.id !== s.id);
  if (dst.diffBase == null || !others.some((x) => x.id === dst.diffBase)) dst.diffBase = (others.find((x) => x.status === "old") || others[0])?.id ?? null;

  const head = dst.editing ? `<form class="card srcform" id="srcEdit" onsubmit="return false">
      <div class="row"><input name="title" class="wide" value="${esc(s.title)}"></div>
      <div class="row"><label>分類 <select name="category">${catOptions(s.category)}</select></label>
        <label>年度 <input name="year" value="${esc(s.year)}" style="width:70px"></label>
        <label>状態 <select name="status">${statusOptions(s.status)}</select></label></div>
      <div class="row"><input name="origin" class="wide" value="${esc(s.origin)}" placeholder="出典元"></div>
      <div class="row"><input name="note" class="wide" value="${esc(s.note)}" placeholder="メモ"></div>
      <div class="label">本文（AIに渡す文字）</div><textarea name="text" rows="8" class="wide">${esc(s.text)}</textarea>
      <div class="row"><button class="btn" data-a="saveMeta">保存</button><button class="btn sub" data-a="cancelMeta">やめる</button>
        <span class="grow"></span><button class="btn danger" data-a="delSrc">この情報源を削除</button></div></form>`
    : `<div class="card">
      <div class="row"><span class="tag gray">${esc(s.category)}</span>${statusTag(s.status)}<span class="muted">${esc(s.year)}年度</span><span class="grow"></span>
        ${s.file_key ? `<a class="btn" href="/api/sources/${s.id}/file" target="_blank" rel="noopener" style="text-decoration:none">📄 ファイルを開く（${mb(s.file_size)}）</a>` : ""}
        ${canEdit(me, s) ? `<button class="btn sub" data-a="editMeta">編集</button>` : ""}</div>
      ${s.origin ? `<div class="small">出典元：${/^https?:\/\//.test(s.origin) ? `<a href="${esc(s.origin)}" target="_blank" rel="noopener">${esc(s.origin)}</a>` : esc(s.origin)}</div>` : ""}
      ${s.note ? `<div class="small pre">${esc(s.note)}</div>` : ""}
      <div class="small muted">登録：${esc(s.uploaded_by || "")}　${esc((s.created_at || "").slice(0, 16))}</div>
      ${s.text ? `<details><summary class="small">本文を見る（${s.text.length.toLocaleString()}字）</summary><div class="pre srctext">${esc(s.text)}</div></details>` : `<div class="small muted">本文がありません。AIで整理するには「編集」から本文を貼り付けてください。</div>`}
    </div>`;

  const tools = me.isRecorder ? `<div class="row">
      <button class="btn ${dst.panel === "org" ? "" : "sub"}" data-a="openOrg">🤖 AIで整理（公式事項・タスク・Q&amp;A・節目）</button>
      <button class="btn ${dst.panel === "diff" ? "" : "sub"}" data-a="openDiff" ${others.length ? "" : "disabled title='同じ分類の別の版がありません'"}>🔍 前の版と比べる</button></div>
      ${dst.panel === "org" ? orgPanel(s, d, members) : ""}${dst.panel === "diff" ? diffPanel(s, others) : ""}`
    : `<p class="muted small">AIでの整理と版の比較は記録係（${esc(recordersText())}）が行います。</p>`;

  const diffs = d.diffs.map((x) => diffCard(x, me)).join("");
  const facts = d.facts.map((f) => factRow(f)).join("");
  $app.innerHTML = `
    <p><a href="#/p/${projectId}/sources">← 情報源の一覧</a></p>
    <h1>${esc(s.title)}</h1>
    ${head}${tools}
    ${diffs ? `<h2>版の違い</h2>${diffs}` : ""}
    <h2>公式事項（${d.facts.length}件）</h2>
    ${d.facts.length ? `<table class="small"><tr><th style="width:70px">種類</th><th style="width:200px">項目</th><th>内容</th><th style="width:60px">頁</th><th style="width:80px"></th></tr>${facts}</table>` : `<p class="muted">まだありません。</p>`}
    ${d.tasks.length ? `<h2>この情報源から作ったタスク（${d.tasks.length}件）</h2><div class="card"><ul class="plain">${d.tasks.map((t) => `<li>${t.status === "done" ? "✅ " : ""}${esc(t.title)}</li>`).join("")}</ul></div>` : ""}`;

  const re = () => renderSourceDetail($app, projectId, id, me);
  $app.onclick = async (e) => {
    const b = e.target.closest("[data-a]");
    if (!b) return;
    const a = b.dataset.a;
    try {
      if (a === "editMeta") { dst.editing = true; return re(); }
      if (a === "cancelMeta") { dst.editing = false; return re(); }
      if (a === "saveMeta") {
        const f = $app.querySelector("#srcEdit");
        const body = Object.fromEntries(["title", "category", "year", "status", "origin", "note", "text"].map((k) => [k, f.elements[k].value]));
        await api(`/api/sources/${id}`, { method: "PATCH", body: JSON.stringify(body) });
        dst.editing = false; return re();
      }
      if (a === "delSrc") {
        if (!confirm(`「${s.title}」を削除しますか？\n\n・登録したファイルは消えます\n・ここから整理した公式事項・タスク・Q&Aは残ります（出典の表示だけ外れます）`)) return;
        await api(`/api/sources/${id}`, { method: "DELETE" });
        dst.editing = false; location.hash = `#/p/${projectId}/sources`; return;
      }
      if (a === "openOrg") { dst.panel = dst.panel === "org" ? null : "org"; dst.review = null; return re(); }
      if (a === "openDiff") { dst.panel = dst.panel === "diff" ? null : "diff"; dst.review = null; return re(); }
      if (a === "copyOrg") return copy(orgPrompt(s, d, members), b);
      if (a === "readOrg") {
        dst.review = parseJson($app.querySelector("#aiJson").value);
        return re();
      }
      if (a === "saveOrg") {
        const pick = (kind, fields) => [...$app.querySelectorAll(`[data-rv="${kind}"]`)].map((row) =>
          Object.fromEntries([["register", row.querySelector("[name=register]").checked], ...fields.map((k) => [k, row.querySelector(`[name=${k}]`)?.value ?? ""])]));
        const payload = {
          facts: pick("facts", ["title", "content", "page", "kind"]),
          tasks: pick("tasks", ["title", "assignee_id", "start_date", "due_date", "done_criteria", "page"]),
          qas: pick("qas", ["question", "answer"]),
          milestones: pick("milestones", ["date", "end_date", "title", "kind"]),
        };
        const r = await api(`/api/sources/${id}/organize`, { method: "POST", body: JSON.stringify(payload) });
        alert(`${r.count}件を登録しました。`);
        dst.panel = null; dst.review = null; return re();
      }
      if (a === "copyDiff") return copy(diffPrompt(s, list.sources.find((x) => x.id === dst.diffBase), await api(`/api/sources/${dst.diffBase}`)), b);
      if (a === "saveDiff") {
        const j = parseJson($app.querySelector("#diffJson").value);
        await api(`/api/sources/${id}/diffs`, { method: "POST", body: JSON.stringify({ ...j, base_source_id: dst.diffBase }) });
        dst.panel = null; return re();
      }
      if (a === "delDiff" && confirm("この比較結果を削除しますか？")) { await api(`/api/diffs/${b.dataset.id}`, { method: "DELETE" }); return re(); }
      if (a === "editFact") { dst.factEdit = Number(b.dataset.id); return re(); }
      if (a === "cancelFact") { dst.factEdit = null; return re(); }
      if (a === "saveFact") {
        const row = b.closest("tr");
        const body = Object.fromEntries(["kind", "title", "content", "page"].map((k) => [k, row.querySelector(`[name=${k}]`).value]));
        await api(`/api/facts/${b.dataset.id}`, { method: "PATCH", body: JSON.stringify(body) });
        dst.factEdit = null; return re();
      }
      if (a === "delFact" && confirm("この公式事項を削除しますか？")) { await api(`/api/facts/${b.dataset.id}`, { method: "DELETE" }); return re(); }
    } catch (err) { alert(err.message); }
  };
  $app.onchange = (e) => { if (e.target.id === "diffBase") { dst.diffBase = Number(e.target.value); } };
}

function factRow(f) {
  if (dst.factEdit === f.id) return `<tr><td><select name="kind">${Object.entries(KIND).map(([k, v]) => `<option value="${k}" ${k === f.kind ? "selected" : ""}>${v}</option>`).join("")}</select></td>
    <td><input name="title" value="${esc(f.title)}" class="wide"></td><td><textarea name="content" rows="2" class="wide">${esc(f.content)}</textarea></td>
    <td><input name="page" value="${esc(f.page)}" style="width:50px"></td>
    <td><button class="btn" data-a="saveFact" data-id="${f.id}">保存</button><button class="btn sub" data-a="cancelFact">×</button></td></tr>`;
  return `<tr><td><span class="tag ${f.kind === "date" ? "y" : f.kind === "money" ? "g" : "gray"}">${KIND[f.kind] || ""}</span></td><td><b>${esc(f.title)}</b></td>
    <td class="pre">${esc(f.content)}</td><td>${esc(f.page)}</td>
    <td><button class="icon" data-a="editFact" data-id="${f.id}" title="直す">✏️</button><button class="icon" data-a="delFact" data-id="${f.id}" title="削除">🗑</button></td></tr>`;
}

function diffCard(x, me) {
  const ch = JSON.parse(x.changes || "[]");
  return `<div class="card diff"><div class="row"><b>${esc(x.base_title || "前の版")} → この版</b><span class="muted small">${esc((x.created_at || "").slice(0, 10))} ${esc(x.created_by || "")}</span>
    <span class="grow"></span>${me.isRecorder ? `<button class="icon" data-a="delDiff" data-id="${x.id}" title="削除">🗑</button>` : ""}</div>
    ${x.summary ? `<p>${esc(x.summary)}</p>` : ""}
    ${ch.length ? `<table class="small"><tr><th style="width:160px">項目</th><th>前の版</th><th>この版</th><th style="width:50px">頁</th><th>チームへの影響</th></tr>
      ${ch.map((c) => `<tr><td><b>${esc(c.item)}</b></td><td>${esc(c.before)}</td><td>${esc(c.after)}</td><td>${esc(c.page)}</td><td>${esc(c.impact)}</td></tr>`).join("")}</table>` : `<p class="muted small">違いは見つかりませんでした。</p>`}</div>`;
}

// ---- AIで整理 ----
function orgPrompt(s, d, members) {
  return `あなたはプロジェクトチームの事務局です。下の資料を読み、「${APP.name}」のチーム「${APP.short}」が
押さえるべき情報を整理してください。

# 出力（JSONだけを返す。説明文やコードブロックの記号は不要）
{
  "facts": [{"title":"項目名（短く）","content":"内容（数字・日付は資料どおり正確に）","page":"p.12 のような頁。不明なら空","kind":"date|money|rule"}],
  "tasks": [{"title":"チームがやること（〜する）","start_date":"YYYY-MM-DD または空","due_date":"YYYY-MM-DD または空","done_criteria":"完了条件","assignee":"担当が明記されていれば名簿の呼び名、なければ空","page":"頁"}],
  "qas": [{"question":"資料だけでは分からず運営に確認が必要なこと","answer":"資料に答えがあれば記入、なければ空"}],
  "milestones": [{"date":"YYYY-MM-DD","end_date":"YYYY-MM-DD または空","title":"締切や行事","kind":"deadline|event"}]
}

# ルール
- 公式事項は「締切・金額・禁止事項・提出物・時間」など、チームが間違えると困るものを優先。推測で数字を作らない。
- すでに登録済みのもの（下の一覧）と同じ内容は出さない。
- タスクはチームとして必要な行動だけ。日付が資料にない場合は空にする。
- 名簿：${members.map((m) => m.name).join("、")}

# 登録済みの公式事項
${d.facts.map((f) => `- ${f.title}`).join("\n") || "（なし）"}

# 資料「${s.title}」（${s.year}年度・${s.category}）
${s.text || "（本文なし）"}`;
}

function orgPanel(s, d, members) {
  if (!s.text) return `<div class="card"><p class="late">本文がないので整理できません。「編集」から本文を貼り付けてください。</p></div>`;
  if (!dst.review) return `<div class="card aiflow">
    <ol class="small"><li>「プロンプトをコピー」を押す（資料の本文も入っています）</li><li>Claude または ChatGPT に貼り付けて送る</li><li>返ってきたJSONを下に貼り付けて「読み込む」→ 内容を確認して登録</li></ol>
    <div class="row"><button class="btn" data-a="copyOrg">📋 プロンプトをコピー</button><span class="muted small">約${Math.round(orgPrompt(s, d, members).length / 1000)}千字</span></div>
    <textarea id="aiJson" rows="6" class="wide" placeholder="AIの返事（JSON）をここに貼り付け"></textarea>
    <button class="btn" data-a="readOrg">読み込む</button></div>`;
  const r = dst.review;
  const norm = (n) => String(n || "").replace(/さん$/, "").replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  const mopts = (name) => `<option value="">担当未定</option>` + members.map((m) => `<option value="${m.id}" ${name && norm(m.name) === norm(name) ? "selected" : ""}>${esc(m.name)}</option>`).join("");
  const chk = `<input type="checkbox" name="register" checked>`;
  const sec = (title, list, head, row) => list?.length ? `<h3>${title}（${list.length}件）</h3><table class="small review"><tr><th style="width:36px">登録</th>${head}</tr>${list.map(row).join("")}</table>` : "";
  return `<div class="card aiflow"><p class="small">チェックを外したものは登録しません。内容はここで直せます。</p>
    ${sec("公式事項", r.facts, `<th style="width:80px">種類</th><th style="width:180px">項目</th><th>内容</th><th style="width:60px">頁</th>`, (f) => `<tr data-rv="facts"><td>${chk}</td>
      <td><select name="kind">${Object.entries(KIND).map(([k, v]) => `<option value="${k}" ${k === f.kind ? "selected" : ""}>${v}</option>`).join("")}</select></td>
      <td><input name="title" value="${esc(f.title)}" class="wide"></td><td><textarea name="content" rows="2" class="wide">${esc(f.content)}</textarea></td><td><input name="page" value="${esc(f.page)}" style="width:50px"></td></tr>`)}
    ${sec("タスク", r.tasks, `<th>やること</th><th style="width:110px">担当</th><th style="width:130px">開始</th><th style="width:130px">期限</th><th>完了条件</th>`, (t) => `<tr data-rv="tasks"><td>${chk}</td>
      <td><input name="title" value="${esc(t.title)}" class="wide"><input type="hidden" name="page" value="${esc(t.page)}"></td><td><select name="assignee_id">${mopts(t.assignee)}</select></td>
      <td><input type="date" name="start_date" value="${esc(t.start_date)}"></td><td><input type="date" name="due_date" value="${esc(t.due_date)}"></td>
      <td><input name="done_criteria" value="${esc(t.done_criteria)}" class="wide"></td></tr>`)}
    ${sec("Q&amp;A（確認が必要なこと）", r.qas, `<th>質問</th><th>回答</th>`, (q) => `<tr data-rv="qas"><td>${chk}</td>
      <td><textarea name="question" rows="2" class="wide">${esc(q.question)}</textarea></td><td><textarea name="answer" rows="2" class="wide">${esc(q.answer)}</textarea></td></tr>`)}
    ${sec("カレンダーの節目", r.milestones, `<th style="width:130px">日付</th><th style="width:130px">終了日</th><th>内容</th><th style="width:90px">種類</th>`, (m) => `<tr data-rv="milestones"><td>${chk}</td>
      <td><input type="date" name="date" value="${esc(m.date)}"></td><td><input type="date" name="end_date" value="${esc(m.end_date)}"></td>
      <td><input name="title" value="${esc(m.title)}" class="wide"></td><td><select name="kind"><option value="deadline" ${m.kind !== "event" ? "selected" : ""}>締切</option><option value="event" ${m.kind === "event" ? "selected" : ""}>行事</option></select></td></tr>`)}
    <div class="row"><button class="btn" data-a="saveOrg">チェックしたものを登録</button><button class="btn sub" data-a="openOrg">やめる</button></div></div>`;
}

// ---- 前の版と比べる ----
function diffPrompt(s, base, bd) {
  return `2つの版の資料を比べて、変わった点をまとめてください。チーム「${APP.short}」に影響がありそうな変更（締切・金額・ルール・提出物・時間・場所）を優先し、
言い回しだけの違いは無視してください。

# 出力（JSONだけを返す）
{"summary":"全体として何が変わったか（2〜3文）","changes":[{"item":"項目","before":"前の版の内容","after":"新しい版の内容（削除なら「削除」）","page":"新しい版の頁","impact":"チームがやるべきこと・注意点"}]}

# 前の版「${base.title}」（${base.year}年度）
${bd.source.text || "（本文なし）"}

# 新しい版「${s.title}」（${s.year}年度）
${s.text || "（本文なし）"}`;
}

function diffPanel(s, others) {
  return `<div class="card aiflow">
    <div class="row"><label>比べる版 <select id="diffBase">${others.map((x) => `<option value="${x.id}" ${x.id === dst.diffBase ? "selected" : ""}>${esc(x.title)}（${esc(x.year)}・${STATUS[x.status]?.[0] || ""}）</option>`).join("")}</select></label></div>
    <ol class="small"><li>「プロンプトをコピー」を押す（両方の版の本文が入ります）</li><li>Claude または ChatGPT に貼り付けて送る</li><li>返ってきたJSONを貼り付けて「保存」</li></ol>
    <button class="btn" data-a="copyDiff">📋 プロンプトをコピー</button>
    <textarea id="diffJson" rows="6" class="wide" placeholder="AIの返事（JSON）をここに貼り付け"></textarea>
    <button class="btn" data-a="saveDiff">保存</button></div>`;
}

function parseJson(text) {
  const m = String(text).replace(/```(json)?/g, "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("JSONが見つかりません。AIの返事をそのまま貼り付けてください");
  try { return JSON.parse(m[0]); } catch { throw new Error("JSONの形が崩れています。AIに「JSONだけで出し直して」と頼んでください"); }
}

async function copy(text, btn) {
  await navigator.clipboard.writeText(text);
  const old = btn.textContent; btn.textContent = "✅ コピーしました"; setTimeout(() => (btn.textContent = old), 1500);
}
