import { api, esc, STATUS_ATT as ATT, APP } from "./common.js";
import { renderMinutesEditor } from "./editor.js";
import { renderRecorder } from "./recorder.js";
import { mountMembers } from "./members.js";
import { renderSetup, renderLogin, renderInvite, renderSettings } from "./auth-pages.js";
import { mountSources, renderSourceDetail } from "./sources.js";
// 画面の表示(ページ切り替えはURLの # 以降で行う)
const $app = document.getElementById("app");
let me = null;


const fmtDate = (d) => (d ? d.slice(0, 10).replaceAll("-", "/") : "");
const STATUS = { todo: "未着手", doing: "進行中", done: "完了" };


// ---- プロジェクト詳細(タブ) ----
const TABS = [
  ["summary", "まとめ"],
  ["calendar", "カレンダー"],
  ["tasks", "タスク"],
  ["minutes", "議事録"],
  ["sources", "情報源"],
  ["members", "メンバー"],
];
const PROJECT_ID = 1; // 1つのツール = 1つのプロジェクト(プロジェクトの選択画面は出さない)

// まとめ: チームの軸(目的・方向性)と、いまの最新情報だけを見せる。細かい一覧は下にたたんでおく
const sumState = { editing: false };

function summaryTab(d) {
  const p = d.project, s = d.stats, today = todayStr();
  const days = (a) => Math.round((new Date(a) - new Date(today)) / 86400000);

  // 1. 目的と方向性
  const pol = sumState.editing
    ? `<form id="dirForm" class="card dir" onsubmit="return false">
        <div class="label">目的（概要）</div><textarea name="overview" rows="3" class="wide">${esc(p.overview)}</textarea>
        <div class="label">コンセプト</div><textarea name="concept" rows="2" class="wide">${esc(p.concept)}</textarea>
        <div class="label" style="margin-top:12px">方向性</div>
        ${d.policies.map((x) => `<div class="row polrow" data-pol="${x.id}"><input name="item" value="${esc(x.item)}" style="width:170px"><textarea name="content" rows="2" class="wide">${esc(x.content)}</textarea>
          <button type="button" class="icon" data-poldel="${x.id}" title="削除">🗑</button></div>`).join("")}
        <div class="row polrow" data-pol="new"><input name="item" placeholder="項目（例：価格の考え方）" style="width:170px"><textarea name="content" rows="2" class="wide" placeholder="内容（入れると追加されます）"></textarea></div>
        <div class="row"><button type="button" class="btn" id="dirSave">保存</button><button type="button" class="btn sub" id="dirCancel">やめる</button></div></form>`
    : `<div class="card dir">
        <div class="row"><div class="grow"><div class="label">目的</div><div class="pre">${esc(p.overview)}</div></div><button class="btn sub" id="dirEdit">編集</button></div>
        <div class="label" style="margin-top:10px">コンセプト</div><div class="concept">${esc(p.concept)}</div>
        ${d.policies.length ? `<dl class="pol">${d.policies.map((x) => `<dt>${esc(x.item)}</dt><dd>${esc(x.content)}</dd>`).join("")}</dl>` : ""}</div>`;

  // 2. いまの状況
  const upcoming = d.milestones.filter((x) => (x.end_date || x.date) >= today).slice(0, 3);
  const msHtml = upcoming.map((x) => `<li><b>${fmtDate(x.date)}</b> ${esc(x.title)}<span class="muted small">　${days(x.date) <= 0 ? "開催中" : `あと${days(x.date)}日`}</span></li>`).join("") || `<li class="muted">予定はありません</li>`;
  const lm = s.latestMeeting;
  const lmDecisions = lm ? d.decisions.filter((x) => x.meeting_id === lm.id).slice(0, 5) : [];
  const lmHtml = lm ? `<a href="#/p/${p.id}/minutes/${lm.id}"><b>${esc(lm.title)}</b></a> <span class="muted small">${fmtDate(lm.held_at)}</span>
      ${lmDecisions.length ? `<ul class="plain small">${lmDecisions.map((x) => `<li>✔ ${esc(x.content)}</li>`).join("")}</ul>` : ""}` : `<span class="muted">まだありません</span>`;
  const PRI_T = { 高: "", 中: "y", 低: "gray" };
  const taskHtml = s.nextTasks.map((t) => `<li><a class="tasklink" href="#/p/${p.id}/tasks/${t.id}">${t.priority ? `<span class="tag ${PRI_T[t.priority]}">${esc(t.priority)}</span> ` : ""}${esc(t.title)}</a>
      <div class="muted small">${t.due_date && t.due_date < today ? `<span class="late">期限超過</span> ` : ""}${t.due_date ? `期限 ${fmtDate(t.due_date)}（${days(t.due_date) < 0 ? `${-days(t.due_date)}日過ぎ` : `あと${days(t.due_date)}日`}）` : "期限未定"}・${esc(t.assignee || "担当未定")}</div></li>`).join("") || `<li class="muted">未完了のタスクはありません</li>`;

  // 3. 検討中のこと(優先度の高い順)
  const open = d.issues.filter((x) => x.status === "open");
  const resolved = d.issues.filter((x) => x.status !== "open");
  const PRI = { 高: "", 中: "y", 低: "gray" };
  const issueLi = (x) => `<li>${x.priority ? `<span class="tag ${PRI[x.priority] ?? "gray"}">${esc(x.priority)}</span>` : ""} <b>${esc(x.content)}</b>
      ${x.next_step ? `<div class="from">次の一手：${esc(x.next_step)}</div>` : ""}<button class="btn sub mini" data-resolve="${x.id}">解決した</button></li>`;

  // 4. 確認待ち(未回答のQ&A)
  const unanswered = d.qas.filter((x) => !x.answer);

  // 5. たたんでおく一覧
  const KIND = { date: ["日付", "y"], money: ["お金", "g"], rule: ["決まり", "gray"] };
  const facts = d.facts.map((f) => `<tr><td><span class="tag ${KIND[f.kind]?.[1] || "gray"}">${KIND[f.kind]?.[0] || ""}</span></td><td><b>${esc(f.title)}</b></td><td class="pre">${esc(f.content)}</td>
    <td class="small">${f.source_id ? `<a href="#/p/${p.id}/sources/${f.source_id}">${esc(f.source_title || "")}</a>` : ""} ${esc(f.page || "")}</td></tr>`).join("");
  const qas = d.qas.filter((x) => x.answer).map((x) => `<div class="qa"><div class="q">Q. ${esc(x.question)}</div><div class="a">${esc(x.answer)}</div></div>`).join("");
  const decisions = d.decisions.map((x) => `<li>${esc(x.content)} <span class="muted small">（${fmtDate(x.decided_on)}${x.meeting_title ? " " + esc(x.meeting_title) : ""}）</span></li>`).join("");
  const diffs = d.diffs.map((x) => `<li><a href="#/p/${p.id}/sources/${x.source_id}">${esc(x.source_title)}</a> <span class="muted small">${esc((x.created_at || "").slice(0, 10))}</span>
    ${x.summary ? `<div class="small">${esc(x.summary)}</div>` : ""}</li>`).join("");

  return `
    <h2>目的と方向性</h2>${pol}
    ${diffs ? `<h2>🆕 資料の更新</h2><div class="card"><ul class="plain">${diffs}</ul></div>` : ""}
    <h2>いまの状況</h2>
    <div class="now">
      <div class="card wide"><div class="label">優先して進めるタスク（優先度 → 締切の早い順）</div><ul class="plain">${taskHtml}</ul><a class="small" href="#/p/${p.id}/tasks">すべてのタスクへ →</a></div>
      <div class="nowcol">
        <div class="card"><div class="label">次の節目</div><ul class="plain">${msHtml}</ul><a class="small" href="#/p/${p.id}/calendar">カレンダーへ →</a></div>
        <div class="card"><div class="label">最新の会議で決まったこと</div>${lmHtml}</div>
      </div>
    </div>
    <h2>検討中のこと（${open.length}件）</h2>
    <div class="card"><ul class="plain issues">${open.slice(0, 5).map(issueLi).join("") || `<li class="muted">検討中のことはありません</li>`}</ul>
      ${open.length > 5 ? `<details><summary class="small">残り${open.length - 5}件を見る</summary><ul class="plain issues">${open.slice(5).map(issueLi).join("")}</ul></details>` : ""}
      ${resolved.length ? `<details><summary class="small muted">解決済み（${resolved.length}件）</summary><ul class="plain small">${resolved.map((x) => `<li>✅ ${esc(x.content)} <button class="btn sub mini" data-reopen="${x.id}">戻す</button></li>`).join("")}</ul></details>` : ""}</div>
    ${unanswered.length ? `<h2>確認待ち（${unanswered.length}件）</h2><div class="card"><ul class="plain">${unanswered.map((x) => `<li>Q. ${esc(x.question)}</li>`).join("")}</ul></div>` : ""}
    <h2>記録</h2>
    <details class="card fold"><summary>これまでに決まったこと（${d.decisions.length}件）</summary><ul class="plain">${decisions}</ul></details>
    <details class="card fold"><summary>公式事項（${d.facts.length}件）</summary><table class="small"><tr><th style="width:64px">種類</th><th style="width:200px">項目</th><th>内容</th><th style="width:170px">出典</th></tr>${facts}</table></details>
    <details class="card fold"><summary>回答済みのQ&amp;A（${d.qas.length - unanswered.length}件）</summary>${qas}</details>`;
}

// 目的と方向性の編集(全員)
$app.addEventListener("click", async (e) => {
  const t = e.target;
  try {
    if (t.id === "dirEdit") { sumState.editing = true; return route(); }
    if (t.id === "dirCancel") { sumState.editing = false; return route(); }
    if (t.dataset.poldel) { if (confirm("この項目を削除しますか？")) { await api(`/api/policies/${t.dataset.poldel}`, { method: "DELETE" }); route(); } return; }
    if (t.id === "dirSave") {
      const f = document.getElementById("dirForm");
      const policies = [...f.querySelectorAll("[data-pol]")].map((r) => ({ id: r.dataset.pol, item: r.querySelector("[name=item]").value, content: r.querySelector("[name=content]").value }));
      await api(`/api/projects/${PROJECT_ID}/direction`, { method: "POST", body: JSON.stringify({ overview: f.elements.overview.value, concept: f.elements.concept.value, policies }) });
      sumState.editing = false; return route();
    }
  } catch (err) { alert(err.message); }
});

// ---- タスク(表のまま、その場で修正。変更すると自動で保存) ----
const taskFilter = { scope: "open", who: "all", overdueOnly: false };
const todayStr = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

function taskRow(t, members) {
  const overdue = t.status !== "done" && t.due_date && t.due_date < todayStr();
  const memberOpts = `<option value="">担当未定</option>` + members.map((m) => `<option value="${m.id}" ${m.id === t.assignee_id ? "selected" : ""}>${esc(m.name)}</option>`).join("");
  const statusOpts = Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === t.status ? "selected" : ""}>${v}</option>`).join("");
  return `<tr class="${t.status === "done" ? "done" : ""} ${overdue ? "overdue" : ""}" data-task="${t.id}">
    <td><select data-f="status" class="st-${t.status}">${statusOpts}</select></td>
    <td><textarea data-f="title" rows="1" class="wide title">${esc(t.title)}</textarea>
      ${t.meeting_title ? `<div class="from">${esc(t.meeting_title)}で決定${t.meeting_held_at ? `（${fmtDate(t.meeting_held_at)}）` : ""}</div>` : ""}
      ${t.source_title ? `<div class="from">出典：<a href="#/p/${t.project_id}/sources/${t.source_id}">${esc(t.source_title)}</a></div>` : ""}
      <details class="dc"><summary class="from">完了条件${t.done_criteria ? "：" + esc(t.done_criteria.slice(0, 40)) + (t.done_criteria.length > 40 ? "…" : "") : "（未設定）"}</summary>
        <textarea data-f="done_criteria" rows="2" class="wide" placeholder="どうなったら完了か">${esc(t.done_criteria || "")}</textarea>
        ${t.note ? `<div class="from pre">${esc(t.note)}</div>` : ""}</details></td>
    <td><select data-f="assignee_id">${memberOpts}</select>
      <select data-f="priority" class="pri pri-${t.priority || "none"}" title="優先度">${["", "高", "中", "低"].map((v) => `<option value="${v}" ${v === (t.priority || "") ? "selected" : ""}>${v ? "優先度 " + v : "優先度 －"}</option>`).join("")}</select></td>
    <td><input type="date" data-f="start_date" value="${t.start_date ?? ""}">${t.start_date ? "" : `<div class="undecided">日程未定</div>`}</td>
    <td><input type="date" data-f="due_date" value="${t.due_date ?? ""}">${overdue ? `<div class="late">期限超過</div>` : ""}</td>
    <td><button class="icon" data-del="${t.id}" title="削除">🗑</button></td>
  </tr>`;
}

async function tasksTab(id) {
  const [tasks, members, history] = await Promise.all([api(`/api/projects/${id}/tasks`), api("/api/members"), api(`/api/projects/${id}/history`)]);
  const myId = members.find((m) => m.name === me.name)?.id;
  const f = taskFilter;
  const shown = tasks.filter((t) =>
    (f.scope === "all" || t.status !== "done") &&
    (f.who === "all" || (f.who === "me" ? t.assignee_id === myId : f.who === "none" ? !t.assignee_id : t.assignee_id === Number(f.who))) &&
    (!f.overdueOnly || (t.status !== "done" && t.due_date && t.due_date < todayStr()))
  );
  const whoOpts = [["all", "全員"], ["me", "自分の担当"], ["none", "担当未定"], ...members.map((m) => [String(m.id), m.name])]
    .map(([v, l]) => `<option value="${v}" ${f.who === v ? "selected" : ""}>${esc(l)}</option>`).join("");
  const memberOpts = `<option value="">担当未定</option>` + members.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join("");
  const hist = history.slice(0, 15).map((h) => {
    const what = { create: "追加", update: "変更", delete: "削除" }[h.action];
    const title = h.task_title || JSON.parse(h.before_json || h.after_json || "{}").title || "";
    return `<li><span class="muted">${esc(h.changed_at)}</span>　${esc(h.changed_by)} が「${esc(title)}」を${what}</li>`;
  }).join("");
  return `
    <div class="card addtask">
      <div class="label">タスクを追加</div>
      <form id="addTask" class="row">
        <input name="title" placeholder="やること（例：レイアウト図の作成）" class="wide" required>
        <select name="assignee_id">${memberOpts}</select>
        <label>開始 <input type="date" name="start_date"></label>
        <label>期限 <input type="date" name="due_date"></label>
        <button class="btn">追加</button>
      </form>
    </div>
    <div class="filters">
      <label><input type="radio" name="scope" value="open" ${f.scope === "open" ? "checked" : ""}> 未完了のみ</label>
      <label><input type="radio" name="scope" value="all" ${f.scope === "all" ? "checked" : ""}> 完了も表示</label>
      <label>担当 <select id="fWho">${whoOpts}</select></label>
      <label><input type="checkbox" id="fOver" ${f.overdueOnly ? "checked" : ""}> 期限超過のみ</label>
      <span class="muted">${shown.length}件表示 ／ 全${tasks.length}件</span>
      <span id="saved" class="saved"></span>
    </div>
    <table class="tasks">
      <tr><th style="width:110px">状態</th><th>内容</th><th style="width:140px">担当・優先度</th><th style="width:150px">開始日</th><th style="width:150px">期限</th><th style="width:44px"></th></tr>
      ${shown.map((t) => taskRow(t, members)).join("") || `<tr><td colspan="6" class="muted">該当するタスクはありません</td></tr>`}
    </table>
    <p class="muted small">変更するとすぐに保存されます。削除した内容も変更履歴に残ります。</p>
    <h2>最近の変更</h2><div class="card"><ul class="plain small">${hist || `<li class="muted">まだありません</li>`}</ul></div>`;
}

function flashSaved(text = "保存しました") {
  const el = document.getElementById("saved");
  if (!el) return;
  el.textContent = "✓ " + text;
  clearTimeout(flashSaved.t);
  flashSaved.t = setTimeout(() => (el.textContent = ""), 2000);
}

// タスクの編集: 入力が確定したら保存
$app.addEventListener("change", async (e) => {
  const el = e.target;
  if (el.name === "scope") { taskFilter.scope = el.value; return route(); }
  if (el.id === "fWho") { taskFilter.who = el.value; return route(); }
  if (el.id === "fOver") { taskFilter.overdueOnly = el.checked; return route(); }
  const row = el.closest("tr[data-task]");
  if (!row || !el.dataset.f) return;
  try {
    await api(`/api/tasks/${row.dataset.task}`, { method: "PATCH", body: JSON.stringify({ [el.dataset.f]: el.value }) });
    flashSaved();
    if (["status", "start_date", "due_date", "priority"].includes(el.dataset.f)) route(); // 表示(期限超過・進捗率など)を更新
  } catch (err) {
    alert(err.message);
    route();
  }
});

$app.addEventListener("submit", async (e) => {
  if (e.target.id !== "addTask") return;
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.target));
  try {
    await api(`/api/projects/${currentProjectId}/tasks`, { method: "POST", body: JSON.stringify(data) });
    route();
  } catch (err) {
    alert(err.message);
  }
});

// ---- カレンダー(月めくり・日曜始まり。タスクの期間を矢印のバーで表示) ----
const calState = { date: null, who: "all", showDone: true };
const DAY = 86400_000;
const addDay = (d, n = 1) => new Date(new Date(d + "T00:00:00Z").getTime() + n * DAY).toISOString().slice(0, 10);

function calendarTab() {
  return `
    <div class="filters">
      <label>担当 <select id="calWho"></select></label>
      <label><input type="checkbox" id="calDone" ${calState.showDone ? "checked" : ""}> 完了したタスクも表示</label>
      <span class="legend"><i class="lg todo"></i>未着手 <i class="lg doing"></i>進行中 <i class="lg done"></i>完了 <i class="lg ms"></i>締切・本番 <i class="lg mt"></i>会議</span>
      <span id="saved" class="saved"></span>
    </div>
    <div class="card calcard"><div id="cal"></div></div>
    <p class="muted small">バーをドラッグすると日程を移動、右端を引っ張ると期限を変更できます（自動で保存）。</p>
    <h2 id="undecidedTitle">日程未定のタスク</h2><div class="card"><ul class="plain" id="undecided"></ul></div>`;
}

async function mountCalendar(id, d) {
  const [tasks, members] = await Promise.all([api(`/api/projects/${id}/tasks`), api("/api/members")]);
  const whoSel = document.getElementById("calWho");
  whoSel.innerHTML = [["all", "全員"], ["none", "担当未定"], ...members.map((m) => [String(m.id), m.name])]
    .map(([v, l]) => `<option value="${v}" ${calState.who === v ? "selected" : ""}>${esc(l)}</option>`).join("");
  const match = (t) => calState.who === "all" || (calState.who === "none" ? !t.assignee_id : t.assignee_id === Number(calState.who));

  const taskEvents = tasks.filter((t) => t.start_date && match(t) && (calState.showDone || t.status !== "done")).map((t) => ({
    id: "t" + t.id,
    title: `${t.assignee || "担当未定"}：${t.title}`,
    start: t.start_date,
    end: addDay(t.due_date || t.start_date), // 終了日は「翌日」を渡すと、期限の日までバーが伸びる
    classNames: ["task-bar", "st-" + t.status],
    editable: true,
    extendedProps: { task: t },
  }));
  const msEvents = d.milestones.map((m) => ({
    id: "m" + m.id,
    title: (m.kind === "meeting" ? "💬 " : m.kind === "deadline" ? "⚑ " : "★ ") + m.title,
    start: m.date,
    end: addDay(m.end_date || m.date),
    classNames: ["ms-" + m.kind],
    editable: false,
  }));

  const undecided = tasks.filter((t) => !t.start_date && t.status !== "done" && match(t));
  document.getElementById("undecidedTitle").textContent = `日程未定のタスク（${undecided.length}件）`;
  document.getElementById("undecided").innerHTML = undecided.length
    ? undecided.map((t) => `<li><a href="#/p/${id}/tasks/${t.id}">${esc(t.assignee || "担当未定")}：${esc(t.title)}</a>${t.due_date ? ` <span class="muted">期限 ${fmtDate(t.due_date)}</span>` : ""}</li>`).join("") +
      `<li class="muted small">開始日はタスク画面で入れると、カレンダーに表示されます。<a href="#/p/${id}/tasks">タスク画面へ</a></li>`
    : `<li class="muted">ありません</li>`;

  const p = d.project;
  const today = todayStr();
  const initial = calState.date || (today < p.start_date ? p.start_date : today > p.end_date ? p.end_date : today);
  const cal = new FullCalendar.Calendar(document.getElementById("cal"), {
    initialView: "dayGridMonth",
    locale: "ja",
    firstDay: 0, // 日曜始まり
    initialDate: initial,
    validRange: { start: p.start_date.slice(0, 7) + "-01", end: addDay(p.end_date) },
    headerToolbar: { left: "prev,next today", center: "title", right: "" },
    height: "auto",
    dayMaxEvents: false,
    eventOrder: "-duration,start",
    events: [...msEvents, ...taskEvents],
    eventDidMount: (info) => { info.el.title = info.event.title + (info.event.extendedProps.task ? "（クリックでタスクへ）" : ""); },
    eventClick: (info) => { const t = info.event.extendedProps.task; if (t) location.hash = `#/p/${id}/tasks/${t.id}`; },
    datesSet: (info) => { calState.date = info.view.currentStart.toISOString().slice(0, 10); },
    eventDrop: (info) => saveDates(info),
    eventResize: (info) => saveDates(info),
  });
  cal.render();

  async function saveDates(info) {
    const t = info.event.extendedProps.task;
    const start = info.event.startStr.slice(0, 10);
    const due = info.event.end ? addDay(info.event.endStr.slice(0, 10), -1) : start;
    try {
      await api(`/api/tasks/${t.id}`, { method: "PATCH", body: JSON.stringify({ start_date: start, due_date: due }) });
      flashSaved(`「${t.title}」を ${fmtDate(start)}〜${fmtDate(due)} に変更しました`);
    } catch (err) {
      alert(err.message);
      info.revert();
    }
  }
}

$app.addEventListener("change", (e) => {
  if (e.target.id === "calWho") { calState.who = e.target.value; route(); }
  if (e.target.id === "calDone") { calState.showDone = e.target.checked; route(); }
});

// ---- 議事録 ----
const fmtDT = (s) => (s ? s.replace(/-/g, "/") : "");
const weekday = (d) => "日月火水木金土"[new Date(d.slice(0, 10) + "T00:00:00").getDay()];

async function minutesTab(id) {
  const list = await api(`/api/projects/${id}/meetings`);
  const create = me.isRecorder ? `<p class="row"><a class="btn rec" href="#/p/${id}/record" style="text-decoration:none">🎙 録音する</a>
    <a class="btn" href="#/p/${id}/minutes/new" style="text-decoration:none">＋ 議事録を作る</a></p>` : "";
  if (!list.length) return create + `<div class="card soon">まだ議事録がありません。</div>`;
  const href = (m) => (m.status === "draft" ? `#/p/${id}/minutes/edit/${m.id}` : `#/p/${id}/minutes/${m.id}`);
  const rows = list.map((m) => `<tr class="clickrow" data-href="${href(m)}">
      <td style="width:170px">${fmtDate(m.held_at)}（${weekday(m.held_at)}）</td>
      <td><a href="${href(m)}">${esc(m.title)}</a>${m.status === "draft" ? `<span class="tag">下書き</span>` : ""}</td>
      <td style="width:90px">${m.attendees}名</td><td style="width:110px">決定 ${m.decisions}件</td><td style="width:110px">タスク ${m.tasks}件</td></tr>`).join("");
  return create + `<table><tr><th>日付</th><th>会議名</th><th>出席</th><th>決定事項</th><th>タスク</th></tr>${rows}</table>`;
}

const lines = (text) => String(text || "").split("\n").map((x) => x.trim()).filter(Boolean);
const ul = (items, empty = "なし") => (items.length ? `<ul>${items.map((x) => `<li>${x}</li>`).join("")}</ul>` : `<p class="muted">${empty}</p>`);

async function renderMinutesDoc(projectId, meetingId) {
  const d = await api(`/api/meetings/${meetingId}`);
  const m = d.meeting;
  const att = d.attendance.filter((a) => a.status);
  const names = (st) => att.filter((a) => a.status === st).map((a) => esc(a.name)).join("、");
  const present = att.filter((a) => a.status !== "absent");
  const day = m.held_at.slice(0, 10);
  document.title = `minutes_${day.replaceAll("-", "")}`; // PDF保存時のファイル名(英数字のみ)

  const attRows = att.map((a) => `<tr><td>${esc(a.name)}</td><td>${ATT[a.status]}</td><td>${esc(a.role)}</td><td>${esc(a.note)}</td></tr>`).join("");
  const taskRows = d.tasks.map((t) => `<tr><td>${esc(t.assignee || "未定")}</td><td>${esc(t.title)}</td>
      <td>${t.due_date ? fmtDate(t.due_date) : "未定"}</td><td>${STATUS[t.status]}</td></tr>`).join("");
  const qas = d.qas.map((x) => `<div class="qa ${x.answer ? "" : "open"}"><div class="q">Q. ${esc(x.question)}${x.asked_by ? `（${esc(x.asked_by)}）` : ""}</div>
      <div class="a">${x.answer ? esc(x.answer) : "未回答"}</div></div>`).join("");

  $app.innerHTML = `
    <div class="noprint docbar">
      <a href="#/p/${projectId}/minutes">← 議事録一覧</a>
      <span class="row">
        ${me.isRecorder ? `<a class="btn sub" href="#/p/${projectId}/minutes/fix/${meetingId}" style="text-decoration:none">✏️ 修正</a>
          <button class="btn danger" id="delMinutes">🗑 削除</button>` : ""}
        <button class="btn" id="printBtn">📄 PDFで保存</button>
      </span>
    </div>
    <article class="paper">
      <h1 class="doc-title">${esc(m.title)} 議事録</h1>
      <table class="info">
        <tr><td>会議名</td><td>${esc(m.title)}</td></tr>
        <tr><td>日時</td><td>${fmtDT(m.held_at)}（${weekday(m.held_at)}）${m.ended_at ? "〜" + esc(m.ended_at.slice(11)) : ""}</td></tr>
        <tr><td>場所</td><td>${esc(m.place)}</td></tr>
        <tr><td>進行</td><td>${esc(m.facilitator)}</td></tr>
        <tr><td>参加者</td><td>出席 ${present.length}名：${names("present")}${names("listen") ? `<br>聞き専：${names("listen")}` : ""}${names("absent") ? `<br>欠席：${names("absent")}` : ""}</td></tr>
        <tr><td>記録</td><td>${esc(m.created_by)}</td></tr>
      </table>
      ${m.summary ? `<div class="box sum"><b>要旨</b>${ul(lines(m.summary).map(esc))}</div>` : ""}

      <h2>■ 今回の議題</h2>${ul(lines(m.agenda).map(esc))}
      <h2>■ 決定事項</h2>${ul(d.decisions.map((x) => esc(x.content)))}
      <h2>■ 確認事項</h2>${ul(lines(m.confirmations).map(esc))}
      <h2>■ 担当タスク</h2>
      ${d.tasks.length ? `<table><tr><th style="width:110px">担当者</th><th>内容</th><th style="width:110px">期限</th><th style="width:80px">状態</th></tr>${taskRows}</table>` : `<p class="muted">なし</p>`}
      <h2>■ 未解決事項</h2>${ul(d.issues.map((x) => esc(x.content) + (x.status === "resolved" ? "（解決済み）" : "")))}
      <h2>■ 次回までにやること</h2>${ul(lines(m.next_actions).map(esc))}
      <h2>■ プロジェクト進捗</h2><p class="pre">${esc(m.progress_note) || "―"}</p>
      <h2>■ 次回会議で確認すること</h2>${ul(lines(m.next_checks).map(esc))}

      <h2 class="pb">出欠</h2>
      <table><tr><th style="width:120px">名前</th><th style="width:130px">出欠</th><th>役割</th><th style="width:150px">備考</th></tr>${attRows}</table>
      ${m.body_html ? `<div class="detail">${m.body_html}</div>` : ""}
      ${qas ? `<h2>質疑応答</h2>${qas}` : ""}
      <div class="foot">記録：${esc(m.created_by)}　／　メンバー限定資料のため外部への共有はご遠慮ください。</div>
    </article>`;
  document.getElementById("printBtn").onclick = () => window.print();
  const del = document.getElementById("delMinutes");
  if (del) del.onclick = async () => {
    if (!confirm(`「${m.title}」（${fmtDate(m.held_at)}）の議事録を削除しますか？\n出欠・決定事項・Q&A・課題も一緒に削除されます。`)) return;
    const n = d.tasks.length;
    const delTasks = n ? confirm(`この会議で決まったタスク ${n}件 も削除しますか？\n\n「OK」→ タスクも削除\n「キャンセル」→ タスクは残す`) : false;
    try {
      await api(`/api/meetings/${meetingId}?tasks=${delTasks ? "delete" : "keep"}`, { method: "DELETE" });
      location.hash = `#/p/${projectId}/minutes`;
    } catch (err) { alert(err.message); }
  };
}

$app.addEventListener("click", (e) => {
  const tr = e.target.closest("tr.clickrow");
  if (tr && !e.target.closest("a")) location.hash = tr.dataset.href;
});

let currentProjectId = null;

async function renderProject(id, tab) {
  currentProjectId = id;
  const d = await api(`/api/projects/${id}`);
  const s = d.stats;
  const tabs = TABS.map(([k, label]) => `<a href="#/p/${id}/${k}" class="${k === tab ? "on" : ""}">${label}</a>`).join("");
  let body = "";
  if (tab === "summary") body = summaryTab(d);
  else if (tab === "members" || tab === "sources") body = `<div id="tabbox"><p class="muted">読み込み中…</p></div>`;
  else if (tab === "tasks") body = await tasksTab(id);
  else if (tab === "calendar") body = calendarTab();
  else if (tab === "minutes") body = await minutesTab(id);
  else body = `<div class="card soon">この画面はこれから作ります（段階${{ calendar: 3, tasks: 2, minutes: 4 }[tab]}）。</div>`;
  $app.innerHTML = `
    <div class="projhead" id="projhead">
      <h1>${esc(d.project.name)}</h1>
      <div class="period">期間：${fmtDate(d.project.start_date)} 〜 ${fmtDate(d.project.end_date)}</div>
      <div class="progress"><b>${s.progress}%</b><div class="bar"><i style="width:${s.progress}%"></i></div>
        <span class="pill">未完了 ${s.open}件</span><span class="pill ${s.overdue ? "warn" : ""}">期限超過 ${s.overdue}件</span></div>
      <nav class="tabs">${tabs}</nav>
    </div>
    <section>${body}</section>`;
  setHeadHeight();
  if (tab === "calendar") await mountCalendar(id, d);
  if (tab === "members") await mountMembers(document.getElementById("tabbox"), me);
  if (tab === "sources") await mountSources(document.getElementById("tabbox"), id, me);
}

// ---- 上の見出し(プロジェクト名・進捗・タブ)はスクロールしても固定。その高さを、ほかの固定部分のずらし幅に使う ----
function setHeadHeight() {
  const h = document.getElementById("projhead")?.offsetHeight || 0;
  document.documentElement.style.setProperty("--headh", `${h}px`);
}
window.addEventListener("resize", setHeadHeight);

// ---- 検討事項の解決／戻す ----
$app.addEventListener("click", async (e) => {
  const id = e.target.dataset.resolve || e.target.dataset.reopen;
  if (!id) return;
  try {
    await api(`/api/issues/${id}`, { method: "PATCH", body: JSON.stringify({ status: e.target.dataset.resolve ? "resolved" : "open" }) });
    route();
  } catch (err) { alert(err.message); }
});

// ---- タスクの削除 ----
$app.addEventListener("click", async (e) => {
  const del = e.target.dataset.del;
  if (del) {
    const title = e.target.closest("tr").querySelector('[data-f="title"]').value;
    if (!confirm(`「${title}」を削除しますか？`)) return;
    await api(`/api/tasks/${del}`, { method: "DELETE" });
    return route();
  }
});

// ---- ページ切り替え ----
async function route() {
  try {
    $app.onclick = null; // 議事録作成画面のボタン操作を解除
    const [, page, id, tab, sub, sub2] = location.hash.split("/");
    // 招待リンク(ログインしていなくても開ける)
    if (page === "invite" && id) { document.title = "招待"; return renderInvite($app, id); }
    if (!me) {
      try { me = await api("/api/me"); }
      catch (err) {
        if (err.status !== 401) throw err;
        const { needsSetup } = await api("/api/auth/state");
        document.title = needsSetup ? "はじめての設定" : "ログイン";
        return needsSetup ? renderSetup($app) : renderLogin($app);
      }
      Object.assign(APP, me.app);
      document.querySelector(".brand").textContent = APP.name;
      document.getElementById("who").innerHTML = `${esc(me.name)}${me.isRecorder ? "（記録係）" : ""}
        <a href="#/settings" class="small">設定</a> <a href="#" id="logout" class="small">ログアウト</a>`;
      document.getElementById("logout").onclick = async (e) => {
        e.preventDefault();
        await api("/api/auth/logout", { method: "POST" });
        location.hash = "#/"; location.reload();
      };
    }
    document.title = APP.name;
    if (page === "settings") await renderSettings($app, me, PROJECT_ID);
    else if (page === "p" && id && tab === "record") renderRecorder($app, Number(id));
    else if (page === "p" && id && tab === "minutes" && sub === "new") await renderMinutesEditor($app, Number(id), null, me);
    else if (page === "p" && id && tab === "minutes" && sub === "edit") await renderMinutesEditor($app, Number(id), Number(sub2), me);
    else if (page === "p" && id && tab === "minutes" && sub === "fix") await renderMinutesEditor($app, Number(id), Number(sub2), me, true);
    else if (page === "p" && id && tab === "minutes" && sub) await renderMinutesDoc(Number(id), Number(sub));
    else if (page === "p" && id && tab === "sources" && sub) await renderSourceDetail($app, Number(id), Number(sub), me);
    else if (page === "p" && id && tab === "tasks" && sub) {
      // タスクへのリンク: 絞り込みを外して、その行まで移動して目立たせる
      Object.assign(taskFilter, { scope: "all", who: "all", overdueOnly: false });
      await renderProject(Number(id), "tasks");
      const row = document.querySelector(`tr[data-task="${Number(sub)}"]`);
      if (row) { row.scrollIntoView({ behavior: "smooth", block: "center" }); row.classList.add("focus"); }
    }
    else if (page === "p" && id) await renderProject(Number(id), tab || "summary");
    else await renderProject(PROJECT_ID, "summary");
  } catch (err) {
    $app.innerHTML = `<div class="notice">エラー：${esc(err.message)}</div>`;
  }
}
window.addEventListener("hashchange", route);
route();
